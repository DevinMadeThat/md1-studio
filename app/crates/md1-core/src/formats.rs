//! Files on an MD1 disc (docs/disc-format.md):
//! * `PSNnnnnn.PMP` photo: 256-byte TLV header + JPEG at 0x100
//! * `NRAnnnnn.PMA` sound: 256-byte header + mono ATRAC1 sound units
//! * `PIDXnnn.PMX` thumbnails: 4096-byte blocks, one per picture
//! * `PIC_INF.PMF` album index: 16-byte picture records from 0x50C

use serde::Serialize;

pub const PMP_HEADER: usize = 0x100;
pub const PMA_HEADER: usize = 0x100;
pub const PMX_BLOCK: usize = 4096;
pub const PIC_INF_RECORDS: usize = 0x50C;

/// The first record of each tag in a PMP header: `[tag8][len8][len bytes]`.
fn tlv(header: &[u8]) -> Vec<(u8, &[u8])> {
    let mut out: Vec<(u8, &[u8])> = Vec::new();
    let mut i = 0;
    while i + 2 <= header.len() {
        let (tag, n) = (header[i], header[i + 1] as usize);
        if tag == 0x00 || tag == 0xFF || n == 0 {
            break;
        }
        let rec = &header[i..(i + 2 + n).min(header.len())];
        if !out.iter().any(|(t, _)| *t == tag) {
            out.push((tag, rec));
        }
        i += 2 + n;
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PhotoInfo {
    /// "FINE" / "STD" (quality byte 0x33 / 0x17) or the raw byte in hex.
    pub quality: String,
    pub width: u16,
    pub height: u16,
    /// APEX Tv × 100 as stored; None when the camera wrote 0x8000 / 0xFFFF.
    pub shutter_tv100: Option<u16>,
    /// Nearest standard speed, e.g. "1/30".
    pub shutter: Option<String>,
    /// Exposure time in seconds (from the APEX value).
    pub exposure_seconds: Option<f64>,
    pub flash: Option<bool>,
    pub jpeg_len: u32,
}

const SHUTTER_BUCKETS: [(f64, &str); 7] = [
    (3.32, "1/7.5"),
    (4.32, "1/15"),
    (5.32, "1/30"),
    (6.23, "1/60"),
    (7.16, "1/100"),
    (8.55, "1/250"),
    (9.55, "1/500"),
];

pub fn photo_info(pmp: &[u8]) -> PhotoInfo {
    let header = &pmp[..pmp.len().min(PMP_HEADER)];
    let recs = tlv(header);
    let get = |t: u8| recs.iter().find(|(tag, _)| *tag == t).map(|(_, r)| *r).unwrap_or(&[]);
    let (img, exp) = (get(0x20), get(0x24));
    let be16 = |b: &[u8], i: usize| b.get(i..i + 2).map(|x| u16::from_be_bytes([x[0], x[1]]));
    let q = img.get(9).copied();
    let tv = be16(exp, 2).filter(|&v| v != 0x8000 && v != 0xFFFF);
    PhotoInfo {
        quality: match q {
            Some(0x33) => "FINE".into(),
            Some(0x17) => "STD".into(),
            Some(x) => format!("0x{x:02x}"),
            None => "?".into(),
        },
        width: be16(img, 2).unwrap_or(0),
        height: be16(img, 4).unwrap_or(0),
        shutter_tv100: tv,
        shutter: tv.map(|v| {
            let tv = v as f64 / 100.0;
            SHUTTER_BUCKETS.iter().find(|(lim, _)| tv < *lim).map(|(_, l)| *l).unwrap_or("1/1000").to_string()
        }),
        exposure_seconds: tv.map(|v| 2f64.powf(-(v as f64) / 100.0)),
        flash: exp.get(0x12).map(|&b| b != 0),
        jpeg_len: header.get(0x0C..0x10).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]])).unwrap_or(0),
    }
}

/// The JPEG inside a PMP (from the first SOI marker to the last EOI).
pub fn extract_jpeg(pmp: &[u8]) -> Option<&[u8]> {
    let start = find(pmp, &[0xFF, 0xD8, 0xFF], 0)?;
    let end = pmp.windows(2).rposition(|w| w == [0xFF, 0xD9]).filter(|&e| e > start);
    Some(match end {
        Some(e) => &pmp[start..e + 2],
        None => &pmp[start..],
    })
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?.windows(needle.len()).position(|w| w == needle).map(|p| p + from)
}

/// Every complete JPEG embedded in a blob (thumbnail files hold one per 4 KB block).
pub fn all_jpegs(data: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut i = 0;
    while let Some(a) = find(data, &[0xFF, 0xD8, 0xFF], i) {
        let Some(b) = find(data, &[0xFF, 0xD9], a) else { break };
        out.push(&data[a..b + 2]);
        i = b + 2;
    }
    out
}

