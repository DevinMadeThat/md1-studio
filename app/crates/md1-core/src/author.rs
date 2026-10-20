//! Writing to the disc in the camera: new photos (any JPEG, converted to the camera's format)
//! and changes to existing ones (rotation, protect) in the album index.
//!
//! The MD1 refuses Sony's "add picture" command (`02 14`), so a new photo is added the way
//! `md1tool/add_photo.py` proved on the hardware: write `PSNnnnnn.PMP`, append a thumbnail block
//! to `PIDX000.PMX`, append a record to `PIC_INF.PMF` and bump its counts, bump the album's count
//! in `OV_INF.PMF`. Payload files are written before index files, and every file is read back and
//! compared. The camera re-reads its indexes after it is switched off and on.

use image::{imageops, RgbImage};

use crate::camera::Camera;
use crate::formats::{self, PIC_INF_RECORDS, PMP_HEADER, PMX_BLOCK};
use crate::Error;

/// Header of a photo the camera took (standard quality, clock unset, exposure unknown is
/// patched in): the TLV records 0x10 file, 0x20 image, 0x21 dates, 0x24 exposure, 0x11 text.
const PMP_TEMPLATE: [u8; 0x64 + 2] = [
    0x10, 0x12, 0x01, 0x00, 0x10, 0x00, 0x05, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, //
    0x00, 0x00, 0x00, 0x00, 0x20, 0x1a, 0x02, 0x80, 0x01, 0xe0, 0x00, 0x00, 0x00, 0x17, 0xdb, 0x20, //
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0x80, 0x01, 0xe0, 0x00, 0x00, 0x00, 0x00, //
    0x21, 0x1a, 0x00, 0xf7, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, //
    0xff, 0xff, 0x00, 0x00, 0x01, 0x00, 0x28, 0x01, 0x00, 0x00, 0x00, 0x00, 0x24, 0x16, 0x80, 0x00, //
    0x80, 0x00, 0x80, 0x00, 0x80, 0x00, 0x80, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00, 0x00, //
    0xff, 0xff, 0x00, 0x00, 0x11, 0x42,
];

/// Size budgets the camera uses: standard photos fit in 64 KB, fine ones in 128 KB.
const STD_BUDGET: usize = 63 * 1024;
const FINE_BUDGET: usize = 124 * 1024;

/// A baseline 4:2:0 JPEG laid out like the camera's own: no APP segments, component ids 0/1/2.
pub fn camera_jpeg(img: &RgbImage, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    let mut enc = jpeg_encoder::Encoder::new(&mut out, quality);
    enc.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_2_0);
    enc.encode(img.as_raw(), img.width() as u16, img.height() as u16, jpeg_encoder::ColorType::Rgb)
        .expect("in-memory JPEG encode");
    like_camera(&out)
}

/// Rewrite an encoder's JPEG into the camera's layout: tables (DQT, DHT) first, then the frame
/// header, then the scan; no APPn segments; components numbered 0, 1, 2.
fn like_camera(j: &[u8]) -> Vec<u8> {
    let (mut tables, mut frame, mut scan) = (Vec::new(), Vec::new(), Vec::new());
    let mut ids: Vec<u8> = Vec::new();
    let mut i = 2;
    while i + 4 <= j.len() && j[i] == 0xFF {
        let m = j[i + 1];
        let len = u16::from_be_bytes([j[i + 2], j[i + 3]]) as usize;
        let mut seg = j[i..i + 2 + len].to_vec();
        match m {
            0xE0..=0xEF => {}
            0xDB | 0xC4 => tables.extend_from_slice(&seg),
            0xC0 => {
                for k in 0..seg[9] as usize {
                    ids.push(seg[10 + 3 * k]);
                    seg[10 + 3 * k] = k as u8;
                }
                frame.extend_from_slice(&seg);
            }
            0xDA => {
                for k in 0..seg[4] as usize {
                    let id = seg[5 + 2 * k];
                    seg[5 + 2 * k] = ids.iter().position(|&x| x == id).unwrap_or(k) as u8;
                }
                scan.extend_from_slice(&seg);
                scan.extend_from_slice(&j[i + 2 + len..]);
                break;
            }
            _ => tables.extend_from_slice(&seg),
        }
        i += 2 + len;
    }
    [&[0xFF, 0xD8][..], &tables, &frame, &scan].concat()
}

