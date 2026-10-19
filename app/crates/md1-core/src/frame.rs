//! Serial framing: `C0 <addr> <payload> <checksum> C1`, with `7D` escaping.
//!
//! checksum = (0x100 - (addr + sum(payload))) & 0xFF. Any C0 / C1 / 7D inside the frame is sent
//! as `7D, byte ^ 0x20`. See docs/protocol.md "Framing".

pub const BOFRAME: u8 = 0xC0;
pub const EOFRAME: u8 = 0xC1;
pub const ESC: u8 = 0x7D;

/// Host frame addresses, one step per frame.
pub const SEND_ADDR: [u8; 8] = [0x00, 0x22, 0x44, 0x66, 0x88, 0xAA, 0xCC, 0xEE];
/// Address of the camera's "out of sequence" NAK (empty payload).
pub const NAK_ADDR: u8 = 0x83;
/// Link-level abort frame (address 85, no payload).
pub const ABORT_FRAME: [u8; 4] = [0xC0, 0x85, 0x7B, 0xC1];

pub fn checksum(addr: u8, payload: &[u8]) -> u8 {
    let sum = payload.iter().fold(addr as u32, |s, &b| s + b as u32);
    (0x100 - (sum & 0xFF)) as u8
}

pub fn encode(addr: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 8);
    out.push(BOFRAME);
    out.push(addr);
    for &b in payload.iter().chain(std::iter::once(&checksum(addr, payload))) {
        if b == BOFRAME || b == EOFRAME || b == ESC {
            out.push(ESC);
            out.push(b ^ 0x20);
        } else {
            out.push(b);
        }
    }
    out.push(EOFRAME);
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub addr: u8,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn is_nak(&self) -> bool {
        self.addr == NAK_ADDR && self.payload.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    Short,
    Checksum,
}

/// Incremental frame parser. Bytes before a `C0` are ignored, so line noise and replies sent at
/// the wrong baud rate are skipped until a frame starts.
#[derive(Default)]
pub struct Decoder {
    pending: Vec<u8>,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }

    pub fn extend(&mut self, data: &[u8]) {
        self.pending.extend_from_slice(data);
    }

    /// The next complete frame, if one has arrived. A `C0` inside an unfinished frame restarts it.
    pub fn next_frame(&mut self) -> Option<Result<Frame, DecodeError>> {
        let Some(first) = self.pending.iter().position(|&b| b == BOFRAME) else {
            self.pending.clear();
            return None;
        };
        self.pending.drain(..first);
        let end = self.pending.iter().position(|&b| b == EOFRAME)?;
        let start = self.pending[..end].iter().rposition(|&b| b == BOFRAME).unwrap_or(0);
        let raw = self.pending[start + 1..end].to_vec();
        self.pending.drain(..=end);
        Some(unescape_and_check(&raw))
    }

    /// Convenience for tests: feed bytes and return the first frame.
    pub fn push(&mut self, data: &[u8]) -> Option<Result<Frame, DecodeError>> {
        self.extend(data);
        self.next_frame()
    }
}

fn unescape_and_check(raw: &[u8]) -> Result<Frame, DecodeError> {
    let mut dec = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let mut x = raw[i];
        if x == ESC && i + 1 < raw.len() {
            i += 1;
            x = raw[i] ^ 0x20;
        }
        dec.push(x);
        i += 1;
    }
    if dec.len() < 2 {
        return Err(DecodeError::Short);
    }
    let sum = dec.iter().fold(0u32, |s, &b| s + b as u32);
    if sum & 0xFF != 0 {
        return Err(DecodeError::Checksum);
    }
    Ok(Frame { addr: dec[0], payload: dec[1..dec.len() - 1].to_vec() })
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nak_frame_roundtrip() {
        // The camera's NAK: C0 83 7D 5D C1 (checksum 7D escaped).
        assert_eq!(encode(0x83, &[]), vec![0xC0, 0x83, 0x7D, 0x5D, 0xC1]);
        let f = Decoder::new().push(&[0x00, 0xC0, 0x83, 0x7D, 0x5D, 0xC1]).unwrap().unwrap();
        assert!(f.is_nak());
    }

    #[test]
    fn status_request_matches_real_trace() {
        // From md1tool/logs: "> c0 88 03 02 73 c1"
        assert_eq!(encode(0x88, &[0x03, 0x02]), vec![0xC0, 0x88, 0x03, 0x02, 0x73, 0xC1]);
    }

    #[test]
    fn bad_checksum_rejected() {
        let r = Decoder::new().push(&[0xC0, 0x0E, 0x03, 0x02, 0x00, 0x00, 0xC1]).unwrap();
        assert_eq!(r, Err(DecodeError::Checksum));
    }
}