/// The thumbnail in each 4096-byte block of a PMX file, by position (None for a block that
/// doesn't hold a JPEG). Block header: JPEG length (BE32) at 0x0C, JPEG at 0x100.
pub fn pmx_thumbnails(data: &[u8]) -> Vec<Option<&[u8]>> {
    data.chunks(PMX_BLOCK)
        .map(|b| {
            let len = u32::from_be_bytes(b.get(0x0C..0x10)?.try_into().ok()?) as usize;
            let j = b.get(PMP_HEADER..PMP_HEADER + len)?;
            j.starts_with(&[0xFF, 0xD8]).then_some(j)
        })
        .collect()
}

/// Sound file → samples in [-1, 1] at 44.1 kHz mono.
pub fn decode_pma(pma: &[u8]) -> Vec<f32> {
    atrac1::decode_mono(pma.get(PMA_HEADER..).unwrap_or(&[]))
}

/// Duration from the file size alone (512 samples per 212-byte unit).
pub fn pma_seconds(size: u64) -> f64 {
    let units = size.saturating_sub(PMA_HEADER as u64) / atrac1::SU_SIZE as u64;
    units as f64 * atrac1::SU_SAMPLES as f64 / atrac1::SAMPLE_RATE as f64
}

/// 16-bit mono WAV, samples scaled exactly like md1tool (clip, × 32767).
pub fn wav_bytes(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut w = Vec::with_capacity(44 + data_len as usize);
    w.extend_from_slice(b"RIFF");
    w.extend_from_slice(&(36 + data_len).to_le_bytes());
    w.extend_from_slice(b"WAVEfmt ");
    w.extend_from_slice(&16u32.to_le_bytes());
    w.extend_from_slice(&1u16.to_le_bytes()); // PCM
    w.extend_from_slice(&1u16.to_le_bytes()); // mono
    w.extend_from_slice(&rate.to_le_bytes());
    w.extend_from_slice(&(rate * 2).to_le_bytes());
    w.extend_from_slice(&2u16.to_le_bytes());
    w.extend_from_slice(&16u16.to_le_bytes());
    w.extend_from_slice(b"data");
    w.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        w.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    w
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PictureRecord {
    pub album: u16,
    /// PSNnnnnn number.
    pub number: u16,
    pub flags: [u8; 2],
    pub has_sound: bool,
    /// Byte 14 bit 0 (from Sony's code; not yet seen set on a real disc).
    pub protected: bool,
    pub raw: [u8; 16],
}

impl PictureRecord {
    /// How the camera shows the photo turned, in quarter turns clockwise. Stored in byte 5 bits
    /// 2–3 as quarter turns counter-clockwise (confirmed on the camera 2026-10-19: value 1 shows
    /// the photo turned 90° counter-clockwise).
    pub fn rotation_cw(&self) -> u8 {
        (4 - ((self.flags[0] >> 2) & 3)) % 4
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AlbumIndex {
    pub count: u16,
    pub records: Vec<PictureRecord>,
}

pub fn parse_pic_inf(data: &[u8]) -> Option<AlbumIndex> {
    if data.len() < PIC_INF_RECORDS || data[..4] != [0x10, 0x12, 0x01, 0x00] {
        return None;
    }
    let count = u16::from_be_bytes([data[0x104], data[0x105]]);
    let records = data[PIC_INF_RECORDS..]
        .chunks_exact(16)
        .take(count as usize)
        .map(|r| {
            let raw: [u8; 16] = r.try_into().unwrap();
            PictureRecord {
                album: u16::from_be_bytes([r[0], r[1]]),
                number: u16::from_be_bytes([r[2], r[3]]),
                flags: [r[5], r[6]],
                has_sound: r[7] == 1,
                protected: r[14] & 1 == 1,
                raw,
            }
        })
        .collect();
    Some(AlbumIndex { count, records })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_header() {
        let w = wav_bytes(&[0.0, 1.0, -1.0, 2.0], 44100);
        assert_eq!(&w[..4], b"RIFF");
        assert_eq!(w.len(), 44 + 8);
        assert_eq!(i16::from_le_bytes([w[46], w[47]]), 32767);
        assert_eq!(i16::from_le_bytes([w[48], w[49]]), -32767);
        assert_eq!(i16::from_le_bytes([w[50], w[51]]), 32767);
    }

    #[test]
    fn pma_duration() {
        // docs: NRA00018.PMA = 106 752 bytes = 502 units → 5.83 s
        assert!((pma_seconds(106_752) - 5.828).abs() < 0.01);
    }
}
