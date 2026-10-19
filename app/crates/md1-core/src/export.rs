//! Export photos as ordinary JPEGs (with EXIF: camera, shutter, flash, date when the camera
//! clock was set) plus the sound as a WAV of the same name.

use std::fs;
use std::path::{Path, PathBuf};

use crate::formats::PhotoInfo;
use crate::library::Photo;
use crate::Error;

enum Val {
    Ascii(String),
    Short(u16),
    Long(u32),
    Rational(u32, u32),
    Undefined(Vec<u8>),
}

/// Minimal big-endian TIFF/EXIF writer: IFD0 + Exif sub-IFD.
fn exif_app1(ifd0: Vec<(u16, Val)>, exif: Vec<(u16, Val)>) -> Vec<u8> {
    fn size(v: &Val) -> (u16, u32, usize) {
        // (type, count, byte length)
        match v {
            Val::Ascii(s) => (2, s.len() as u32 + 1, s.len() + 1),
            Val::Short(_) => (3, 1, 2),
            Val::Long(_) => (4, 1, 4),
            Val::Rational(..) => (5, 1, 8),
            Val::Undefined(b) => (7, b.len() as u32, b.len()),
        }
    }
    fn bytes(v: &Val) -> Vec<u8> {
        match v {
            Val::Ascii(s) => [s.as_bytes(), &[0]].concat(),
            Val::Short(x) => x.to_be_bytes().to_vec(),
            Val::Long(x) => x.to_be_bytes().to_vec(),
            Val::Rational(n, d) => [n.to_be_bytes(), d.to_be_bytes()].concat(),
            Val::Undefined(b) => b.clone(),
        }
    }
    // Writes one IFD at `start` (offset in the TIFF), returns its bytes (entries + data).
    fn ifd(entries: &[(u16, Val)], start: usize) -> Vec<u8> {
        let table = 2 + entries.len() * 12 + 4;
        let mut head = (entries.len() as u16).to_be_bytes().to_vec();
        let mut data = Vec::new();
        for (tag, v) in entries {
            let (ty, count, len) = size(v);
            head.extend_from_slice(&tag.to_be_bytes());
            head.extend_from_slice(&ty.to_be_bytes());
            head.extend_from_slice(&count.to_be_bytes());
            let b = bytes(v);
            if len <= 4 {
                let mut inline = b.clone();
                inline.resize(4, 0);
                head.extend_from_slice(&inline);
            } else {
                head.extend_from_slice(&((start + table + data.len()) as u32).to_be_bytes());
                data.extend_from_slice(&b);
                if data.len() % 2 == 1 {
                    data.push(0);
                }
            }
        }
        head.extend_from_slice(&0u32.to_be_bytes());
        [head, data].concat()
    }

    let mut ifd0 = ifd0;
    ifd0.push((0x8769, Val::Long(0))); // placeholder: Exif IFD offset
    ifd0.sort_by_key(|(t, _)| *t);
    let first = ifd(&ifd0, 8);
    let exif_off = 8 + first.len();
    for e in ifd0.iter_mut() {
        if e.0 == 0x8769 {
            e.1 = Val::Long(exif_off as u32);
        }
    }
    let first = ifd(&ifd0, 8);
    let mut exif = exif;
    exif.sort_by_key(|(t, _)| *t);
    let second = ifd(&exif, exif_off);

    let mut tiff = b"MM\x00\x2A\x00\x00\x00\x08".to_vec();
    tiff.extend_from_slice(&first);
    tiff.extend_from_slice(&second);
    let mut seg = vec![0xFF, 0xE1];
    seg.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
    seg.extend_from_slice(b"Exif\0\0");
    seg.extend_from_slice(&tiff);
    seg
}

fn shutter_rational(label: &str) -> Option<(u32, u32)> {
    let den: f64 = label.strip_prefix("1/")?.parse().ok()?;
    Some((10, (den * 10.0).round() as u32))
}

