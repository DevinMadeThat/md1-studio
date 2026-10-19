//! Replays a real camera session recorded by md1tool (the proven Python client) on
//! 2026-10-18: a full mirror of the freshly formatted disc 2 at 115200 baud. The Rust client
//! must send byte-identical frames in the same order, and decode the same files.

use std::collections::VecDeque;
use std::io;
use std::time::Duration;

use md1_core::camera::{Camera, HostId};
use md1_core::import::walk;
use md1_core::transport::Port;

struct Replay {
    /// (host frame we expect, camera bytes that followed it)
    script: VecDeque<(Vec<u8>, Vec<u8>)>,
    pending: VecDeque<u8>,
    sent: usize,
}

fn parse_hex(s: &str) -> Vec<u8> {
    s.split_whitespace().map(|h| u8::from_str_radix(h, 16).unwrap()).collect()
}

impl Replay {
    fn from_log(text: &str) -> Self {
        let mut script: VecDeque<(Vec<u8>, Vec<u8>)> = VecDeque::new();
        for line in text.lines() {
            let mut parts = line.splitn(3, ' ');
            let (_, dir, hex) = (parts.next(), parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            match dir {
                ">" => script.push_back((parse_hex(hex), Vec::new())),
                "<" => script.back_mut().unwrap().1.extend(parse_hex(hex)),
                _ => {}
            }
        }
        Self { script, pending: VecDeque::new(), sent: 0 }
    }
}

impl Port for Replay {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        let (expected, reply) = self.script.pop_front().expect("client sent more frames than the real session");
        assert_eq!(
            md1_core::frame::hex(data),
            md1_core::frame::hex(&expected),
            "frame #{} differs from the real session",
            self.sent
        );
        self.sent += 1;
        self.pending.extend(reply);
        Ok(())
    }
    fn read_some(&mut self, buf: &mut [u8], _: Duration) -> io::Result<usize> {
        let n = buf.len().min(self.pending.len());
        for b in buf.iter_mut().take(n) {
            *b = self.pending.pop_front().unwrap();
        }
        Ok(n)
    }
    fn set_baud(&mut self, _: u32) -> io::Result<()> {
        Ok(())
    }
    fn baud(&self) -> u32 {
        115200
    }
    fn clear_input(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn real_mirror_session_replays_byte_for_byte() {
    let log = include_str!("fixtures/real-mirror-session.log");
    let mut cam = Camera::new(Box::new(Replay::from_log(log)), None);
    cam.timeout = Duration::from_millis(50);

    // md1.py connect(): hello (NAKed once, then accepted), then status.
    let id = cam.hello(HostId::F1, Duration::from_millis(50)).unwrap();
    assert_eq!(id, "SONY     MKY-2000         1.14");
    let st = cam.status().unwrap();
    assert_eq!(st.pictures, 1);

    // md1.py walk(): list every folder, depth first.
    let tree = walk(&mut cam).unwrap();
    let paths: Vec<&str> = tree.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/PIC_MD",
            "/PIC_MD/OV_INF.PMF",
            "/PIC_MD/OV_IDX.PMX",
            "/PIC_MD/PIC00000",
            "/PIC_MD/PIC00000/PIC_INF.PMF",
            "/PIC_MD/PIC00000/PSN00000.PMP",
            "/PIC_MD/PIC00000/PIDX000.PMX",
            "/PIC_MD/PIC00000/NRA00000.PMA",
        ]
    );

    // md1.py read_file() for every file, in walk order.
    let mut sizes = Vec::new();
    for (p, e) in tree.iter().filter(|(_, e)| !e.is_dir) {
        let data = cam.read_file(p, &mut |_| Ok(())).unwrap();
        assert_eq!(data.len(), e.size as usize, "{p}");
        sizes.push(data.len());
        if p.ends_with(".PMP") {
            assert_eq!(&data[0x100..0x103], &[0xFF, 0xD8, 0xFF]);
        }
        if p.ends_with(".PMA") {
            let secs = md1_core::formats::pma_seconds(data.len() as u64);
            assert!((secs - 5.83).abs() < 0.01);
        }
    }
    assert_eq!(sizes, [336, 4096, 1308, 64095, 4096, 106752]);
}
