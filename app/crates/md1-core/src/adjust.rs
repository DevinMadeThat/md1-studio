//! Rendering a photo's "look": noise cleanup → colour → geometry, then optional upscaling.
//!
//! The same formulas are implemented in the app's frontend (`ui/src/look.ts`) for the live
//! preview; keep the two in step. All colour work is on 0–1 sRGB values.
//!
//! * **Denoise** (0–1): 5×5 bilateral filter, spatial σ 1.5 px, range σ = 3 + 27·strength
//!   (in 0–255 units, distance = RMS of the R, G, B differences). Smooths JPEG blocking and
//!   sensor noise while keeping edges.
//! * **Auto levels**: per-channel black/white points (stretch, which also neutralises colour
//!   casts) then a midtone gamma, both chosen once by [`auto_levels`].
//! * **Warmth** w: R × (1 + 0.12w), B × (1 − 0.12w).
//! * **Brightness** b: v^(2^(−1.2b)) — lifts or darkens midtones, keeps black and white.
//! * **Contrast** c: 0.5 + (v − 0.5)(1 + c).
//! * **Saturation** s: Y + (v − Y)(1 + s), Y = 0.299R + 0.587G + 0.114B.
//! * **Geometry**: straighten (rotate about the centre and scale to fill, so no blank corners),
//!   flip horizontally, rotate by 90° steps, crop (fractions of the result).

use image::{imageops, Rgb, RgbImage};

use crate::edits::{Adjust, AutoLevels, PhotoEdits};

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

/// Black/white points at the 0.4 % / 99.6 % percentiles of each channel, half-way between the
/// per-channel values (which neutralise a colour cast) and the shared ones (which keep it), so a
/// lamp-lit room stays warm; then a gentle gamma that brings the mean brightness towards 0.42.
/// Ranges are limited so a scene that really is mostly one colour isn't over-stretched.
pub fn auto_levels(img: &RgbImage) -> AutoLevels {
    let mut hist = [[0u32; 256]; 3];
    for p in img.pixels() {
        for c in 0..3 {
            hist[c][p[c] as usize] += 1;
        }
    }
    let n = (img.width() * img.height()).max(1) as f64;
    let pct = |h: &[u32; 256], q: f64| {
        let target = q * n;
        let mut acc = 0.0;
        for (i, &v) in h.iter().enumerate() {
            acc += v as f64;
            if acc >= target {
                return i as f64 / 255.0;
            }
        }
        1.0
    };
    const CAST_CORRECTION: f64 = 0.5;
    let lo_c: Vec<f64> = (0..3).map(|c| pct(&hist[c], 0.004)).collect();
    let hi_c: Vec<f64> = (0..3).map(|c| pct(&hist[c], 0.996)).collect();
    let lo_all = lo_c.iter().cloned().fold(1.0, f64::min);
    let hi_all = hi_c.iter().cloned().fold(0.0, f64::max);
    let mut lo = [0.0; 3];
    let mut hi = [1.0; 3];
    for c in 0..3 {
        lo[c] = (lo_all + (lo_c[c] - lo_all) * CAST_CORRECTION).min(0.35);
        hi[c] = (hi_all + (hi_c[c] - hi_all) * CAST_CORRECTION).max(lo[c] + 0.3).min(1.0);
    }
    // Mean luminance after the stretch.
    let mut sum = 0.0;
    for p in img.pixels() {
        let v: Vec<f64> = (0..3).map(|c| clamp01((p[c] as f64 / 255.0 - lo[c]) / (hi[c] - lo[c]))).collect();
        sum += 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
    }
    let mean = (sum / n).clamp(0.02, 0.98);
    let gamma = ((0.42f64).ln() / mean.ln()).clamp(0.75, 1.35);
    let r = |x: f64| (x * 1000.0).round() / 1000.0;
    AutoLevels { lo: lo.map(r), hi: hi.map(r), gamma: r(gamma) }
}

/// Per-channel lookup tables for everything except saturation.
pub fn color_luts(a: &Adjust) -> [[u8; 256]; 3] {
    let mut lut = [[0u8; 256]; 3];
    let warm = [1.0 + 0.12 * a.warmth, 1.0, 1.0 - 0.12 * a.warmth];
    let g = 2f64.powf(-1.2 * a.brightness);
    for c in 0..3 {
        for x in 0..256 {
            let mut v = x as f64 / 255.0;
            if let Some(l) = &a.auto {
                v = clamp01((v - l.lo[c]) / (l.hi[c] - l.lo[c]).max(0.05));
                v = v.powf(l.gamma);
            }
            v = clamp01(v * warm[c]);
            v = v.powf(g);
            v = clamp01(0.5 + (v - 0.5) * (1.0 + a.contrast));
            lut[c][x] = (v * 255.0).round() as u8;
        }
    }
    lut
}

