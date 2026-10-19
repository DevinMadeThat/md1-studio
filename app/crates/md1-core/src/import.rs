//! Copy every file on the disc, byte-exact, into a disc folder, then derive viewable files.
//!
//! Disc folder layout (same as `md1tool/md1.py mirror`, so old backups open directly):
//! ```text
//! <disc>/disc/...            byte-exact mirror of the camera's filesystem
//! <disc>/listing.txt         path \t DIR|size \t attr=xxxx \t 16 entry bytes (times, number)
//! <disc>/jpeg/<album>_PSNnnnnn.jpg
//! <disc>/audio/<album>_NRAnnnnn.wav
//! <disc>/thumbnails/<album>_PIDXnnn/nnnn.jpg
//! <disc>/disc.json           app metadata (name, camera, volume, import history)
//! <disc>/history/<time>/...  older copies of files that changed on the camera since last import
//! ```
//! Nothing in a disc folder is ever deleted by an import.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::camera::{Camera, DirEntry, VolumeInfo};
use crate::dostime::now_utc_iso;
use crate::formats;
use crate::frame::hex;
use crate::Error;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImportEvent {
    Volume { label: String, free_bytes: u64, total_bytes: u64 },
    Listing { folders: usize, files: usize, bytes: u64, to_copy: usize, bytes_to_copy: u64 },
    File { index: usize, count: usize, path: String, size: u32 },
    Progress { file_bytes: usize, file_size: u32, done_bytes: u64, total_bytes: u64, rate: f64 },
    Retry { path: String, error: String },
    Converting,
    Done { copied: usize, skipped: usize, failed: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct DiscMeta {
    pub name: String,
    #[serde(default)]
    pub camera_id: String,
    #[serde(default)]
    pub volume_label: String,
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default)]
    pub formatted: String,
    #[serde(default)]
    pub imports: Vec<String>,
}

impl DiscMeta {
    pub fn load(disc_dir: &Path) -> Option<Self> {
        serde_json::from_slice(&fs::read(disc_dir.join("disc.json")).ok()?).ok()
    }

    pub fn save(&self, disc_dir: &Path) -> std::io::Result<()> {
        save_atomic(&disc_dir.join("disc.json"), &serde_json::to_vec_pretty(self).unwrap())
    }
}

/// Every file and folder on the disc, depth first. The camera keeps one find cursor, so each
/// folder is read completely before descending. Entry numbers already seen are skipped so a
/// confused reply can never send the walk round in circles; depth is capped at 8.
pub fn walk(cam: &mut Camera) -> Result<Vec<(String, DirEntry)>, Error> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    walk_into(cam, "/", &mut seen, 0, &mut out)?;
    Ok(out)
}

fn walk_into(
    cam: &mut Camera,
    path: &str,
    seen: &mut HashSet<u32>,
    depth: usize,
    out: &mut Vec<(String, DirEntry)>,
) -> Result<(), Error> {
    let entries = cam.list_dir(path)?;
    if let Some(me) = entries.first().filter(|e| e.name.is_empty()) {
        seen.insert(me.number);
    }
    let children: Vec<DirEntry> = entries.into_iter().filter(|e| !e.name.is_empty()).collect();
    let base = path.trim_end_matches('/');
    for e in &children {
        out.push((format!("{base}/{}", e.name), e.clone()));
    }
    if depth >= 8 {
        return Ok(());
    }
    for e in children {
        if e.is_dir && seen.insert(e.number) {
            walk_into(cam, &format!("{base}/{}", e.name), seen, depth + 1, out)?;
        }
    }
    Ok(())
}

fn listing_line(path: &str, e: &DirEntry) -> String {
    let kind = if e.is_dir { "DIR".to_string() } else { e.size.to_string() };
    format!("{path}\t{kind}\tattr={:04x}\t{}\n", e.attr, hex(&e.rest))
}

pub fn save_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!(
        "{}.part",
        path.extension().map(|e| e.to_string_lossy().to_string()).unwrap_or_default()
    ));
    fs::write(&tmp, data)?;
    fs::rename(&tmp, path)
}

