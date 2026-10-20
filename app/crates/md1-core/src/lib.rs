//! Sony DSC-MD1 (MD Cyber-shot, 1997): serial protocol, disc file formats, import and export.
//!
//! Reference: docs/protocol.md and docs/disc-format.md in this repository. The protocol code
//! follows md1tool/md1.py, which was proven against a real camera.
//!
//! Safety: `camera::Camera` only sends allowlisted commands. Read commands are always allowed;
//! write commands only after `set_writes_enabled(true)`; `02 10` (format), `02 15` (delete
//! picture) and a few others are refused unconditionally.

pub mod adjust;
pub mod browse;
pub mod camera;
pub mod dostime;
pub mod edits;
pub mod export;
pub mod formats;
pub mod frame;
pub mod import;
pub mod library;
pub mod transport;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("the camera did not answer in time")]
    Timeout,
    #[error("no camera answered on this port (is it on, in playback mode, with IrDA off?)")]
    NoCamera,
    #[error("{what}: camera returned status {code:02x}")]
    Status { what: String, code: u8 },
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("refused to send command: {0}")]
    Refused(String),
    #[error("cancelled")]
    Cancelled,
}
