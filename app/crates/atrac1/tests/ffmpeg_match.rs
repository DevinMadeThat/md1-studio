//! Compare the decoder with FFmpeg's atrac1 decoder (reference output produced with PyAV).

use std::path::{Path, PathBuf};

fn f32s(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// 64 synthetic sound units (random block modes, bit allocations, scale factors; made by
/// tools/make_atrac1_fixture.py) against FFmpeg's float output.
#[test]
fn matches_ffmpeg_fixture() {
    let units = include_bytes!("fixtures/synthetic_units.atrac1");
    let reference = f32s(include_bytes!("fixtures/synthetic_units_ffmpeg.f32"));
    let decoded = atrac1::decode_mono(units);
    assert_eq!(decoded.len(), 64 * atrac1::SU_SAMPLES);
    assert_eq!(decoded.len(), reference.len());
    let max = decoded.iter().zip(&reference).map(|(a, b)| (a - b).abs()).fold(0f32, f32::max);
    assert!(max < 1e-5, "max abs difference {max}");
}

#[test]
fn unit_api() {
    let units = include_bytes!("fixtures/synthetic_units.atrac1");
    let mut dec = atrac1::Decoder::new();
    let a = dec.decode_unit(&units[..atrac1::SU_SIZE]).unwrap();
    assert_eq!(a.len(), atrac1::SU_SAMPLES);
    assert!(dec.decode_unit(&units[..100]).is_err());
    // Bad block-size mode (odd low-band code) is rejected.
    let mut bad = [0u8; atrac1::SU_SIZE];
    bad[0] = 0x40;
    assert!(dec.decode_unit(&bad).is_err());
    // decode_mono replaces invalid units with silence and ignores a trailing partial unit.
    let mut stream = units[..atrac1::SU_SIZE].to_vec();
    stream.extend_from_slice(&bad);
    stream.extend_from_slice(&[0u8; 50]);
    let out = atrac1::decode_mono(&stream);
    assert_eq!(out.len(), 2 * atrac1::SU_SAMPLES);
    assert!(out[atrac1::SU_SAMPLES..].iter().all(|&s| s == 0.0));
}

/// Whole sound files from the camera, against the WAVs md1tool wrote with FFmpeg
/// (`(clip(x) * 32767).astype(int16)`). Skipped when the downloads folder is absent
/// (override its location with MD1_DOWNLOADS).
#[test]
fn full_files_match_md1tool_wavs() {
    let root = std::env::var_os("MD1_DOWNLOADS")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../downloads"));
    let cases = [
        ("disc2/disc/PIC_MD/PIC00001/NRA00018.PMA", "disc2/audio/PIC00001_NRA00018.wav"),
        ("disc2-reformatted/disc/PIC_MD/PIC00000/NRA00000.PMA", "disc2-reformatted/audio/PIC00000_NRA00000.wav"),
    ];
    for (pma, wav) in cases {
        let (pma, wav) = (root.join(pma), root.join(wav));
        if !pma.exists() || !wav.exists() {
            eprintln!("skipping {}: not present", pma.display());
            continue;
        }
        let pma = std::fs::read(pma).unwrap();
        let wav = std::fs::read(wav).unwrap();
        let decoded = atrac1::decode_mono(&pma[256..]);
        eprintln!("checking {} samples", decoded.len());
        // Plain 44-byte PCM WAV header written by Python's wave module.
        let pcm: Vec<i16> = wav[44..].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
        assert_eq!(decoded.len(), pcm.len());
        for (i, (s, r)) in decoded.iter().zip(&pcm).enumerate() {
            let ours = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
            assert!((ours as i32 - *r as i32).abs() <= 1, "sample {i}: {ours} vs {r}");
        }
    }
}
