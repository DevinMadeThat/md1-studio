//! See what's on the disc in the camera without downloading the photos: the directory listing,
//! the album indexes and the camera's own thumbnails (80 × 60, about 4 KB each, so a whole disc
//! of thumbnails takes seconds instead of the ~10 s per photo a full copy needs).
//!
//! Index and thumbnail files are cached by path, size and directory-entry times, so browsing the
//! same disc again only re-reads files that changed.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::camera::{Camera, DirEntry, VolumeInfo};
use crate::dostime::DosTime;
use crate::formats;
use crate::frame::hex;
use crate::import::{save_atomic, walk};
use crate::Error;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraPhoto {
    /// "<album>/<PSNnnnnn>", like library photo ids.
    pub id: String,
    pub album: String,
    pub number: u16,
    pub stem: String,
    /// Position in the camera's album (what the camera shows as the picture number − 1).
    pub position: usize,
    /// "/PIC_MD/PIC00001/PSN00018.PMP"
    pub path: String,
    pub size: u32,
    pub created: Option<String>,
    pub clock_unset: bool,
    pub sound_path: Option<String>,
    pub sound_size: Option<u32>,
    pub sound_seconds: Option<f64>,
    pub protected: bool,
    /// How the camera shows the photo turned, in quarter turns clockwise (album index).
    pub rotation: u8,
    /// Listed in the album index (the camera shows only indexed photos).
    pub in_index: bool,
    /// "FINE" / "STD", guessed from the file size (the camera budgets 64 KB / 128 KB).
    pub quality: &'static str,
    /// The camera's thumbnail as a `data:image/jpeg;base64,…` URL.
    pub thumb: Option<String>,
    /// SHA-256 of the thumbnail JPEG (matches the library's copy of the same photo).
    #[serde(skip)]
    pub thumb_hash: Option<String>,
}

/// The disc in the camera, as far as browsing it has read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CameraDisc {
    pub fingerprint: String,
    pub label: String,
    /// "diary" (standard quality only, space kept for sound) or "free" (fine allowed), from
    /// `OV_INF.PMF` bytes 0x102–0x103 (1 / 2; inferred from a diary disc and a free one).
    pub album_mode: Option<&'static str>,
    pub photos: Vec<CameraPhoto>,
    /// Every file and folder on the disc (for a later download).
    #[serde(skip)]
    pub tree: Vec<(String, DirEntry)>,
    /// Index and thumbnail files already read, by camera path.
    #[serde(skip)]
    pub files: HashMap<String, Vec<u8>>,
    #[serde(skip)]
    pub volume: Option<VolumeInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BrowseEvent {
    Listing { files: usize },
    Reading { path: String, done: u64, total: u64 },
}

/// Album index and thumbnail files: everything browsing reads.
pub fn is_index_file(path: &str) -> bool {
    path.starts_with("/PIC_MD/") && (path.ends_with(".PMF") || path.ends_with(".PMX"))
}

fn cache_key(e: &DirEntry) -> String {
    format!("{}\t{}", e.size, hex(&e.rest))
}

fn cache_path(dir: &Path, path: &str) -> PathBuf {
    dir.join(path.trim_start_matches('/'))
}

fn cached(dir: Option<&Path>, path: &str, e: &DirEntry) -> Option<Vec<u8>> {
    let p = cache_path(dir?, path);
    let key = fs::read_to_string(p.with_extension("entry")).ok()?;
    let data = fs::read(&p).ok()?;
    (key == cache_key(e) && data.len() == e.size as usize).then_some(data)
}

fn remember(dir: Option<&Path>, path: &str, e: &DirEntry, data: &[u8]) {
    if let Some(dir) = dir {
        let p = cache_path(dir, path);
        let _ = save_atomic(&p, data);
        let _ = save_atomic(&p.with_extension("entry"), cache_key(e).as_bytes());
    }
}

pub fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= c.len() { T[(n >> shift & 63) as usize] as char } else { '=' });
        }
    }
    out
}

