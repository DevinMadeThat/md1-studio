//! ATRAC1 (MiniDisc) audio decoder.
//!
//! A Rust port of FFmpeg's ATRAC1 decoder (libavcodec/atrac1.c, atrac1data.h, atrac.c):
//!   Copyright (c) 2008 Maxim Poliakovski
//!   Copyright (c) 2008 Benjamin Larsson
//! FFmpeg is free software licensed under the GNU Lesser General Public License,
//! version 2.1 or later. This port is distributed under the same license
//! (LGPL-2.1-or-later); see https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html.
//!
//! Output matches FFmpeg's float output (same tables, same transform scaling, same
//! QMF synthesis); only the IMDCT is computed directly instead of with an FFT.
//!
//! The DSC-MD1 stores sound recorded with a photo as `NRAnnnnn.PMA`: a 256-byte header
//! followed by mono ATRAC1 sound units (212 bytes = 512 samples at 44.1 kHz).

use std::f64::consts::PI;
use std::fmt;

/// Bytes in one sound unit (one channel).
pub const SU_SIZE: usize = 212;
/// Samples produced by one sound unit.
pub const SU_SAMPLES: usize = 512;
pub const SAMPLE_RATE: u32 = 44100;

const MAX_BFU: usize = 52;
const SU_MAX_BITS: usize = SU_SIZE * 8;
const QMF_BANDS: usize = 3;
const HIGH_BAND: usize = 2;

#[derive(Debug)]
pub enum Error {
    /// The sound unit is malformed (bad block-size mode, or its bit allocation overflows the unit).
    InvalidUnit,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidUnit => write!(f, "invalid ATRAC1 sound unit"),
        }
    }
}

impl std::error::Error for Error {}

// --- tables (atrac1data.h) ---

const BFU_AMOUNT_TAB1: [usize; 8] = [20, 28, 32, 36, 40, 44, 48, 52];
const BFU_AMOUNT_TAB2: [usize; 4] = [0, 112, 176, 208];
const BFU_AMOUNT_TAB3: [usize; 8] = [0, 24, 36, 48, 72, 108, 132, 156];

/// Number of BFUs in each QMF band.
const BFU_BANDS_T: [usize; 4] = [0, 20, 36, 52];

/// Number of spectral lines in each BFU.
const SPECS_PER_BFU: [usize; 52] = [
    8, 8, 8, 8, 4, 4, 4, 4, 8, 8, 8, 8, 6, 6, 6, 6, 6, 6, 6, 6, // low band
    6, 6, 6, 6, 7, 7, 7, 7, 9, 9, 9, 9, 10, 10, 10, 10, // middle band
    12, 12, 12, 12, 12, 12, 12, 12, 20, 20, 20, 20, 20, 20, 20, 20, // high band
];

/// Start position of each BFU in the MDCT spectrum for the long mode.
const BFU_START_LONG: [usize; 52] = [
    0, 8, 16, 24, 32, 36, 40, 44, 48, 56, 64, 72, 80, 86, 92, 98, 104, 110, 116, 122, //
    128, 134, 140, 146, 152, 159, 166, 173, 180, 189, 198, 207, 216, 226, 236, 246, //
    256, 268, 280, 292, 304, 316, 328, 340, 352, 372, 392, 412, 432, 452, 472, 492,
];

/// Start position of each BFU in the MDCT spectrum for the short mode.
const BFU_START_SHORT: [usize; 52] = [
    0, 32, 64, 96, 8, 40, 72, 104, 12, 44, 76, 108, 20, 52, 84, 116, 26, 58, 90, 122, //
    128, 160, 192, 224, 134, 166, 198, 230, 141, 173, 205, 237, 150, 182, 214, 246, //
    256, 288, 320, 352, 384, 416, 448, 480, 268, 300, 332, 364, 396, 428, 460, 492,
];

/// Size of the transform in samples in the long mode for each QMF band.
const SAMPLES_PER_BAND: [usize; 3] = [128, 128, 256];
const MDCT_LONG_NBITS: [u32; 3] = [7, 7, 8];

// --- tables (atrac.c) ---

