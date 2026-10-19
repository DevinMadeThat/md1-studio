//! Export photos as ordinary JPEGs plus the sound as a WAV of the same name.
//!
//! EXIF written: camera, shutter, flash, size; the date/time (the user's edit, else the camera's
//! when its clock was set); GPS position from the user's location edit; orientation from their
//! rotation (lossless: the JPEG data is untouched, viewers rotate it).

use std::fs;
use std::path::{Path, PathBuf};

use crate::edits::PhotoEdits;
use crate::formats::PhotoInfo;
use crate::library::Photo;
use crate::Error;

enum Val {
    Ascii(String),
    Short(u16),
    Long(u32),
    Rational(u32, u32),
    Rationals(Vec<(u32, u32)>),
    Bytes(Vec<u8>),
    Undefined(Vec<u8>),
}

/// Minimal big-endian TIFF/EXIF writer: IFD0 + Exif sub-IFD + optional GPS sub-IFD.
fn exif_app1(ifd0: Vec<(u16, Val)>, exif: Vec<(u16, Val)>, gps: Option<Vec<(u16, Val)>>) -> Vec<u8> {
    fn size(v: &Val) -> (u16, u32, usize) {
        // (type, count, byte length)
        match v {
            Val::Ascii(s) => (2, s.len() as u32 + 1, s.len() + 1),
            Val::Short(_) => (3, 1, 2),
            Val::Long(_) => (4, 1, 4),
            Val::Rational(..) => (5, 1, 8),
            Val::Rationals(r) => (5, r.len() as u32, r.len() * 8),
            Val::Bytes(b) => (1, b.len() as u32, b.len()),
            Val::Undefined(b) => (7, b.len() as u32, b.len()),
        }
    }
    fn bytes(v: &Val) -> Vec<u8> {
        match v {
            Val::Ascii(s) => [s.as_bytes(), &[0]].concat(),
            Val::Short(x) => x.to_be_bytes().to_vec(),
            Val::Long(x) => x.to_be_bytes().to_vec(),
            Val::Rational(n, d) => [n.to_be_bytes(), d.to_be_bytes()].concat(),
            Val::Rationals(r) => r.iter().flat_map(|(n, d)| [n.to_be_bytes(), d.to_be_bytes()].concat()).collect(),
            Val::Bytes(b) | Val::Undefined(b) => b.clone(),
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

    // IFD0 points at the Exif IFD (0x8769) and the GPS IFD (0x8825); offsets depend on IFD0's
    // own size, which doesn't change when the placeholder values are filled in.
    let mut ifd0 = ifd0;
    ifd0.push((0x8769, Val::Long(0)));
    if gps.is_some() {
        ifd0.push((0x8825, Val::Long(0)));
    }
    ifd0.sort_by_key(|(t, _)| *t);
    let mut exif = exif;
    exif.sort_by_key(|(t, _)| *t);
    let exif_off = 8 + ifd(&ifd0, 8).len();
    let gps_off = exif_off + ifd(&exif, exif_off).len();
    for e in ifd0.iter_mut() {
        match e.0 {
            0x8769 => e.1 = Val::Long(exif_off as u32),
            0x8825 => e.1 = Val::Long(gps_off as u32),
            _ => {}
        }
    }
    let first = ifd(&ifd0, 8);
    let second = ifd(&exif, exif_off);
    let third = gps.map(|mut g| {
        g.sort_by_key(|(t, _)| *t);
        ifd(&g, gps_off)
    });

    let mut tiff = b"MM\x00\x2A\x00\x00\x00\x08".to_vec();
    tiff.extend_from_slice(&first);
    tiff.extend_from_slice(&second);
    if let Some(t) = third {
        tiff.extend_from_slice(&t);
    }
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

/// Degrees, minutes, seconds as EXIF rationals (seconds to 1/1000).
fn dms(v: f64) -> Vec<(u32, u32)> {
    let v = v.abs();
    let d = v.floor();
    let m = ((v - d) * 60.0).floor();
    let sec = ((v - d) * 60.0 - m) * 60.0;
    vec![(d as u32, 1), (m as u32, 1), ((sec * 1000.0).round() as u32, 1000)]
}

/// EXIF orientation for a clockwise rotation.
fn orientation(rotation: u16) -> u16 {
    match rotation {
        90 => 6,
        180 => 3,
        270 => 8,
        _ => 1,
    }
}

/// JPEG with an EXIF segment inserted right after SOI. `date` is "YYYY:MM:DD HH:MM:SS".
pub fn jpeg_with_exif(jpeg: &[u8], info: &PhotoInfo, date: Option<&str>, edits: &PhotoEdits) -> Vec<u8> {
    let mut ifd0 = vec![
        (0x010F, Val::Ascii("SONY".into())),
        (0x0110, Val::Ascii("DSC-MD1".into())),
        (0x0112, Val::Short(orientation(edits.rotation))),
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
        exif.push((0x9004, Val::Ascii(d.into())));
    }
    let gps = edits.location.as_ref().map(|l| {
        vec![
            (0x0000, Val::Bytes(vec![2, 3, 0, 0])),
            (0x0001, Val::Ascii(if l.lat >= 0.0 { "N" } else { "S" }.into())),
            (0x0002, Val::Rationals(dms(l.lat))),
            (0x0003, Val::Ascii(if l.lon >= 0.0 { "E" } else { "W" }.into())),
            (0x0004, Val::Rationals(dms(l.lon))),
        ]
    });
    if let Some(name) = edits.location.as_ref().and_then(|l| l.name.as_ref()) {
        ifd0.push((0x010E, Val::Ascii(name.chars().filter(|c| c.is_ascii() && !c.is_ascii_control()).collect())));
    }
    let app1 = exif_app1(ifd0, exif, gps);
    let mut out = Vec::with_capacity(jpeg.len() + app1.len());
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(&app1);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_alphanumeric() || " -_()".contains(c) { c } else { '_' }).collect()
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
        // The user's date wins; otherwise the camera's, but only if its clock was set.
        let date = p
            .edits
            .taken
            .as_deref()
            .or(p.created.as_deref().filter(|_| !p.clock_unset))
            .map(|d| d.replace('-', ":"));
        let out = if with_exif { jpeg_with_exif(jpeg, &p.info, date.as_deref(), &p.edits) } else { jpeg.to_vec() };
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
        let edits = PhotoEdits {
            location: Some(crate::edits::Location { lat: 47.6097, lon: -122.3422, name: Some("Pike Place".into()) }),
            taken: None,
            rotation: 90,
        };
        let j = jpeg_with_exif(&[0xFF, 0xD8, 0xFF, 0xD9], &info, Some("1998:05:03 10:00:00"), &edits);
        assert_eq!(&j[..4], &[0xFF, 0xD8, 0xFF, 0xE1]);
        let len = u16::from_be_bytes([j[4], j[5]]) as usize;
        assert_eq!(&j[6..12], b"Exif\0\0");
        assert_eq!(&j[4 + len..], &[0xFF, 0xD9]);
        let tiff = &j[12..4 + len];
        assert_eq!(&tiff[..4], b"MM\x00\x2A");
        let n = u16::from_be_bytes([tiff[8], tiff[9]]);
        assert_eq!(n, 8); // Description, Make, Model, Orientation, Software, DateTime, Exif, GPS
        // Write it out so it can be checked with a real EXIF reader (see tests in CI notes).
        let _ = fs::write(std::env::temp_dir().join("md1-exif-test.jpg"), &j);
        assert!(tiff.windows(7).any(|w| w == b"DSC-MD1"));
    }
}