/// Inverse of [`base64`]; ignores anything outside the alphabet (e.g. a `data:` URL prefix must
/// be stripped first).
pub fn base64_decode(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => Some(c - b'A'),
        b'a'..=b'z' => Some(c - b'a' + 26),
        b'0'..=b'9' => Some(c - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    };
    let (mut out, mut acc, mut bits) = (Vec::with_capacity(s.len() * 3 / 4), 0u32, 0);
    for v in s.bytes().filter_map(val) {
        acc = acc << 6 | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

/// Read the listing, album indexes and thumbnails. `cache_dir` (per disc) avoids re-reading
/// unchanged files.
pub fn browse(
    cam: &mut Camera,
    cache_dir: Option<&Path>,
    on_event: &mut dyn FnMut(BrowseEvent) -> Result<(), Error>,
) -> Result<CameraDisc, Error> {
    let volume = cam.volume_info().ok();
    let tree = walk(cam)?;
    on_event(BrowseEvent::Listing { files: tree.iter().filter(|(_, e)| !e.is_dir).count() })?;

    let wanted: Vec<&(String, DirEntry)> = tree.iter().filter(|(p, e)| !e.is_dir && is_index_file(p)).collect();
    let total: u64 = wanted.iter().map(|(_, e)| e.size as u64).sum();
    let mut done = 0u64;
    let mut files = HashMap::new();
    for (path, e) in wanted {
        let data = match cached(cache_dir, path, e) {
            Some(d) => d,
            None => {
                let base = done;
                let d = cam.read_file(path, &mut |n| {
                    on_event(BrowseEvent::Reading { path: path.clone(), done: base + n as u64, total })
                })?;
                remember(cache_dir, path, e, &d);
                d
            }
        };
        done += e.size as u64;
        on_event(BrowseEvent::Reading { path: path.clone(), done, total })?;
        files.insert(path.clone(), data);
    }

    let photos = photos_from(&tree, &files);
    let album_mode = files.get("/PIC_MD/OV_INF.PMF").and_then(|d| d.get(0x102..0x104)).and_then(|b| match b {
        [0, 1] => Some("diary"),
        [0, 2] => Some("free"),
        _ => None,
    });
    Ok(CameraDisc {
        album_mode,
        fingerprint: volume.as_ref().map(|v| v.fingerprint()).unwrap_or_default(),
        label: volume.as_ref().map(|v| v.label.clone()).unwrap_or_default(),
        photos,
        tree,
        files,
        volume,
    })
}

/// Photos in camera order: each album's indexed pictures, then any photo files the index
/// doesn't list. Thumbnail k of an album (its PIDX files in name order) belongs to record k.
pub fn photos_from(tree: &[(String, DirEntry)], files: &HashMap<String, Vec<u8>>) -> Vec<CameraPhoto> {
    let entry = |p: &str| tree.iter().find(|(q, _)| q == p).map(|(_, e)| e);
    let mut albums: Vec<&str> = tree
        .iter()
        .filter(|(p, e)| e.is_dir && p.starts_with("/PIC_MD/PIC") && p.matches('/').count() == 2)
        .map(|(p, _)| &p[8..])
        .collect();
    albums.sort();

    let mut out = Vec::new();
    for album in albums {
        let dir = format!("/PIC_MD/{album}/");
        let index = files.get(&format!("{dir}PIC_INF.PMF")).and_then(|d| formats::parse_pic_inf(d));
        let mut pidx: Vec<&String> =
            files.keys().filter(|p| p.starts_with(&dir) && p[dir.len()..].starts_with("PIDX")).collect();
        pidx.sort();
        let thumbs: Vec<Option<&[u8]>> = pidx.iter().flat_map(|p| formats::pmx_thumbnails(&files[*p])).collect();

        let mut numbers: Vec<(u16, bool, bool, u8)> = Vec::new(); // number, indexed, protected, rotation
        if let Some(ix) = &index {
            numbers.extend(ix.records.iter().map(|r| (r.number, true, r.protected, r.rotation_cw())));
        }
        let mut extra: Vec<u16> = tree
            .iter()
            .filter_map(|(p, _)| p.strip_prefix(&dir)?.strip_prefix("PSN")?.strip_suffix(".PMP")?.parse().ok())
            .filter(|n| !numbers.iter().any(|(m, ..)| m == n))
            .collect();
        extra.sort();
        numbers.extend(extra.into_iter().map(|n| (n, false, false, 0)));

        for (position, (n, indexed, protected, rotation)) in numbers.into_iter().enumerate() {
            let stem = format!("PSN{n:05}");
            let path = format!("{dir}{stem}.PMP");
            let Some(e) = entry(&path) else { continue };
            let sound_path = format!("{dir}NRA{n:05}.PMA");
            let sound = entry(&sound_path);
            let created = DosTime::from_u32(e.created);
            let thumb = if indexed { thumbs.get(position).copied().flatten() } else { None };
            out.push(CameraPhoto {
                id: format!("{album}/{stem}"),
                album: album.to_string(),
                number: n,
                stem,
                position,
                path,
                size: e.size,
                created: Some(created.iso()),
                clock_unset: created.clock_unset(),
                sound_path: sound.map(|_| sound_path),
                sound_size: sound.map(|s| s.size),
                sound_seconds: sound.map(|s| formats::pma_seconds(s.size as u64)),
                protected,
                rotation,
                in_index: indexed,
                quality: if e.size > 66_000 { "FINE" } else { "STD" },
                thumb: thumb.map(|j| format!("data:image/jpeg;base64,{}", base64(j))),
                thumb_hash: thumb.map(sha256_hex),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        for t in [&b""[..], b"f", b"fo", b"foo", b"\x00\xff\x10hello"] {
            assert_eq!(base64_decode(&base64(t)), t);
        }
    }

    #[test]
    fn pmx_blocks_by_position() {
        let mut pmx = vec![0u8; 3 * formats::PMX_BLOCK];
        for (k, jpeg) in [(0usize, &[0xFF, 0xD8, 1, 0xFF, 0xD9][..]), (2, &[0xFF, 0xD8, 2, 0xFF, 0xD9][..])] {
            let b = k * formats::PMX_BLOCK;
            pmx[b + 0x0C..b + 0x10].copy_from_slice(&(jpeg.len() as u32).to_be_bytes());
            pmx[b + 0x100..b + 0x100 + jpeg.len()].copy_from_slice(jpeg);
        }
        let t = formats::pmx_thumbnails(&pmx);
        assert_eq!(t.len(), 3);
        assert_eq!(t[0].unwrap()[2], 1);
        assert!(t[1].is_none());
        assert_eq!(t[2].unwrap()[2], 2);
    }
}
