//! Export photos as ordinary JPEGs plus the sound as a WAV of the same name.
//!
//! EXIF written: camera, shutter, flash, size; the date/time (the user's edit, else the camera's
//! when its clock was set); GPS position from the user's location edit; the caption.
//! XMP written (read by Photos, Lightroom, etc.): caption, place name, rating 5 for favourites.
//!
//! A photo whose only change is a rotation keeps its original JPEG data (EXIF orientation tells
//! viewers to turn it). Any other edit (colour, crop, straighten, flip, noise) or an upscale is
//! rendered by [`crate::adjust::render`] and saved as a new JPEG at quality 93.

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
/// `size` is the pixel size of `jpeg`; `orient` whether viewers should apply `edits.rotation`
/// (false when the rotation is already in the pixels).
pub fn jpeg_with_exif(
    jpeg: &[u8],
    info: &PhotoInfo,
    date: Option<&str>,
    edits: &PhotoEdits,
    size: (u32, u32),
    orient: bool,
) -> Vec<u8> {
    let mut ifd0 = vec![
        (0x010F, Val::Ascii("SONY".into())),
        (0x0110, Val::Ascii("DSC-MD1".into())),
        (0x0112, Val::Short(if orient { orientation(edits.rotation) } else { 1 })),
        (0x0131, Val::Ascii("MD1 Studio".into())),
    ];
    let mut exif = vec![
        (0x9000, Val::Undefined(b"0230".to_vec())),
        (0xA002, Val::Long(size.0)),
        (0xA003, Val::Long(size.1)),
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
    if let Some(c) = &edits.caption {
        let ascii: String = c.chars().filter(|c| c.is_ascii() && !c.is_ascii_control()).collect();
        if !ascii.trim().is_empty() {
            ifd0.push((0x010E, Val::Ascii(ascii)));
        }
    }
    let app1 = exif_app1(ifd0, exif, gps);
    let xmp = xmp_app1(edits, date);
    let mut out = Vec::with_capacity(jpeg.len() + app1.len() + xmp.len());
    out.extend_from_slice(&jpeg[..2]);
    out.extend_from_slice(&app1);
    out.extend_from_slice(&xmp);
    out.extend_from_slice(&jpeg[2..]);
    out
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// XMP packet (UTF-8): caption, place name, favourite as a 5-star rating, creation date.
fn xmp_app1(edits: &PhotoEdits, date: Option<&str>) -> Vec<u8> {
    let mut attrs = String::from(r#" xmp:CreatorTool="MD1 Studio""#);
    if edits.favorite {
        attrs.push_str(r#" xmp:Rating="5""#);
    }
    if let Some(d) = date {
        // "YYYY:MM:DD HH:MM:SS" → ISO 8601
        let iso = format!("{}T{}", d[..10].replace(':', "-"), &d[11..]);
        attrs.push_str(&format!(r#" photoshop:DateCreated="{iso}" xmp:CreateDate="{iso}""#));
    }
    let mut body = String::new();
    if let Some(c) = &edits.caption {
        body.push_str(&format!(
            r#"<dc:description><rdf:Alt><rdf:li xml:lang="x-default">{}</rdf:li></rdf:Alt></dc:description>"#,
            xml_escape(c)
        ));
    }
    if let Some(name) = edits.location.as_ref().and_then(|l| l.name.as_ref()) {
        body.push_str(&format!("<Iptc4xmpCore:Location>{}</Iptc4xmpCore:Location>", xml_escape(name)));
    }
    let packet = format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\
<rdf:Description rdf:about=\"\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" \
xmlns:photoshop=\"http://ns.adobe.com/photoshop/1.0/\" xmlns:Iptc4xmpCore=\"http://iptc.org/std/Iptc4xmpCore/1.0/xmlns/\"{attrs}>\
{body}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
    );
    let mut seg = vec![0xFF, 0xE1];
    let header = b"http://ns.adobe.com/xap/1.0/\0";
    seg.extend_from_slice(&((2 + header.len() + packet.len()) as u16).to_be_bytes());
    seg.extend_from_slice(header);
    seg.extend_from_slice(packet.as_bytes());
    seg
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

/// File type for exported photos. PNG and TIFF are lossless copies of the rendered picture
/// (no EXIF; the metadata options apply to JPEG only).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    #[default]
    Jpeg,
    Png,
    Tiff,
}

#[derive(Debug, Clone, Copy)]
pub struct ExportOptions {
    pub format: Format,
    /// 1, 2 or 3: upscale the exported JPEG (Lanczos + light sharpening).
    pub scale: f64,
    /// Write the photo's sound next to it as a WAV.
    pub sound: bool,
    /// Apply colour / crop / straighten / flip / rotation edits.
    pub apply_edits: bool,
    /// Write EXIF + XMP metadata (camera, date, GPS, caption, rating).
    pub metadata: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self { format: Format::Jpeg, scale: 1.0, sound: true, apply_edits: true, metadata: true }
    }
}

/// The exported JPEG for one photo, with the chosen options.
pub fn export_jpeg(p: &Photo, opts: &ExportOptions) -> Result<Vec<u8>, Error> {
    let pmp = fs::read(&p.pmp_path)?;
    let jpeg = crate::formats::extract_jpeg(&pmp).ok_or_else(|| Error::Protocol(format!("{}: no JPEG inside", p.stem)))?;
    // The user's date wins; otherwise the camera's, but only if its clock was set.
    let date = p
        .edits
        .taken
        .as_deref()
        .or(p.created.as_deref().filter(|_| !p.clock_unset))
        .map(|d| d.replace('-', ":"));
    let edits = if opts.apply_edits { p.edits.clone() } else { PhotoEdits { rotation: 0, ..p.edits.clone() } };
    let render = opts.apply_edits && edits.has_look() || opts.scale > 1.0;
    let (body, size, orient) = if render {
        let img = crate::adjust::decode_jpeg(jpeg).ok_or_else(|| Error::Protocol(format!("{}: unreadable JPEG", p.stem)))?;
        let look = if opts.apply_edits { edits.clone() } else { PhotoEdits::default() };
        let out = crate::adjust::render(&img, &look, opts.scale);
        let size = (out.width(), out.height());
        (crate::adjust::encode_jpeg(&out, 93), size, false)
    } else {
        (jpeg.to_vec(), (p.info.width as u32, p.info.height as u32), opts.apply_edits)
    };
    Ok(if opts.metadata { jpeg_with_exif(&body, &p.info, date.as_deref(), &edits, size, orient) } else { body })
}

/// The photo rendered (edits, upscale) and saved as PNG or TIFF.
fn export_lossless(p: &Photo, opts: &ExportOptions, format: image::ImageFormat) -> Result<Vec<u8>, Error> {
    let pmp = fs::read(&p.pmp_path)?;
    let jpeg = crate::formats::extract_jpeg(&pmp).ok_or_else(|| Error::Protocol(format!("{}: no JPEG inside", p.stem)))?;
    let img = crate::adjust::decode_jpeg(jpeg).ok_or_else(|| Error::Protocol(format!("{}: unreadable JPEG", p.stem)))?;
    let look = if opts.apply_edits { p.edits.clone() } else { PhotoEdits::default() };
    let out = crate::adjust::render(&img, &look, opts.scale);
    let mut buf = std::io::Cursor::new(Vec::new());
    out.write_to(&mut buf, format).map_err(|e| Error::Protocol(e.to_string()))?;
    Ok(buf.into_inner())
}

pub fn export_photos(photos: &[(&str, &Photo)], dest: &Path, opts: &ExportOptions) -> Result<ExportResult, Error> {
    fs::create_dir_all(dest)?;
    let mut res = ExportResult { written: Vec::new(), already_there: 0 };
    for (disc_name, p) in photos {
        let stem = sanitize(&format!("{disc_name} {} {}", p.album, p.stem));
        let mut files = vec![match opts.format {
            Format::Jpeg => ("jpg", export_jpeg(p, opts)?),
            Format::Png => ("png", export_lossless(p, opts, image::ImageFormat::Png)?),
            Format::Tiff => ("tif", export_lossless(p, opts, image::ImageFormat::Tiff)?),
        }];
        if opts.sound {
            if let Some(w) = &p.wav_path {
                files.push(("wav", fs::read(w)?));
            }
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
            rotation: 90,
            caption: Some("Fish throwing".into()),
            favorite: true,
            ..Default::default()
        };
        let j = jpeg_with_exif(&[0xFF, 0xD8, 0xFF, 0xD9], &info, Some("1998:05:03 10:00:00"), &edits, (640, 480), true);
        assert!(j.windows(13).any(|w| w == b"xmp:Rating=\"5"));
        assert_eq!(&j[..4], &[0xFF, 0xD8, 0xFF, 0xE1]);
        let len = u16::from_be_bytes([j[4], j[5]]) as usize;
        assert_eq!(&j[6..12], b"Exif\0\0");
        assert_eq!(&j[4 + len..4 + len + 2], &[0xFF, 0xE1]); // XMP follows EXIF
        let tiff = &j[12..4 + len];
        assert_eq!(&tiff[..4], b"MM\x00\x2A");
        let n = u16::from_be_bytes([tiff[8], tiff[9]]);
        assert_eq!(n, 8); // Description, Make, Model, Orientation, Software, DateTime, Exif, GPS
        // Write it out so it can be checked with a real EXIF reader (see tests in CI notes).
        let _ = fs::write(std::env::temp_dir().join("md1-exif-test.jpg"), &j);
        assert!(tiff.windows(7).any(|w| w == b"DSC-MD1"));
    }
}
