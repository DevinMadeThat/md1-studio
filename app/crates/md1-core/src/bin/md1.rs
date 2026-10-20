//! Command-line front end to md1-core, mainly for testing against tools/fake_camera.py.
//!
//!   md1 ports
//!   md1 probe   PORT
//!   md1 ls      PORT [FOLDER...]
//!   md1 import  PORT DISC_DIR [NAME]          (the whole disc)
//!   md1 browse  PORT [CACHE_DIR] [DISC_DIR...] (photos on the camera, from thumbnails; with
//!                                               DISC_DIRs, which ones each library folder has)
//!   md1 get     PORT DISC_DIR PSN_PATH...      (chosen photos + their sound + index files)
//!   md1 scan    DISC_DIR            (JSON of albums and photos)
//!   md1 wav     FILE.PMA OUT.wav
//!   md1 export  DISC_DIR OUT_DIR [SCALE]
//!   md1 auto    FILE.PMP            (auto-enhance levels as JSON)

use std::path::Path;
use std::process::ExitCode;

use md1_core::{browse, camera, export, formats, import, library, transport, Error};

fn trace() -> Option<Box<dyn std::io::Write + Send>> {
    let path = std::env::var("MD1_TRACE").ok()?;
    Some(Box::new(std::fs::File::create(path).ok()?))
}

fn connect(port: &str) -> Result<camera::Camera, Error> {
    let (cam, conn) = camera::connect(port, Some(115200), trace(), &mut |m| eprintln!("{m}"))?;
    eprintln!("Connected: {} at {} baud (found at {})", conn.camera_id, conn.baud, conn.found_at_baud);
    Ok(cam)
}

fn run(args: &[String]) -> Result<(), Error> {
    let arg = |i: usize| args.get(i).map(String::as_str).ok_or_else(|| Error::Refused("missing argument".into()));
    match arg(1)? {
        "ports" => {
            for p in transport::list_ports() {
                println!("{}\t{}\t{}", p.path, p.description, if p.likely_adapter { "likely" } else { "" });
            }
        }
        "probe" => {
            let mut cam = connect(arg(2)?)?;
            println!("{:#?}", cam.status()?);
            println!("{:#?}", cam.volume_info()?);
        }
        "ls" => {
            let mut cam = connect(arg(2)?)?;
            let folders: Vec<&str> = if args.len() > 3 { args[3..].iter().map(String::as_str).collect() } else { vec!["/"] };
            for f in folders {
                println!("{f}:");
                for e in cam.list_dir(f)? {
                    println!("  {:<13} {:>8} attr={:04x} #{}", e.name, if e.is_dir { "<DIR>".into() } else { e.size.to_string() }, e.attr, e.number);
                }
            }
        }
        "browse" => {
            let mut cam = connect(arg(2)?)?;
            let d = browse::browse(&mut cam, args.get(3).map(Path::new), &mut |ev| {
                eprintln!("{ev:?}");
                Ok(())
            })?;
            if args.len() > 4 {
                let discs: Vec<library::Disc> = args[4..].iter().filter_map(|p| library::scan_disc(Path::new(p))).collect();
                for (p, m) in d.photos.iter().zip(library::match_camera(&discs, &d)) {
                    println!("{}\t{}", p.id, m.map(|m| format!("{} {}", m.disc_path, m.photo_id)).unwrap_or("-".into()));
                }
            } else {
                println!("{}", serde_json::to_string_pretty(&d).unwrap());
            }
            let _ = cam.disconnect();
        }
        "import" | "get" => {
            let mut cam = connect(arg(2)?)?;
            let only = (arg(1)? == "get").then(|| args[4..].iter().cloned().collect());
            let name = if only.is_some() { String::new() } else { args.get(4).cloned().unwrap_or_default() };
            let opts = import::ImportOptions { disc_dir: arg(3)?.into(), name, only };
            let mut last = String::new();
            import::import_disc(&mut cam, &opts, None, &mut |ev| {
                let line = match &ev {
                    import::ImportEvent::Progress { .. } => return Ok(()),
                    other => format!("{other:?}"),
                };
                if line != last {
                    eprintln!("{line}");
                    last = line;
                }
                Ok(())
            })?;
            let _ = cam.disconnect();
        }
        "scan" => {
            let d = library::scan_disc(Path::new(arg(2)?)).ok_or_else(|| Error::Protocol("not a disc folder".into()))?;
            println!("{}", serde_json::to_string_pretty(&d).unwrap());
        }
        "auto" => {
            let pmp = std::fs::read(arg(2)?)?;
            let img = formats::extract_jpeg(&pmp).and_then(md1_core::adjust::decode_jpeg).ok_or_else(|| Error::Protocol("no JPEG".into()))?;
            println!("{}", serde_json::to_string(&md1_core::adjust::auto_levels(&img)).unwrap());
        }
        "wav" => {
            let s = formats::decode_pma(&std::fs::read(arg(2)?)?);
            std::fs::write(arg(3)?, formats::wav_bytes(&s, atrac1::SAMPLE_RATE))?;
        }
        "export" => {
            let d = library::scan_disc(Path::new(arg(2)?)).ok_or_else(|| Error::Protocol("not a disc folder".into()))?;
            let photos: Vec<(&str, &library::Photo)> = d.albums.iter().flat_map(|a| a.photos.iter()).map(|p| (d.name.as_str(), p)).collect();
            let scale: f64 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(1.0);
            let r = export::export_photos(&photos, Path::new(arg(3)?), &export::ExportOptions { scale, ..Default::default() })?;
            println!("{} files written, {} already there", r.written.len(), r.already_there);
        }
        _ => return Err(Error::Refused("unknown command".into())),
    }
    Ok(())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}