/// Write `data` to `dest`; if a different file is already there, move it to history first.
fn store(disc_dir: &Path, rel: &str, data: &[u8], stamp: &str) -> std::io::Result<()> {
    let dest = disc_dir.join("disc").join(rel.trim_start_matches('/'));
    if let Ok(old) = fs::read(&dest) {
        if old == data {
            return Ok(());
        }
        let keep = disc_dir.join("history").join(stamp).join(rel.trim_start_matches('/'));
        fs::create_dir_all(keep.parent().unwrap())?;
        fs::rename(&dest, &keep)?;
    }
    save_atomic(&dest, data)
}

pub struct ImportOptions {
    pub disc_dir: PathBuf,
    pub name: String,
}

/// Copy the whole disc. Photos and sound files never change on the camera, so ones already in
/// the folder with the right size are skipped; index files are always re-read.
pub fn import_disc(
    cam: &mut Camera,
    opts: &ImportOptions,
    on_event: &mut dyn FnMut(ImportEvent) -> Result<(), Error>,
) -> Result<DiscMeta, Error> {
    let disc_dir = &opts.disc_dir;
    fs::create_dir_all(disc_dir)?;
    let stamp = now_utc_iso().replace([':', '.'], "-");

    let vol: Option<VolumeInfo> = cam.volume_info().ok();
    if let Some(v) = &vol {
        on_event(ImportEvent::Volume { label: v.label.clone(), free_bytes: v.free_bytes, total_bytes: v.total_bytes })?;
    }

    let tree = walk(cam)?;
    let mut listing = String::new();
    for (p, e) in &tree {
        listing.push_str(&listing_line(p, e));
    }
    let files: Vec<&(String, DirEntry)> = tree.iter().filter(|(_, e)| !e.is_dir).collect();
    let immutable = |p: &str| {
        let n = p.rsplit('/').next().unwrap_or("");
        n.starts_with("PSN") || n.starts_with("NRA")
    };
    let have = |p: &str, size: u32| {
        fs::metadata(disc_dir.join("disc").join(p.trim_start_matches('/')))
            .map(|m| m.len() == size as u64)
            .unwrap_or(false)
    };
    let todo: Vec<&(String, DirEntry)> =
        files.iter().copied().filter(|(p, e)| !(immutable(p) && have(p, e.size))).collect();
    let total: u64 = todo.iter().map(|(_, e)| e.size as u64).sum();
    on_event(ImportEvent::Listing {
        folders: tree.len() - files.len(),
        files: files.len(),
        bytes: files.iter().map(|(_, e)| e.size as u64).sum(),
        to_copy: todo.len(),
        bytes_to_copy: total,
    })?;

    // Folders (including empty ones) exist locally even before their files arrive.
    for (p, e) in &tree {
        if e.is_dir {
            fs::create_dir_all(disc_dir.join("disc").join(p.trim_start_matches('/')))?;
        }
    }

    let t0 = Instant::now();
    let mut done: u64 = 0;
    let mut failed = Vec::new();
    for (i, (path, e)) in todo.iter().enumerate() {
        on_event(ImportEvent::File { index: i + 1, count: todo.len(), path: path.clone(), size: e.size })?;
        let mut result = Err(Error::Timeout);
        for attempt in 0..3 {
            let base = done;
            let mut cb = |n: usize| {
                let d = base + n as u64;
                on_event(ImportEvent::Progress {
                    file_bytes: n,
                    file_size: e.size,
                    done_bytes: d,
                    total_bytes: total,
                    rate: d as f64 / t0.elapsed().as_secs_f64().max(0.001),
                })
            };
            result = cam.read_file(path, &mut cb);
            match &result {
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(err) if attempt < 2 => {
                    on_event(ImportEvent::Retry { path: path.clone(), error: err.to_string() })?;
                    cam.abort();
                }
                _ => break,
            }
        }
        match result {
            Ok(data) => {
                store(disc_dir, path, &data, &stamp)?;
                done += e.size as u64;
            }
            Err(_) => failed.push(path.clone()),
        }
    }

    // listing.txt is the newest view of the disc; keep the old one if it differs.
    store_plain(disc_dir, "listing.txt", listing.as_bytes(), &stamp)?;

    on_event(ImportEvent::Converting)?;
    convert_disc(disc_dir)?;
    write_manifest(disc_dir)?;

    let mut meta = DiscMeta::load(disc_dir).unwrap_or_default();
    if meta.name.is_empty() || !opts.name.is_empty() {
        meta.name = opts.name.clone();
    }
    meta.camera_id = cam.camera_id.clone();
    if let Some(v) = &vol {
        meta.volume_label = v.label.clone();
        meta.fingerprint = v.fingerprint();
        meta.formatted = v.created.iso();
    }
    meta.imports.push(now_utc_iso());
    meta.save(disc_dir)?;

    on_event(ImportEvent::Done {
        copied: todo.len() - failed.len(),
        skipped: files.len() - todo.len(),
        failed: failed.clone(),
    })?;
    if failed.is_empty() {
        Ok(meta)
    } else {
        Err(Error::Protocol(format!("{} file(s) could not be read: {}", failed.len(), failed.join(", "))))
    }
}