pub fn apply_color(img: &mut RgbImage, a: &Adjust) {
    let lut = color_luts(a);
    let s = 1.0 + a.saturation;
    for p in img.pixels_mut() {
        let v = [lut[0][p[0] as usize] as f64, lut[1][p[1] as usize] as f64, lut[2][p[2] as usize] as f64];
        if a.saturation == 0.0 {
            *p = Rgb([v[0] as u8, v[1] as u8, v[2] as u8]);
        } else {
            let y = 0.299 * v[0] + 0.587 * v[1] + 0.114 * v[2];
            let f = |x: f64| (y + (x - y) * s).clamp(0.0, 255.0).round() as u8;
            *p = Rgb([f(v[0]), f(v[1]), f(v[2])]);
        }
    }
}

pub fn denoise(img: &RgbImage, strength: f64) -> RgbImage {
    if strength <= 0.0 {
        return img.clone();
    }
    let (w, h) = (img.width() as i64, img.height() as i64);
    let sr = 3.0 + 27.0 * strength.min(1.0);
    // Range weights by squared distance (0..=65025), spatial weights for the 5×5 window.
    let range: Vec<f64> = (0..=65025).map(|d2| (-(d2 as f64) / (2.0 * sr * sr)).exp()).collect();
    let mut spatial = [[0.0; 5]; 5];
    for (dy, row) in spatial.iter_mut().enumerate() {
        for (dx, s) in row.iter_mut().enumerate() {
            let (x, y) = (dx as f64 - 2.0, dy as f64 - 2.0);
            *s = (-(x * x + y * y) / (2.0 * 1.5 * 1.5)).exp();
        }
    }
    let src = img.as_raw();
    let mut out = RgbImage::new(img.width(), img.height());
    let dst: &mut [u8] = &mut out;
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 3) as usize;
            let (r0, g0, b0) = (src[i] as i64, src[i + 1] as i64, src[i + 2] as i64);
            let (mut sr_, mut sg, mut sb, mut sw) = (0.0, 0.0, 0.0, 0.0);
            for dy in -2..=2i64 {
                let yy = (y + dy).clamp(0, h - 1);
                for dx in -2..=2i64 {
                    let xx = (x + dx).clamp(0, w - 1);
                    let j = ((yy * w + xx) * 3) as usize;
                    let (r, g, b) = (src[j] as i64, src[j + 1] as i64, src[j + 2] as i64);
                    let d2 = ((r - r0).pow(2) + (g - g0).pow(2) + (b - b0).pow(2)) / 3;
                    let wgt = spatial[(dy + 2) as usize][(dx + 2) as usize] * range[d2 as usize];
                    sr_ += wgt * r as f64;
                    sg += wgt * g as f64;
                    sb += wgt * b as f64;
                    sw += wgt;
                }
            }
            dst[i] = (sr_ / sw).round() as u8;
            dst[i + 1] = (sg / sw).round() as u8;
            dst[i + 2] = (sb / sw).round() as u8;
        }
    }
    out
}

/// Scale needed after rotating a w×h image by `deg` so it still covers the w×h frame.
pub fn straighten_scale(w: f64, h: f64, deg: f64) -> f64 {
    let a = deg.to_radians().abs();
    ((w * a.cos() + h * a.sin()) / w).max((w * a.sin() + h * a.cos()) / h)
}

fn straighten(img: &RgbImage, deg: f64) -> RgbImage {
    let (w, h) = (img.width() as f64, img.height() as f64);
    let s = straighten_scale(w, h, deg);
    let (sin, cos) = deg.to_radians().sin_cos();
    let (cx, cy) = (w / 2.0, h / 2.0);
    let mut out = RgbImage::new(img.width(), img.height());
    for (x, y, p) in out.enumerate_pixels_mut() {
        // Output offset from centre → source position (inverse rotation, inverse scale).
        let (dx, dy) = ((x as f64 + 0.5 - cx) / s, (y as f64 + 0.5 - cy) / s);
        let sx = cos * dx + sin * dy + cx - 0.5;
        let sy = -sin * dx + cos * dy + cy - 0.5;
        *p = bilinear(img, sx, sy);
    }
    out
}

fn bilinear(img: &RgbImage, x: f64, y: f64) -> Rgb<u8> {
    let (w, h) = (img.width() as i64, img.height() as i64);
    let (x0, y0) = (x.floor(), y.floor());
    let (fx, fy) = (x - x0, y - y0);
    let px = |xx: i64, yy: i64| img.get_pixel(xx.clamp(0, w - 1) as u32, yy.clamp(0, h - 1) as u32);
    let (x0, y0) = (x0 as i64, y0 as i64);
    let (a, b, c, d) = (px(x0, y0), px(x0 + 1, y0), px(x0, y0 + 1), px(x0 + 1, y0 + 1));
    let mut o = [0u8; 3];
    for k in 0..3 {
        let top = a[k] as f64 * (1.0 - fx) + b[k] as f64 * fx;
        let bot = c[k] as f64 * (1.0 - fx) + d[k] as f64 * fx;
        o[k] = (top * (1.0 - fy) + bot * fy).round() as u8;
    }
    Rgb(o)
}

