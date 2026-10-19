//! Decode raw mono ATRAC1 sound units (or an MD1 `NRA*.PMA` file) to little-endian f32 samples.
//!
//! Usage: cargo run -p atrac1 --example decode -- INPUT OUTPUT.f32 [--pma]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: decode INPUT OUTPUT.f32 [--pma]");
        std::process::exit(2);
    }
    let data = std::fs::read(&args[1]).expect("read input");
    let units = if args.iter().any(|a| a == "--pma") { &data[256..] } else { &data[..] };
    let samples = atrac1::decode_mono(units);
    let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
    std::fs::write(&args[2], bytes).expect("write output");
    eprintln!("{} samples", samples.len());
}