#[allow(clippy::excessive_precision)] // kept exactly as written in FFmpeg
const QMF_48TAP_HALF: [f32; 24] = [
    -0.00001461907, -0.00009205479, -0.000056157569, 0.00030117269, //
    0.0002422519, -0.00085293897, -0.0005205574, 0.0020340169, //
    0.00078333891, -0.0042153862, -0.00075614988, 0.0078402944, //
    -0.000061169922, -0.01344162, 0.0024626821, 0.021736089, //
    -0.007801671, -0.034090221, 0.01880949, 0.054326009, //
    -0.043596379, -0.099384367, 0.13207909, 0.46424159,
];

struct Tables {
    sf: [f32; 64],
    qmf_window: [f32; 48],
    sine_32: [f32; 32],
    /// IMDCT cosine tables for 32, 128 and 256 coefficients.
    imdct: [Vec<f32>; 3],
}

impl Tables {
    fn new() -> Self {
        let mut sf = [0f32; 64];
        for (i, v) in sf.iter_mut().enumerate() {
            *v = 2f64.powf((i as f64 - 15.0) / 3.0) as f32;
        }
        let mut qmf_window = [0f32; 48];
        for i in 0..24 {
            let s = (QMF_48TAP_HALF[i] as f64 * 2.0) as f32;
            qmf_window[i] = s;
            qmf_window[47 - i] = s;
        }
        let mut sine_32 = [0f32; 32];
        for (i, v) in sine_32.iter_mut().enumerate() {
            *v = ((i as f64 + 0.5) * (PI / (2.0 * 32.0))).sin() as f32;
        }
        Tables { sf, qmf_window, sine_32, imdct: [imdct_table(32), imdct_table(128), imdct_table(256)] }
    }
}

/// Cosines for a half-length inverse MDCT with `len` coefficients and `len` outputs.
///
/// The full IMDCT of size N = 2·len is
///   y[n] = Σ_k X[k] · cos(2π/N · (n + ½ + N/4) · (k + ½)),  n = 0..N,
/// and the half transform returns y[N/4 .. 3N/4] scaled by 1/32768. FFmpeg asks its AVTX
/// inverse MDCT for scale -1/32768; AVTX's transform has the opposite sign convention to the
/// formula above, so the net factor is +1/32768 (verified sample-for-sample against FFmpeg).
fn imdct_table(len: usize) -> Vec<f32> {
    let n_full = 2 * len;
    let scale = 1.0 / 32768.0;
    let mut t = vec![0f32; len * len];
    for o in 0..len {
        let n = o + n_full / 4;
        for k in 0..len {
            let a = 2.0 * PI / n_full as f64 * (n as f64 + 0.5 + n_full as f64 / 4.0) * (k as f64 + 0.5);
            t[o * len + k] = (a.cos() * scale) as f32;
        }
    }
    t
}

fn tables() -> &'static Tables {
    static T: std::sync::OnceLock<Tables> = std::sync::OnceLock::new();
    T.get_or_init(Tables::new)
}

/// MSB-first bit reader over one sound unit.
struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl Bits<'_> {
    fn get(&mut self, n: u32) -> u32 {
        let mut v = 0u32;
        for _ in 0..n {
            let byte = self.data.get(self.pos / 8).copied().unwrap_or(0);
            v = (v << 1) | ((byte >> (7 - (self.pos % 8))) & 1) as u32;
            self.pos += 1;
        }
        v
    }

    fn get_signed(&mut self, n: u32) -> i32 {
        let v = self.get(n) as i32;
        (v << (32 - n)) >> (32 - n)
    }
}

/// Decoder state for one mono channel.
pub struct Decoder {
    log2_block_count: [usize; QMF_BANDS],
    /// IMDCT output of the current and the previous unit (overlap source).
    spectrum: [[f32; SU_SAMPLES]; 2],
    fst_qmf_delay: [f32; 46],
    snd_qmf_delay: [f32; 46],
    last_qmf_delay: [f32; 256 + 39],
    spec: [f32; SU_SAMPLES],
    bands: [[f32; 256]; 3],
}

impl Default for Decoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Decoder {
    pub fn new() -> Self {
        Decoder {
            log2_block_count: [0; QMF_BANDS],
            spectrum: [[0.0; SU_SAMPLES]; 2],
            fst_qmf_delay: [0.0; 46],
            snd_qmf_delay: [0.0; 46],
            last_qmf_delay: [0.0; 256 + 39],
            spec: [0.0; SU_SAMPLES],
            bands: [[0.0; 256]; 3],
        }
    }