/// Fit a picture into 640 × 480 (the only size the camera shows), keeping its shape: `fill`
/// crops to fill the frame, otherwise it is letterboxed on black.
pub fn to_camera_frame(img: &RgbImage, fill: bool) -> RgbImage {
    let (w, h) = (img.width() as f64, img.height() as f64);
    let s = if fill { (640.0 / w).max(480.0 / h) } else { (640.0 / w).min(480.0 / h) };
    let (nw, nh) = (((w * s).round() as u32).max(1), ((h * s).round() as u32).max(1));
    let scaled = imageops::resize(img, nw, nh, imageops::FilterType::Lanczos3);
    let mut frame = RgbImage::new(640, 480);
    let (x, y) = ((640 - nw as i64) / 2, (480 - nh as i64) / 2);
    imageops::overlay(&mut frame, &scaled, x, y);
    frame
}

/// The camera's photo file for a 640 × 480 picture, at the highest quality that fits the
/// budget for `fine` or standard.
pub fn make_pmp(frame: &RgbImage, fine: bool) -> Vec<u8> {
    let budget = if fine { FINE_BUDGET } else { STD_BUDGET };
    let mut q = if fine { 92 } else { 85 };
    let jpeg = loop {
        let j = camera_jpeg(frame, q);
        if j.len() <= budget || q <= 30 {
            break j;
        }
        q -= 5;
    };
    let mut pmp = vec![0u8; PMP_HEADER];
    pmp[..PMP_TEMPLATE.len()].copy_from_slice(&PMP_TEMPLATE);
    pmp[0x0C..0x10].copy_from_slice(&(jpeg.len() as u32).to_be_bytes());
    pmp[0x14 + 9] = if fine { 0x33 } else { 0x17 };
    pmp.extend_from_slice(&jpeg);
    pmp
}

/// One 4096-byte thumbnail block: an 80 × 60 picture on an 80 × 64 canvas (the camera's own
/// thumbnails end in 4 flat rows), after a 256-byte header copied from the album's first block.
pub fn thumbnail_block(frame: &RgbImage, header: &[u8]) -> Result<Vec<u8>, Error> {
    let small = imageops::resize(frame, 80, 60, imageops::FilterType::Lanczos3);
    let mut canvas = RgbImage::new(80, 64);
    imageops::overlay(&mut canvas, &small, 0, 0);
    let mut q = 80;
    let t = loop {
        let t = camera_jpeg(&canvas, q);
        if t.len() <= PMX_BLOCK - PMP_HEADER || q <= 30 {
            break t;
        }
        q -= 10;
    };
    let mut block = header.get(..PMP_HEADER).ok_or_else(|| Error::Protocol("thumbnail file too short".into()))?.to_vec();
    block[0x0C..0x10].copy_from_slice(&(t.len() as u32).to_be_bytes());
    block.extend_from_slice(&t);
    block.resize(PMX_BLOCK, 0);
    Ok(block)
}

/// An album's index files as read from the camera, edited in memory.
pub struct Album {
    pub name: String,
    pub pic_inf: Vec<u8>,
    pub pidx: Vec<u8>,
    pub ov_inf: Vec<u8>,
}

/// Album count fields (docs/disc-format.md, "Album counts that must stay consistent").
const PIC_INF_COUNTS: [usize; 3] = [0x104, 0x106, 0x10E];
const OV_INF_COUNTS: [usize; 2] = [0x100, 0x124];

fn be16(d: &[u8], at: usize) -> u16 {
    u16::from_be_bytes([d[at], d[at + 1]])
}

impl Album {
    /// From files a browse of the disc already read (they're current until the next write).
    pub fn from_browsed(b: &crate::browse::CameraDisc, name: &str) -> Result<Self, Error> {
        let get = |p: String| b.files.get(&p).cloned().ok_or_else(|| Error::Protocol(format!("{p} wasn't read")));
        let album = Album {
            name: name.to_string(),
            pic_inf: get(format!("/PIC_MD/{name}/PIC_INF.PMF"))?,
            pidx: get(format!("/PIC_MD/{name}/PIDX000.PMX"))?,
            ov_inf: get("/PIC_MD/OV_INF.PMF".into())?,
        };
        album.check()?;
        Ok(album)
    }

    pub fn read(cam: &mut Camera, name: &str) -> Result<Self, Error> {
        let base = format!("/PIC_MD/{name}");
        let album = Album {
            name: name.to_string(),
            pic_inf: cam.read_file(&format!("{base}/PIC_INF.PMF"), &mut |_| Ok(()))?,
            pidx: cam.read_file(&format!("{base}/PIDX000.PMX"), &mut |_| Ok(()))?,
            ov_inf: cam.read_file("/PIC_MD/OV_INF.PMF", &mut |_| Ok(()))?,
        };
        album.check()?;
        Ok(album)
    }

