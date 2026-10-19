//! Read a disc folder (from an import, or an md1tool backup) into albums and photos.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::dostime::DosTime;
use crate::edits::{self, PhotoEdits};
use crate::formats::{self, PhotoInfo};
use crate::import::{self, albums_root, DiscMeta};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Photo {
    /// "<album>/<PSNnnnnn>", unique within a disc.
    pub id: String,
    pub album: String,
    pub number: u16,
    /// "PSN00018"
    pub stem: String,
    pub pmp_path: String,
    pub jpeg_path: Option<String>,
    pub wav_path: Option<String>,
    pub sound_seconds: Option<f64>,
    pub info: PhotoInfo,
    pub file_bytes: u64,
    /// From the directory listing (DOS time). Only the time of day is meaningful when
    /// `clock_unset` (the camera's clock battery is dead → 1980-01-01).
    pub created: Option<String>,
    pub clock_unset: bool,
    /// Listed in the album index (PIC_INF.PMF). Files on the disc but not in the index are not
    /// shown by the camera.
    pub in_index: bool,
    pub protected: bool,
    /// The user's edits (location, date/time, rotation); the camera files are never changed.
    pub edits: PhotoEdits,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Album {
    pub name: String,
    pub photos: Vec<Photo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disc {
    pub path: String,
    pub name: String,
    pub camera_id: String,
    pub volume_label: String,
    pub formatted: String,
    pub imports: Vec<String>,
    /// "mirror" (full copy of the disc, with listing.txt) or "photos" (md1tool `pull`: photo files only).
    pub kind: String,
    pub albums: Vec<Album>,
    pub photo_count: usize,
    pub sound_count: usize,
    pub fine_count: usize,
}

/// Times of each file from listing.txt, by camera path.
fn listing_times(disc_dir: &Path) -> HashMap<String, u32> {
    let mut out = HashMap::new();
    let Ok(text) = fs::read_to_string(disc_dir.join("listing.txt")) else { return out };
    for line in text.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 4 {
            continue;
        }
        let bytes: Vec<u8> =
            parts[3].split_whitespace().filter_map(|h| u8::from_str_radix(h, 16).ok()).collect();
        if bytes.len() >= 4 {
            out.insert(parts[0].to_string(), u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]));
        }
    }
    out
}

pub fn is_disc_dir(dir: &Path) -> bool {
    albums_root(dir).is_some()
}

pub fn scan_disc(disc_dir: &Path) -> Option<Disc> {
    let root = albums_root(disc_dir)?;
    // A full copy has the directory listing; md1tool `pull` backups only have photo files.
    let mirror = disc_dir.join("listing.txt").exists();
    let meta = DiscMeta::load(disc_dir).unwrap_or_default();
    let times = listing_times(disc_dir);
    let user_edits = edits::load(disc_dir);
    // Make sure JPEG/WAV copies exist (older backups may predate sound decoding).
    let _ = import::convert_disc(disc_dir);

    let mut album_dirs: Vec<_> = fs::read_dir(&root)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("PIC")))
        .collect();
    album_dirs.sort();

    let mut albums = Vec::new();
    for dir in album_dirs {
        let album = dir.file_name().unwrap().to_string_lossy().to_string();
        let index = fs::read(dir.join("PIC_INF.PMF")).ok().and_then(|d| formats::parse_pic_inf(&d));
        let mut numbers: Vec<u16> = Vec::new();
        if let Some(ix) = &index {
            numbers.extend(ix.records.iter().map(|r| r.number));
        }
        // Photos on disc but not in the index, in number order after the indexed ones.
        let mut extra: Vec<u16> = fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n.strip_prefix("PSN")?.strip_suffix(".PMP")?.parse::<u16>().ok()
            })
            .filter(|n| !numbers.contains(n))
            .collect();
        extra.sort();
        let indexed = numbers.len();
        numbers.extend(extra);

        let mut photos = Vec::new();
        for (pos, n) in numbers.into_iter().enumerate() {
            let stem = format!("PSN{n:05}");
            let pmp = dir.join(format!("{stem}.PMP"));
            let Ok(data) = fs::read(&pmp) else { continue };
            let nra = dir.join(format!("NRA{n:05}.PMA"));
            let sound_seconds = fs::metadata(&nra).ok().map(|m| formats::pma_seconds(m.len()));
            let jpeg = import::jpeg_path(disc_dir, &album, &stem);
            let wav = import::wav_path(disc_dir, &album, &format!("NRA{n:05}"));
            let cam_path = format!("/PIC_MD/{album}/{stem}.PMP");
            let created = times.get(&cam_path).map(|&t| DosTime::from_u32(t));
            let record = index.as_ref().and_then(|ix| ix.records.iter().find(|r| r.number == n));
            photos.push(Photo {
                id: format!("{album}/{stem}"),
                album: album.clone(),
                number: n,
                stem: stem.clone(),
                pmp_path: pmp.to_string_lossy().to_string(),
                jpeg_path: jpeg.exists().then(|| jpeg.to_string_lossy().to_string()),
                wav_path: (sound_seconds.is_some() && wav.exists()).then(|| wav.to_string_lossy().to_string()),
                sound_seconds,
                info: formats::photo_info(&data),
                file_bytes: data.len() as u64,
                created: created.map(|t| t.iso()),
                clock_unset: created.is_some_and(|t| t.clock_unset()),
                in_index: pos < indexed,
                protected: record.is_some_and(|r| r.protected),
                edits: user_edits.get(&format!("{album}/{stem}")).cloned().unwrap_or_default(),
            });
        }
        albums.push(Album { name: album, photos });
    }

    let all = || albums.iter().flat_map(|a| a.photos.iter());
    let name = if meta.name.is_empty() {
        disc_dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
    } else {
        meta.name.clone()
    };
    Some(Disc {
        path: disc_dir.to_string_lossy().to_string(),
        name,
        camera_id: meta.camera_id.clone(),
        volume_label: meta.volume_label.clone(),
        formatted: meta.formatted.clone(),
        imports: meta.imports.clone(),
        kind: if mirror { "mirror" } else { "photos" }.into(),
        photo_count: all().count(),
        sound_count: all().filter(|p| p.sound_seconds.is_some()).count(),
        fine_count: all().filter(|p| p.info.quality == "FINE").count(),
        albums,
    })
}
