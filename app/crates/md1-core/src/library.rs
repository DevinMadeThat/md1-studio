//! Read a disc folder (from an import, or an md1tool backup) into albums and photos.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use serde::Serialize;

use crate::browse::{sha256_hex, CameraDisc};
use crate::dostime::{iso_utc, DosTime};
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
    /// When the photo was copied off the camera (UTC ISO-8601): recorded per photo since the
    /// selective download; for older folders, the folder's first import or the file's time.
    pub imported_at: Option<String>,
    /// The camera's own 80 × 60 thumbnail, extracted from the album's PIDX file.
    pub thumb_path: Option<String>,
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
    /// Photos the disc listing shows that weren't downloaded (a partial copy).
    pub missing_photos: usize,
}

/// Creation time of each file from listing.txt, by camera path.
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

/// Thumbnail k of an album, as extracted by `import::convert_disc` (its PIDX files in name order).
fn album_thumbs(disc_dir: &Path, album: &str) -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<_> = fs::read_dir(disc_dir.join("thumbnails"))
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(&format!("{album}_PIDX"))))
        .collect();
    dirs.sort();
    dirs.iter().flat_map(|d| import::files_under(d)).collect()
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
    let first_import = meta.imports.first().cloned();
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
        let thumbs = album_thumbs(disc_dir, &album);

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
            let id = format!("{album}/{stem}");
            let imported_at = meta.photo_imports.get(&id).cloned().or_else(|| first_import.clone()).or_else(|| {
                fs::metadata(&pmp).and_then(|m| m.modified()).ok().map(iso_utc)
            });
            let thumb = (pos < indexed).then(|| thumbs.get(pos)).flatten();
            photos.push(Photo {
                edits: user_edits.get(&id).cloned().unwrap_or_default(),
                id,
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
                imported_at,
                thumb_path: thumb.map(|t| t.to_string_lossy().to_string()),
            });
        }
        albums.push(Album { name: album, photos });
    }

    let all = || albums.iter().flat_map(|a| a.photos.iter());
    let missing_photos = times
        .keys()
        .filter(|p| p.starts_with("/PIC_MD/") && p.rsplit('/').next().is_some_and(|n| n.starts_with("PSN") && n.ends_with(".PMP")))
        .filter(|p| !disc_dir.join("disc").join(p.trim_start_matches('/')).exists())
        .count();
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
        missing_photos,
        albums,
    })
}

/// A library photo that is the same picture as one on the camera.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryMatch {
    pub disc_path: String,
    pub photo_id: String,
}

/// For each photo on the camera, the library photo it already is, if any. Same file size, and
/// one of: same creation time, same thumbnail, or same album and photo number. A disc restored
/// from a backup gets new file times but keeps sizes, names and thumbnails, so it still matches.
pub fn match_camera(discs: &[Disc], cam: &CameraDisc) -> Vec<Option<LibraryMatch>> {
    let mut by_size: HashMap<u64, Vec<(&Disc, &Photo)>> = HashMap::new();
    for d in discs {
        for p in d.albums.iter().flat_map(|a| a.photos.iter()) {
            by_size.entry(p.file_bytes).or_default().push((d, p));
        }
    }
    let mut thumb_hashes: HashMap<String, Option<String>> = HashMap::new();
    let mut thumb_hash = |p: &Photo| -> Option<String> {
        let path = p.thumb_path.clone()?;
        thumb_hashes.entry(path.clone()).or_insert_with(|| fs::read(&path).ok().map(|b| sha256_hex(&b))).clone()
    };
    cam.photos
        .iter()
        .map(|c| {
            let candidates = by_size.get(&(c.size as u64))?;
            let hit = candidates.iter().find(|(_, p)| p.created.is_some() && p.created == c.created).or_else(|| {
                candidates.iter().find(|(_, p)| c.thumb_hash.is_some() && thumb_hash(p) == c.thumb_hash)
            }).or_else(|| candidates.iter().find(|(_, p)| p.id == c.id))?;
            Some(LibraryMatch { disc_path: hit.0.path.clone(), photo_id: hit.1.id.clone() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browse::CameraPhoto;

    fn photo(id: &str, size: u64, created: &str) -> Photo {
        let (album, stem) = id.split_once('/').unwrap();
        Photo {
            id: id.into(),
            album: album.into(),
            number: stem[3..].parse().unwrap(),
            stem: stem.into(),
            pmp_path: String::new(),
            jpeg_path: None,
            wav_path: None,
            sound_seconds: None,
            info: formats::photo_info(&[]),
            file_bytes: size,
            created: Some(created.into()),
            clock_unset: true,
            in_index: true,
            protected: false,
            edits: PhotoEdits::default(),
            imported_at: None,
            thumb_path: None,
        }
    }

    fn on_camera(id: &str, size: u32, created: &str) -> CameraPhoto {
        let (album, stem) = id.split_once('/').unwrap();
        CameraPhoto {
            id: id.into(),
            album: album.into(),
            number: stem[3..].parse().unwrap(),
            stem: stem.into(),
            position: 0,
            path: format!("/PIC_MD/{id}.PMP"),
            size,
            created: Some(created.into()),
            clock_unset: true,
            sound_path: None,
            sound_size: None,
            sound_seconds: None,
            protected: false,
            in_index: true,
            quality: "STD",
            thumb: None,
            thumb_hash: None,
        }
    }

    #[test]
    fn camera_photos_match_by_size_and_time_or_name() {
        let disc = Disc {
            path: "/lib/Disc 2".into(),
            name: "Disc 2".into(),
            camera_id: String::new(),
            volume_label: String::new(),
            formatted: String::new(),
            imports: vec![],
            kind: "mirror".into(),
            albums: vec![Album {
                name: "PIC00001".into(),
                photos: vec![
                    photo("PIC00001/PSN00000", 63796, "1980-01-01 00:05:54"),
                    photo("PIC00001/PSN00001", 64093, "1980-01-01 00:07:02"),
                ],
            }],
            photo_count: 2,
            sound_count: 0,
            fine_count: 0,
            missing_photos: 0,
        };
        let cam = CameraDisc {
            fingerprint: String::new(),
            label: String::new(),
            photos: vec![
                // Same size and time: the same photo.
                on_camera("PIC00001/PSN00000", 63796, "1980-01-01 00:05:54"),
                // Restored disc: new file time, same name and size.
                on_camera("PIC00001/PSN00001", 64093, "1980-01-01 03:00:00"),
                // Same name, different size: a different photo on another disc.
                on_camera("PIC00001/PSN00002", 61000, "1980-01-01 00:07:48"),
                // Same size by chance, different name and time.
                on_camera("PIC00001/PSN00003", 63796, "1980-01-01 00:09:00"),
            ],
            tree: vec![],
            files: HashMap::new(),
            volume: None,
        };
        let m: Vec<Option<String>> = match_camera(&[disc], &cam).into_iter().map(|m| m.map(|m| m.photo_id)).collect();
        assert_eq!(m, vec![Some("PIC00001/PSN00000".into()), Some("PIC00001/PSN00001".into()), None, None]);
    }
}