/// Apply every edit that changes pixels. `scale` > 1 upscales the result (Lanczos + a light
/// sharpen) for bigger exports.
pub fn render(original: &RgbImage, e: &PhotoEdits, scale: f64) -> RgbImage {
    let adj = e.adjust.unwrap_or_default();
    let mut img = denoise(original, adj.denoise);
    if !adj.is_identity() {
        apply_color(&mut img, &adj);
    }
    if e.straighten != 0.0 {
        img = straighten(&img, e.straighten);
    }
    if e.flip {
        imageops::flip_horizontal_in_place(&mut img);
    }
    img = match e.rotation {
        90 => imageops::rotate90(&img),
        180 => imageops::rotate180(&img),
        270 => imageops::rotate270(&img),
        _ => img,
    };
    if let Some(c) = e.crop {
        let (w, h) = (img.width() as f64, img.height() as f64);
        let x = (c.x.clamp(0.0, 1.0) * w).round() as u32;
        let y = (c.y.clamp(0.0, 1.0) * h).round() as u32;
        let cw = ((c.w * w).round() as u32).clamp(1, img.width() - x.min(img.width() - 1));
        let ch = ((c.h * h).round() as u32).clamp(1, img.height() - y.min(img.height() - 1));
        img = imageops::crop_imm(&img, x, y, cw, ch).to_image();
    }
    if scale > 1.0 {
        let (w, h) = ((img.width() as f64 * scale).round() as u32, (img.height() as f64 * scale).round() as u32);
        img = imageops::resize(&img, w, h, imageops::FilterType::Lanczos3);
        img = imageops::unsharpen(&img, 0.6 * scale as f32, 2);
    }
    img
}

pub fn decode_jpeg(jpeg: &[u8]) -> Option<RgbImage> {
    image::load_from_memory_with_format(jpeg, image::ImageFormat::Jpeg).ok().map(|i| i.to_rgb8())
}

pub fn encode_jpeg(img: &RgbImage, quality: u8) -> Vec<u8> {
    let mut out = Vec::new();
    let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    enc.encode_image(img).expect("JPEG encoding to memory cannot fail");
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edits::{Crop, PhotoEdits};

    fn gradient() -> RgbImage {
        RgbImage::from_fn(64, 48, |x, y| Rgb([(40 + x * 2) as u8, (30 + y * 3) as u8, 90]))
    }

    #[test]
    fn identity_look_keeps_pixels() {
        let img = gradient();
        assert_eq!(render(&img, &PhotoEdits::default(), 1.0), img);
    }

    #[test]
    fn geometry_sizes() {
        let img = gradient();
        let e = PhotoEdits {
            rotation: 90,
            crop: Some(Crop { x: 0.25, y: 0.0, w: 0.5, h: 1.0 }),
            straighten: 3.0,
            flip: true,
            ..Default::default()
        };
        let out = render(&img, &e, 2.0);
        assert_eq!((out.width(), out.height()), (48, 128)); // rotated 48×64, half width, ×2
    }

    #[test]
    fn auto_levels_stretch_a_dim_image() {
        let img = RgbImage::from_fn(50, 50, |x, y| Rgb([(20 + x) as u8, (25 + y) as u8, 30]));
        let l = auto_levels(&img);
        // Channels span 0.08–0.27 (R), 0.10–0.29 (G), 0.12 (B): black points move up; white
        // points are held at least 0.3 above them so a narrow channel isn't over-stretched.
        assert!(l.lo[0] > 0.07 && l.hi[0] - l.lo[0] >= 0.299, "{l:?}");
        assert!(l.gamma < 1.0, "a dim image is brightened: {l:?}");
        let mut adj = Adjust { auto: Some(l), ..Default::default() };
        let mut out = img.clone();
        apply_color(&mut out, &adj);
        let max_r = out.pixels().map(|p| p[0]).max().unwrap();
        assert!(max_r > 180, "stretched to {max_r}");
        adj.auto = None;
        assert!(adj.is_identity());
    }

    #[test]
    fn denoise_flattens_noise_keeps_edges() {
        let img = RgbImage::from_fn(40, 40, |x, y| {
            let n = ((x * 7 + y * 13) % 5) as u8; // small noise
            if x < 20 { Rgb([60 + n, 60 + n, 60 + n]) } else { Rgb([200 + n, 200 + n, 200 + n]) }
        });
        let out = denoise(&img, 1.0);
        let spread = |im: &RgbImage| {
            let v: Vec<u8> = (5..15).map(|y| im.get_pixel(8, y)[0]).collect();
            v.iter().max().unwrap() - v.iter().min().unwrap()
        };
        assert!(spread(&out) < spread(&img));
        assert!(out.get_pixel(17, 20)[0] < 80 && out.get_pixel(22, 20)[0] > 180, "edge blurred");
    }
}