    pub fn count(&self) -> u16 {
        be16(&self.pic_inf, 0x104)
    }

    /// Refuse to edit anything that doesn't look exactly like the layout we've proven.
    pub fn check(&self) -> Result<(), Error> {
        let bad = |why: String| Err(Error::Protocol(format!("{}: {why}; not changing it", self.name)));
        let n = self.count() as usize;
        if formats::parse_pic_inf(&self.pic_inf).is_none() {
            return bad("album index not recognized".into());
        }
        if PIC_INF_COUNTS.iter().any(|&o| be16(&self.pic_inf, o) as usize != n) {
            return bad("album index counts disagree".into());
        }
        if self.pic_inf.len() != PIC_INF_RECORDS + 16 * n {
            return bad(format!("album index is {} bytes, expected {}", self.pic_inf.len(), PIC_INF_RECORDS + 16 * n));
        }
        if self.pidx.len() != PMX_BLOCK * n {
            return bad(format!("thumbnail file has {} blocks for {n} photos", self.pidx.len() / PMX_BLOCK));
        }
        let album_no: u16 = self.name.trim_start_matches("PIC").parse().unwrap_or(u16::MAX);
        if self.ov_inf.len() < 0x126 || be16(&self.ov_inf, 0x120) != album_no || OV_INF_COUNTS.iter().any(|&o| be16(&self.ov_inf, o) as usize != n) {
            return bad("album list doesn't match this album (more than one album on the disc?)".into());
        }
        Ok(())
    }

    fn record(&mut self, position: usize) -> Result<&mut [u8], Error> {
        let n = self.count() as usize;
        if position >= n {
            return Err(Error::Protocol(format!("{}: no photo at position {}", self.name, position + 1)));
        }
        let at = PIC_INF_RECORDS + 16 * position;
        Ok(&mut self.pic_inf[at..at + 16])
    }

    /// Show the photo turned `quarters_cw` quarter turns clockwise. The record (byte 5 bits 2–3)
    /// counts counter-clockwise quarter turns; the camera honours it (confirmed 2026-10-19).
    pub fn set_rotation(&mut self, position: usize, quarters_cw: u8) -> Result<(), Error> {
        let r = self.record(position)?;
        let ccw = (4 - (quarters_cw & 3)) % 4;
        r[5] = (r[5] & !0x0C) | (ccw << 2);
        Ok(())
    }

    /// Protect flag: record byte 14 bit 0. The camera shows no mark, but refuses to delete the
    /// photo (confirmed 2026-10-19); Sony's software skips these when deleting.
    pub fn set_protected(&mut self, position: usize, on: bool) -> Result<(), Error> {
        let r = self.record(position)?;
        r[14] = (r[14] & !1) | on as u8;
        Ok(())
    }

    /// Add a photo at the end of the album; returns its file name and contents.
    pub fn add_photo(&mut self, frame: &RgbImage, fine: bool) -> Result<(String, Vec<u8>), Error> {
        let n = self.count() as usize;
        let last = self.pic_inf[self.pic_inf.len() - 16..].to_vec();
        let next = (0..n).map(|k| be16(&self.pic_inf, PIC_INF_RECORDS + 16 * k + 2)).max().map_or(0, |m| m + 1);
        let mut rec = last;
        rec[2..4].copy_from_slice(&next.to_be_bytes());
        rec[5] = 0; // no rotation
        rec[7] = 0; // no sound
        rec[14] = 0; // not protected
        self.pic_inf.extend_from_slice(&rec);
        for o in PIC_INF_COUNTS {
            self.pic_inf[o..o + 2].copy_from_slice(&((n + 1) as u16).to_be_bytes());
        }
        let body = (self.pic_inf.len() - 0x100) as u32;
        self.pic_inf[0x0C..0x10].copy_from_slice(&body.to_be_bytes());
        for o in OV_INF_COUNTS {
            self.ov_inf[o..o + 2].copy_from_slice(&((n + 1) as u16).to_be_bytes());
        }
        let block = thumbnail_block(frame, &self.pidx[..PMP_HEADER])?;
        self.pidx.extend_from_slice(&block);
        Ok((format!("PSN{next:05}.PMP"), make_pmp(frame, fine)))
    }