    /// Decode one 212-byte sound unit into 512 samples in [-1, 1] (FFmpeg float output).
    pub fn decode_unit(&mut self, su: &[u8]) -> Result<[f32; SU_SAMPLES], Error> {
        if su.len() < SU_SIZE {
            return Err(Error::InvalidUnit);
        }
        let mut gb = Bits { data: &su[..SU_SIZE], pos: 0 };
        self.parse_bsm(&mut gb)?;
        self.unpack_dequant(&mut gb)?;
        self.imdct_block();
        let mut out = [0f32; SU_SAMPLES];
        self.subband_synthesis(&mut out);
        Ok(out)
    }

    /// Block size mode byte.
    fn parse_bsm(&mut self, gb: &mut Bits) -> Result<(), Error> {
        let mut cnt = [0usize; QMF_BANDS];
        for c in cnt.iter_mut().take(2) {
            // low and mid band
            let tmp = gb.get(2);
            if tmp & 1 != 0 {
                return Err(Error::InvalidUnit);
            }
            *c = 2 - tmp as usize;
        }
        let tmp = gb.get(2); // high band
        if tmp != 0 && tmp != 3 {
            return Err(Error::InvalidUnit);
        }
        cnt[HIGH_BAND] = 3 - tmp as usize;
        gb.get(2);
        self.log2_block_count = cnt;
        Ok(())
    }

    fn unpack_dequant(&mut self, gb: &mut Bits) -> Result<(), Error> {
        let t = tables();
        let num_bfus = BFU_AMOUNT_TAB1[gb.get(3) as usize];
        let mut bits_used = num_bfus * 10 + 32 + BFU_AMOUNT_TAB2[gb.get(2) as usize]
            + (BFU_AMOUNT_TAB3[gb.get(3) as usize] << 1);

        let mut idwls = [0u32; MAX_BFU];
        let mut idsfs = [0usize; MAX_BFU];
        for w in idwls.iter_mut().take(num_bfus) {
            *w = gb.get(4);
        }
        for s in idsfs.iter_mut().take(num_bfus) {
            *s = gb.get(6) as usize;
        }

        let mut spec = [0f32; SU_SAMPLES];
        for band in 0..QMF_BANDS {
            for bfu in BFU_BANDS_T[band]..BFU_BANDS_T[band + 1] {
                let num_specs = SPECS_PER_BFU[bfu];
                let word_len = (idwls[bfu] != 0) as u32 + idwls[bfu];
                let scale_factor = t.sf[idsfs[bfu]];
                bits_used += word_len as usize * num_specs;
                if bits_used > SU_MAX_BITS {
                    return Err(Error::InvalidUnit);
                }
                let pos = if self.log2_block_count[band] != 0 {
                    BFU_START_SHORT[bfu]
                } else {
                    BFU_START_LONG[bfu]
                };
                if word_len != 0 {
                    let max_quant = 1.0f32 / ((1i32 << (word_len - 1)) - 1) as f32;
                    for i in 0..num_specs {
                        spec[pos + i] = gb.get_signed(word_len) as f32 * scale_factor * max_quant;
                    }
                }
            }
        }
        self.spec = spec;
        Ok(())
    }

    fn imdct_block(&mut self) {
        let t = tables();
        let (mut ref_pos, mut pos) = (0usize, 0usize);
        let [cur, prev] = &mut self.spectrum;
        for band in 0..QMF_BANDS {
            let band_samples = SAMPLES_PER_BAND[band];
            let log2_count = self.log2_block_count[band];
            let num_blocks = 1usize << log2_count;
            let (block_size, nbits) = if num_blocks == 1 {
                (band_samples >> log2_count, MDCT_LONG_NBITS[band] - log2_count as u32)
            } else {
                (32, 5)
            };

            let mut start_pos = 0usize;
            // Overlap source: last 16 samples of this band in the previous unit, then of the previous block.
            let mut prev_tail = [0f32; 16];
            prev_tail.copy_from_slice(&prev[ref_pos + band_samples - 16..ref_pos + band_samples]);
            for _ in 0..num_blocks {
                let size = 1usize << nbits;
                let spec = &mut self.spec[pos..pos + size];
                if band != 0 {
                    spec.reverse(); // high QMF bands are spectrally inverted
                }
                let out = &mut cur[ref_pos + start_pos..ref_pos + start_pos + size];
                imdct_half(&t.imdct[match nbits { 5 => 0, 7 => 1, _ => 2 }], spec, out);

                vector_fmul_window(
                    &mut self.bands[band][start_pos..start_pos + 32],
                    &prev_tail,
                    &out[..16],
                    &t.sine_32,
                );
                prev_tail.copy_from_slice(&out[16..32]);
                start_pos += block_size;
                pos += block_size;
            }

            if num_blocks == 1 {
                // FFmpeg copies 240 floats here; only band_samples - 32 of them are used.
                let n = band_samples - 32;
                self.bands[band][32..32 + n].copy_from_slice(&cur[ref_pos + 16..ref_pos + 16 + n]);
            }
            ref_pos += band_samples;
        }
        self.spectrum.swap(0, 1);
    }