/// JPEG with an EXIF segment inserted right after SOI.
pub fn jpeg_with_exif(jpeg: &[u8], info: &PhotoInfo, date: Option<&str>) -> Vec<u8> {
    let mut ifd0 = vec![
        (0x010F, Val::Ascii("SONY".into())),
        (0x0110, Val::Ascii("DSC-MD1".into())),
        (0x0131, Val::Ascii("MD1 Studio".into())),
    ];
    let mut exif = vec![
        (0x9000, Val::Undefined(b"0230".to_vec())),
        (0xA002, Val::Short(info.width)),
        (0xA003, Val::Short(info.height)),
    ];
    if let Some((n, d)) = info.shutter.as_deref().and_then(shutter_rational) {
        exif.push((0x829A, Val::Rational(n, d)));
    }
    if let Some(f) = info.flash {
        exif.push((0x9209, Val::Short(if f { 1 } else { 0 })));
    }
    if let Some(d) = date {
        ifd0.push((0x0132, Val::Ascii(d.into())));
        exif.push((0x9003, Val::Ascii(d.into())));
    }
    let app1 = exif_app1(ifd0, exif);
    let mut out = Vec::with_capacity(jpeg.len() + app1.len());
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || " -_".contains(c) { c } else { '_' }).collect()
}

/// A path in `dir` for `name.ext` that doesn't clobber a different existing file.
fn free_path(dir: &Path, stem: &str, ext: &str, data: &[u8]) -> Option<PathBuf> {
    for k in 1.. {
        let p = if k == 1 { dir.join(format!("{stem}.{ext}")) } else { dir.join(format!("{stem} ({k}).{ext}")) };
        match fs::read(&p) {
            Ok(old) if old == data => return None, // identical file already exported
            Ok(_) => continue,
            Err(_) => return Some(p),
        }
    }
    unreachable!()
}

pub struct ExportResult {
    pub written: Vec<PathBuf>,
    pub already_there: usize,
}

pub fn export_photos(photos: &[(&str, &Photo)], dest: &Path, with_exif: bool) -> Result<ExportResult, Error> {
    fs::create_dir_all(dest)?;
    let mut res = ExportResult { written: Vec::new(), already_there: 0 };
    for (disc_name, p) in photos {
        let stem = sanitize(&format!("{disc_name} {} {}", p.album, p.stem));
        let pmp = fs::read(&p.pmp_path)?;
        let Some(jpeg) = crate::formats::extract_jpeg(&pmp) else { continue };
        let date = p
            .created
            .as_deref()
            .filter(|_| !p.clock_unset)
            .map(|d| d.replace('-', ":"));
        let out = if with_exif { jpeg_with_exif(jpeg, &p.info, date.as_deref()) } else { jpeg.to_vec() };
        let mut files = vec![("jpg", out)];
        if let Some(w) = &p.wav_path {
            files.push(("wav", fs::read(w)?));
        }
        for (ext, data) in files {
            match free_path(dest, &stem, ext, &data) {
                Some(path) => {
                    fs::write(&path, &data)?;
                    res.written.push(path);
                }
                None => res.already_there += 1,
            }
        }
    }
    Ok(res)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exif_segment_is_well_formed() {
        let info = PhotoInfo {
            quality: "FINE".into(),
            width: 640,
            height: 480,
            shutter_tv100: Some(491),
            shutter: Some("1/30".into()),
            exposure_seconds: Some(1.0 / 30.0),
            flash: Some(true),
            jpeg_len: 0,
        };
        let j = jpeg_with_exif(&[0xFF, 0xD8, 0xFF, 0xD9], &info, Some("1998:05:03 10:00:00"));
        assert_eq!(&j[..4], &[0xFF, 0xD8, 0xFF, 0xE1]);
        let len = u16::from_be_bytes([j[4], j[5]]) as usize;
        assert_eq!(&j[6..12], b"Exif\0\0");
        assert_eq!(&j[4 + len..], &[0xFF, 0xD9]);
        let tiff = &j[12..4 + len];
        assert_eq!(&tiff[..4], b"MM\x00\x2A");
        let n = u16::from_be_bytes([tiff[8], tiff[9]]);
        assert_eq!(n, 5); // Make, Model, Software, DateTime, ExifIFD
        assert!(tiff.windows(7).any(|w| w == b"DSC-MD1"));
    }
}