    /// The index files to write back, in the order the camera should see them.
    pub fn index_files(&self) -> Vec<(String, Vec<u8>)> {
        let base = format!("/PIC_MD/{}", self.name);
        vec![
            (format!("{base}/PIDX000.PMX"), self.pidx.clone()),
            (format!("{base}/PIC_INF.PMF"), self.pic_inf.clone()),
            ("/PIC_MD/OV_INF.PMF".to_string(), self.ov_inf.clone()),
        ]
    }
}

/// Write files to the camera and read each one back. Needs power level 3 or more (Sony's own
/// software refuses below that). Writes are switched on only for the duration of this call.
pub fn write_files(
    cam: &mut Camera,
    files: &[(String, Vec<u8>)],
    on_file: &mut dyn FnMut(&str, usize, usize) -> Result<(), Error>,
) -> Result<(), Error> {
    let status = cam.status()?;
    if status.power < 3 {
        return Err(Error::Refused("the camera's battery is too low to write safely; use the AC adapter".into()));
    }
    cam.set_writes_enabled(true);
    let result = (|| {
        for (k, (path, data)) in files.iter().enumerate() {
            on_file(path, k + 1, files.len())?;
            cam.write_file(path, data, &mut |_| Ok(()))?;
            let back = cam.read_file(path, &mut |_| Ok(()))?;
            if &back != data {
                return Err(Error::Protocol(format!("{path}: read-back differs from what was written")));
            }
        }
        Ok(())
    })();
    cam.set_writes_enabled(false);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pmp_is_camera_shaped() {
        let img = RgbImage::from_fn(1000, 500, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 90]));
        let frame = to_camera_frame(&img, false);
        let pmp = make_pmp(&frame, false);
        assert!(pmp.len() <= STD_BUDGET + PMP_HEADER);
        let info = formats::photo_info(&pmp);
        assert_eq!((info.quality.as_str(), info.width, info.height), ("STD", 640, 480));
        assert_eq!(info.jpeg_len as usize, pmp.len() - PMP_HEADER);
        let j = formats::extract_jpeg(&pmp).unwrap();
        assert_eq!(&j[..4], &[0xFF, 0xD8, 0xFF, 0xDB], "no APP0, tables first like the camera's");
        let sof = j.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        assert_eq!(&j[sof + 11..sof + 12], &[0x22], "4:2:0");
        assert_eq!([j[sof + 10], j[sof + 13], j[sof + 16]], [0, 1, 2], "component ids like the camera's");
        let decoded = crate::adjust::decode_jpeg(j).unwrap();
        assert_eq!(decoded.dimensions(), (640, 480));
    }

    #[test]
    fn rotation_is_stored_counter_clockwise() {
        let mut pic_inf = vec![0u8; PIC_INF_RECORDS + 16];
        pic_inf[..4].copy_from_slice(&[0x10, 0x12, 0x01, 0x00]);
        for o in PIC_INF_COUNTS {
            pic_inf[o + 1] = 1;
        }
        let mut album = Album { name: "PIC00001".into(), pic_inf, pidx: vec![0; PMX_BLOCK], ov_inf: vec![0; 0x130] };
        // On the camera, stored value 1 showed the photo turned 90° counter-clockwise.
        album.set_rotation(0, 3).unwrap();
        assert_eq!(album.pic_inf[PIC_INF_RECORDS + 5] & 0x0C, 1 << 2);
        album.set_rotation(0, 1).unwrap();
        assert_eq!(album.pic_inf[PIC_INF_RECORDS + 5] & 0x0C, 3 << 2);
        let rec = &formats::parse_pic_inf(&album.pic_inf).unwrap().records[0];
        assert_eq!(rec.rotation_cw(), 1);
        album.set_protected(0, true).unwrap();
        assert!(formats::parse_pic_inf(&album.pic_inf).unwrap().records[0].protected);
    }

    #[test]
    fn thumbnail_fits_a_block() {
        let frame = RgbImage::from_pixel(640, 480, image::Rgb([200, 30, 30]));
        let mut header = vec![0u8; PMP_HEADER];
        header[..4].copy_from_slice(&[0x10, 0x12, 0x01, 0x00]);
        let b = thumbnail_block(&frame, &header).unwrap();
        assert_eq!(b.len(), PMX_BLOCK);
        let t = formats::pmx_thumbnails(&b);
        assert_eq!(crate::adjust::decode_jpeg(t[0].unwrap()).unwrap().dimensions(), (80, 64));
    }
}
