//! Writes the colour + denoise pipeline's output for a fixed synthetic image as raw RGB, so the
//! frontend's copy (ui/src/look.ts) can be checked against it: tools/check_look_parity.ts.
use image::{Rgb, RgbImage};
use md1_core::adjust::{apply_color, denoise};
use md1_core::edits::{Adjust, AutoLevels};
use std::io::Write;

fn main() {
    let img = RgbImage::from_fn(96, 72, |x, y| {
        let n = (x * 37 + y * 91 + x * y) % 23;
        Rgb([(x * 2 + n) as u8, (y * 3 + n) as u8, ((x + y) + 40 + n) as u8])
    });
    let a = Adjust {
        auto: Some(AutoLevels { lo: [0.02, 0.04, 0.1], hi: [0.8, 0.85, 0.9], gamma: 0.85 }),
        brightness: 0.3,
        contrast: 0.2,
        warmth: -0.4,
        saturation: 0.35,
        denoise: 0.6,
    };
    let mut out = denoise(&img, a.denoise);
    apply_color(&mut out, &a);
    std::io::stdout().write_all(out.as_raw()).unwrap();
}