    fn subband_synthesis(&mut self, out: &mut [f32; SU_SAMPLES]) {
        let t = tables();
        let mut temp = [0f32; 256];
        // combine low and middle bands
        iqmf(&self.bands[0], &self.bands[1], 128, &mut temp, &mut self.fst_qmf_delay, &t.qmf_window);

        // delay the signal of the high band by 39 samples
        self.last_qmf_delay.copy_within(256..256 + 39, 0);
        self.last_qmf_delay[39..39 + 256].copy_from_slice(&self.bands[2]);

        // combine (low + middle) and high bands
        iqmf(&temp, &self.last_qmf_delay, 256, out, &mut self.snd_qmf_delay, &t.qmf_window);
    }
}

fn imdct_half(table: &[f32], input: &[f32], out: &mut [f32]) {
    let len = input.len();
    for (o, y) in out.iter_mut().enumerate() {
        let row = &table[o * len..(o + 1) * len];
        let mut s = 0f64;
        for k in 0..len {
            s += input[k] as f64 * row[k] as f64;
        }
        *y = s as f32;
    }
}

/// FFmpeg's vector_fmul_window with len = 16: overlap-add two 16-sample halves into 32 samples.
fn vector_fmul_window(dst: &mut [f32], src0: &[f32], src1: &[f32], win: &[f32; 32]) {
    let len = 16;
    for i in 0..len {
        let j = 2 * len - 1 - i; // mirrored index into dst/win
        let s0 = src0[i];
        let s1 = src1[len - 1 - i];
        let wi = win[i];
        let wj = win[j];
        dst[i] = s0 * wj - s1 * wi;
        dst[j] = s0 * wi + s1 * wj;
    }
}

/// FFmpeg's ff_atrac_iqmf: combine two half-rate bands into one signal of 2·n_in samples.
fn iqmf(inlo: &[f32], inhi: &[f32], n_in: usize, out: &mut [f32], delay: &mut [f32; 46], window: &[f32; 48]) {
    let mut temp = [0f32; 512 + 46];
    temp[..46].copy_from_slice(delay);
    let p3 = &mut temp[46..];
    let mut i = 0;
    while i < n_in {
        p3[2 * i] = inlo[i] + inhi[i];
        p3[2 * i + 1] = inlo[i] - inhi[i];
        p3[2 * i + 2] = inlo[i + 1] + inhi[i + 1];
        p3[2 * i + 3] = inlo[i + 1] - inhi[i + 1];
        i += 2;
    }
    for j in 0..n_in {
        let p1 = &temp[2 * j..2 * j + 48];
        let (mut s1, mut s2) = (0f32, 0f32);
        let mut i = 0;
        while i < 48 {
            s1 += p1[i] * window[i];
            s2 += p1[i + 1] * window[i + 1];
            i += 2;
        }
        out[2 * j] = s2;
        out[2 * j + 1] = s1;
    }
    delay.copy_from_slice(&temp[n_in * 2..n_in * 2 + 46]);
}

/// Decode back-to-back mono sound units (trailing partial unit ignored). Invalid units
/// produce 512 samples of silence and decoding continues.
pub fn decode_mono(units: &[u8]) -> Vec<f32> {
    let mut dec = Decoder::new();
    let mut out = Vec::with_capacity(units.len() / SU_SIZE * SU_SAMPLES);
    for su in units.chunks_exact(SU_SIZE) {
        match dec.decode_unit(su) {
            Ok(samples) => out.extend_from_slice(&samples),
            Err(_) => out.extend_from_slice(&[0.0; SU_SAMPLES]),
        }
    }
    out
}