fn store_plain(disc_dir: &Path, name: &str, data: &[u8], stamp: &str) -> std::io::Result<()> {
    let dest = disc_dir.join(name);
    if let Ok(old) = fs::read(&dest) {
        if old == data {
            return Ok(());
        }
        let keep = disc_dir.join("history").join(stamp);
        fs::create_dir_all(&keep)?;
        fs::rename(&dest, keep.join(name))?;
    }
    save_atomic(&dest, data)
}

/// SHA-256 of every mirrored file, like md1tool's disc-manifest.txt.
fn write_manifest(disc_dir: &Path) -> std::io::Result<()> {
    let root = disc_dir.join("disc");
    let mut lines = Vec::new();
    for f in files_under(&root) {
        let data = fs::read(&f)?;
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        lines.push(format!("{}  {:>8}  /{rel}", hex_digest(&data), data.len()));
    }
    lines.sort_by(|a, b| a[76..].cmp(&b[76..]));
    save_atomic(&disc_dir.join("disc-manifest.txt"), (lines.join("\n") + "\n").as_bytes())
}

fn hex_digest(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if !p.to_string_lossy().ends_with(".part") {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// Root holding the album folders: `disc/PIC_MD` (mirror) or `raw` (md1.py `pull` layout).
pub fn albums_root(disc_dir: &Path) -> Option<PathBuf> {
    [disc_dir.join("disc").join("PIC_MD"), disc_dir.join("raw")].into_iter().find(|p| p.is_dir())
}

pub fn jpeg_path(disc_dir: &Path, album: &str, stem: &str) -> PathBuf {
    disc_dir.join("jpeg").join(format!("{album}_{stem}.jpg"))
}

pub fn wav_path(disc_dir: &Path, album: &str, stem: &str) -> PathBuf {
    disc_dir.join("audio").join(format!("{album}_{stem}.wav"))
}

/// Make the viewable copies: JPEG from each photo, WAV from each sound file, thumbnails.
/// Existing outputs are kept (they are derived, and may have been made by md1tool).
pub fn convert_disc(disc_dir: &Path) -> Result<(usize, usize), Error> {
    let Some(root) = albums_root(disc_dir) else { return Ok((0, 0)) };
    let (mut photos, mut sounds) = (0, 0);
    for f in files_under(&root) {
        let name = f.file_name().unwrap().to_string_lossy().to_string();
        let album = f.parent().and_then(|p| p.file_name()).unwrap().to_string_lossy().to_string();
        let Some((stem, ext)) = name.rsplit_once('.') else { continue };
        match ext {
            "PMP" if stem.starts_with("PSN") => {
                let out = jpeg_path(disc_dir, &album, stem);
                if !out.exists() {
                    let data = fs::read(&f)?;
                    if let Some(j) = formats::extract_jpeg(&data) {
                        save_atomic(&out, j)?;
                    }
                }
                photos += 1;
            }
            "PMA" => {
                let out = wav_path(disc_dir, &album, stem);
                if !out.exists() {
                    let samples = formats::decode_pma(&fs::read(&f)?);
                    save_atomic(&out, &formats::wav_bytes(&samples, atrac1::SAMPLE_RATE))?;
                }
                sounds += 1;
            }
            "PMX" => {
                // Re-extracted every time: the file grows when photos are added.
                let dir = disc_dir.join("thumbnails").join(format!("{album}_{stem}"));
                for (k, j) in formats::all_jpegs(&fs::read(&f)?).into_iter().enumerate() {
                    let out = dir.join(format!("{k:04}.jpg"));
                    if fs::read(&out).map(|old| old != j).unwrap_or(true) {
                        save_atomic(&out, j)?;
                    }
                }
            }
            _ => {}
        }
    }
    Ok((photos, sounds))
}
