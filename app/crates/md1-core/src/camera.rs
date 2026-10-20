//! A session with the camera: sequence numbers, retries, the command allowlist, and every
//! command the app uses. Behaviour mirrors md1tool/md1.py, which was proven on the hardware.

use std::io::Write;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::dostime::{now_utc_iso, DosTime};
use crate::frame::{self, hex, Decoder, Frame, ABORT_FRAME, SEND_ADDR};
use crate::transport::{open_port, Port};
use crate::Error;

/// Largest read or write block the camera accepts (a 4096-byte read gets no reply at all).
pub const MAX_BLOCK: usize = 2048;
/// Largest command payload carrying a path. Firmware 1.14 locks up (battery pull needed) on a
/// ~138-byte find-first path; md1.py capped at 96 bytes and so does this.
pub const MAX_PATH_PAYLOAD: usize = 96;

/// Commands this code will never send, whatever the caller asks. `02 10` formats the disc
/// with no confirmation (learned the hard way, docs/lab-notebook.md); `02 15` deletes pictures;
/// `02 09` renames; `02 02` changes directory (unused, and changes path resolution).
pub const FORBIDDEN: &[(u8, u8)] = &[(0x02, 0x10), (0x02, 0x15), (0x02, 0x14), (0x02, 0x09), (0x02, 0x02)];

/// Commands the camera accepts but no Sony software sends (`03 01`, `03 03`: bare, they reply
/// OK and change nothing visible). Sent only through [`Camera::transact_experimental`], to work
/// out what they do with parameters (docs/next-steps.md).
pub const EXPERIMENTAL: &[(u8, u8)] = &[(0x03, 0x01), (0x03, 0x03)];

/// What [`Camera::format_disc`] must be given; a stray call can't format by accident.
pub const FORMAT_CONFIRMATION: &str = "erase every photo and sound on this disc";

pub const SPEED_CODES: [(u8, u32); 5] = [(0, 9600), (1, 19200), (2, 38400), (3, 57600), (4, 115200)];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum HostId {
    /// "SONY     MKY-1001         1.00" — Sony's DSC-F1 software. Proven.
    F1,
    /// "SONY     DSC-2050         1.00" — the MD-native software.
    Md,
}

impl HostId {
    pub fn bytes(self) -> &'static [u8; 30] {
        match self {
            HostId::F1 => b"SONY     MKY-1001         1.00",
            HostId::Md => b"SONY     DSC-2050         1.00",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    /// 1 = playback, 2 = record (auto), 3 = record (manual)
    pub mode: u8,
    pub mode_name: &'static str,
    /// Pictures in the current album (two copies in the reply).
    pub pictures: u16,
    pub pictures2: u16,
    /// Power byte: 0–2 too low to write, 3–5 fine (5 seen on a charged battery).
    pub power: u8,
    /// Camera clock "YY-MM-DD hh:mm" (BCD). "50-01-01" = clock never set.
    pub clock: String,
    pub clock_set: bool,
    pub raw: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VolumeInfo {
    /// "PICTURE MD DATA" on a disc the camera formatted; blank on other formats.
    pub label: String,
    pub created: DosTime,
    pub modified: DosTime,
    /// Allocation unit in 2 KB sectors (32 = 64 KB on the camera's own format).
    pub unit_sectors: u16,
    pub total_units: u16,
    pub free_units: u16,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub raw: Vec<u8>,
}

impl VolumeInfo {
    /// Identifies a disc: its label and format time. Changes when the disc is reformatted.
    pub fn fingerprint(&self) -> String {
        format!("{}|{:08x}", self.label, dos_u32(&self.raw[39..43]))
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DirEntry {
    /// "PSN00018.PMP"; empty for a folder's own entry (first reply of find-first).
    pub name: String,
    pub attr: u16,
    pub is_dir: bool,
    pub size: u32,
    pub created: u32,
    pub modified: u32,
    pub accessed: u32,
    /// Unique per file/folder on the disc.
    pub number: u32,
    /// The 16 bytes after the name (three timestamps + number), as stored in listing.txt.
    pub rest: Vec<u8>,
}

impl DirEntry {
    fn parse(r: &[u8]) -> Option<Self> {
        if r.len() < 37 {
            return None;
        }
        let d = &r[3..];
        let raw = &d[3..14];
        let name = if raw[0] < b' ' {
            String::new()
        } else {
            let s = String::from_utf8_lossy(raw);
            let (base, ext) = (s[..8].trim_end(), s[8..].trim_end());
            if ext.is_empty() { base.to_string() } else { format!("{base}.{ext}") }
        };
        Some(Self {
            name,
            attr: u16::from_be_bytes([d[0], d[1]]),
            is_dir: d[1] == 0x01,
            size: dos_u32(&r[33..37]),
            created: dos_u32(&d[14..18]),
            modified: dos_u32(&d[18..22]),
            accessed: dos_u32(&d[22..26]),
            number: dos_u32(&d[26..30]),
            rest: d[14..30].to_vec(),
        })
    }
}

fn dos_u32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

fn bcd(x: u8) -> u8 {
    (x >> 4) * 10 + (x & 0x0F)
}

pub struct Camera {
    port: Box<dyn Port>,
    dec: Decoder,
    idx: usize,
    trace: Option<Box<dyn Write + Send>>,
    writes_enabled: bool,
    experimental: bool,
    pub timeout: Duration,
    pub camera_id: String,
}

impl Camera {
    pub fn new(port: Box<dyn Port>, trace: Option<Box<dyn Write + Send>>) -> Self {
        Self {
            port,
            dec: Decoder::new(),
            idx: 0,
            trace,
            writes_enabled: false,
            experimental: false,
            timeout: Duration::from_secs(6),
            camera_id: String::new(),
        }
    }

    pub fn baud(&self) -> u32 {
        self.port.baud()
    }

    /// Allow mkdir / create / write / delete / rmdir. Off by default; only explicit, confirmed
    /// user actions (restore, add photo) turn it on. FORBIDDEN commands stay refused regardless.
    pub fn set_writes_enabled(&mut self, on: bool) {
        self.writes_enabled = on;
    }

    fn trace(&mut self, dir: &str, data: &[u8]) {
        if let Some(t) = self.trace.as_mut() {
            let _ = writeln!(t, "{} {dir} {}", now_utc_iso(), hex(data));
            let _ = t.flush();
        }
    }

    /// The allowlist. Every frame passes through here before it reaches the wire.
    pub fn check_permitted(&self, p: &[u8]) -> Result<(), Error> {
        if p.len() < 2 {
            return Err(Error::Refused("empty command".into()));
        }
        let cmd = (p[0], p[1]);
        let refuse = |why: &str| Err(Error::Refused(format!("{} {why}", hex(&p[..2]))));
        if FORBIDDEN.contains(&cmd) {
            return refuse("is forbidden (format / delete-picture / rename / chdir)");
        }
        if self.experimental && EXPERIMENTAL.contains(&cmd) && p.len() <= MAX_PATH_PAYLOAD {
            return Ok(());
        }
        let read = matches!(
            cmd,
            (0x01, 0x01) | (0x01, 0x02) | (0x01, 0x03) | (0x01, 0x04) | (0x03, 0x02)
                | (0x02, 0x01) | (0x02, 0x05) | (0x02, 0x06) | (0x02, 0x0B) | (0x02, 0x0C) | (0x02, 0x0F)
        ) || (cmd == (0x02, 0x0A) && p.get(2..4) == Some(&[0x00, 0x00]));
        let write = matches!(cmd, (0x02, 0x03) | (0x02, 0x04) | (0x02, 0x08) | (0x02, 0x0D))
            || (cmd == (0x02, 0x0A) && p.get(2..4) == Some(&[0x02, 0x00]));
        if !(read || (write && self.writes_enabled)) {
            return refuse(if write { "needs writes enabled" } else { "is not on the allowlist" });
        }
        let limit = if cmd == (0x02, 0x0D) { 8 + MAX_BLOCK } else { MAX_PATH_PAYLOAD };
        if p.len() > limit {
            return refuse(&format!("payload of {} bytes is too long (camera locks up)", p.len()));
        }
        Ok(())
    }

    fn send(&mut self, payload: &[u8]) -> Result<(), Error> {
        self.check_permitted(payload)?;
        let f = frame::encode(SEND_ADDR[self.idx], payload);
        self.trace(">", &f);
        self.port.write_all(&f)?;
        self.idx = (self.idx + 1) % SEND_ADDR.len();
        Ok(())
    }

    fn recv(&mut self, timeout: Duration) -> Result<Frame, Error> {
        let deadline = Instant::now() + timeout;
        let mut buf = [0u8; 4096];
        loop {
            if let Some(r) = self.dec.next_frame() {
                return r.map_err(|e| Error::Protocol(format!("bad frame from camera: {e:?}")));
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(Error::Timeout);
            }
            let n = self.port.read_some(&mut buf, (deadline - now).min(Duration::from_millis(200)))?;
            if n > 0 {
                let chunk = buf[..n].to_vec();
                self.trace("<", &chunk);
                self.dec.extend(&chunk);
            }
        }
    }

    /// Send a command and return the reply payload (`cmd0 cmd1 status data...`).
    /// A `0x83` NAK means the frame was rejected unexecuted because its sequence address was
    /// wrong, so resending with the next address is always safe.
    pub fn transact_timeout(&mut self, payload: &[u8], timeout: Duration) -> Result<Vec<u8>, Error> {
        for _ in 0..SEND_ADDR.len() {
            self.port.clear_input()?;
            self.dec.clear();
            self.send(payload)?;
            let f = self.recv(timeout)?;
            if f.is_nak() {
                continue;
            }
            if f.payload.len() < 3 || f.payload[..2] != payload[..2] {
                return Err(Error::Protocol(format!(
                    "unexpected reply {} to {}",
                    hex(&f.payload[..f.payload.len().min(16)]),
                    hex(&payload[..2])
                )));
            }
            return Ok(f.payload);
        }
        Err(Error::Protocol("camera rejected every frame address".into()))
    }

    pub fn transact(&mut self, payload: &[u8]) -> Result<Vec<u8>, Error> {
        self.transact_timeout(payload, self.timeout)
    }

    /// Quick-format the disc (`02 10`, the camera menu's クイックフォーマット): **erases every photo
    /// and sound on it.** Refused unless `confirmation` is exactly [`FORMAT_CONFIRMATION`], which
    /// the app passes only after the user has confirmed three times. The camera says nothing for
    /// about 50 seconds while it works; this waits (calling `tick` with seconds elapsed) until it
    /// answers a status request again. Afterwards the camera must be switched off and on.
    pub fn format_disc(&mut self, confirmation: &str, tick: &mut dyn FnMut(u64)) -> Result<(), Error> {
        if confirmation != FORMAT_CONFIRMATION {
            return Err(Error::Refused("02 10 (format) needs the explicit confirmation".into()));
        }
        let f = frame::encode(SEND_ADDR[self.idx], &[0x02, 0x10]);
        self.trace(">", &f);
        self.port.write_all(&f)?;
        self.idx = (self.idx + 1) % SEND_ADDR.len();
        let start = Instant::now();
        loop {
            let waited = start.elapsed().as_secs();
            tick(waited);
            if waited > 180 {
                return Err(Error::Protocol("the camera hasn't answered for 3 minutes after starting the format".into()));
            }
            std::thread::sleep(Duration::from_secs(3));
            if waited >= 3 && self.transact_timeout(&[0x03, 0x02], Duration::from_secs(2)).is_ok() {
                tick(start.elapsed().as_secs());
                return Ok(());
            }
        }
    }

    /// Send one of the [`EXPERIMENTAL`] commands with parameters. Anything else is refused.
    pub fn transact_experimental(&mut self, payload: &[u8]) -> Result<Vec<u8>, Error> {
        if payload.len() < 2 || !EXPERIMENTAL.contains(&(payload[0], payload[1])) {
            return Err(Error::Refused(format!("{} is not an experimental command", hex(payload))));
        }
        self.experimental = true;
        let r = self.transact(payload);
        self.experimental = false;
        r
    }

    fn ok(&mut self, payload: &[u8], what: &str) -> Result<Vec<u8>, Error> {
        let r = self.transact(payload)?;
        if r[2] != 0 {
            return Err(Error::Status { what: what.to_string(), code: r[2] });
        }
        Ok(r)
    }

    /// Link-level abort; resets the camera's frame parser after an interrupted exchange.
    pub fn abort(&mut self) {
        self.trace(">", &ABORT_FRAME);
        let _ = self.port.write_all(&ABORT_FRAME);
        std::thread::sleep(Duration::from_millis(200));
        let _ = self.port.clear_input();
        self.dec.clear();
    }

    // ---- session ----

    pub fn hello(&mut self, id: HostId, timeout: Duration) -> Result<String, Error> {
        let mut p = vec![0x01, 0x01];
        p.extend_from_slice(id.bytes());
        let r = self.transact_timeout(&p, timeout)?;
        if r[2] != 0 {
            return Err(Error::Status { what: "hello".into(), code: r[2] });
        }
        self.camera_id = String::from_utf8_lossy(&r[3..r.len().min(33)]).trim_end().to_string();
        Ok(self.camera_id.clone())
    }

    pub fn status(&mut self) -> Result<Status, Error> {
        let r = self.ok(&[0x03, 0x02], "status")?;
        if r.len() < 15 {
            return Err(Error::Protocol(format!("short status reply {}", hex(&r))));
        }
        let clock = format!(
            "{:02}-{:02}-{:02} {:02}:{:02}",
            bcd(r[10]), bcd(r[11]), bcd(r[12]), bcd(r[13]), bcd(r[14])
        );
        Ok(Status {
            mode: r[3],
            mode_name: match r[3] {
                1 => "playback",
                2 => "record (auto)",
                3 => "record (manual)",
                _ => "unknown",
            },
            pictures: u16::from_be_bytes([r[4], r[5]]),
            pictures2: u16::from_be_bytes([r[6], r[7]]),
            power: r[8],
            clock_set: !clock.starts_with("50-01-01"),
            clock,
            raw: r,
        })
    }

    pub fn volume_info(&mut self) -> Result<VolumeInfo, Error> {
        let r = self.ok(&[0x02, 0x01], "volume info")?;
        if r.len() < 61 {
            return Err(Error::Protocol(format!("short volume info {}", hex(&r))));
        }
        let d = &r[3..];
        let label = String::from_utf8_lossy(&d[4..36]).trim_end_matches(['\0', ' ']).to_string();
        let unit_sectors = u16::from_be_bytes([d[44], d[45]]);
        let total_units = u16::from_be_bytes([d[48], d[49]]);
        let free_units = u16::from_be_bytes([d[56], d[57]]);
        let unit = unit_sectors as u64 * 2048;
        Ok(VolumeInfo {
            label,
            created: DosTime::from_u32(dos_u32(&d[36..40])),
            modified: DosTime::from_u32(dos_u32(&d[40..44])),
            unit_sectors,
            total_units,
            free_units,
            total_bytes: total_units as u64 * unit,
            free_bytes: free_units as u64 * unit,
            raw: r,
        })
    }

    pub fn get_speed(&mut self) -> Result<u8, Error> {
        let r = self.ok(&[0x01, 0x04], "get speed")?;
        Ok(r.get(3).copied().unwrap_or(0))
    }

    pub fn set_speed(&mut self, baud: u32) -> Result<(), Error> {
        let code = SPEED_CODES
            .iter()
            .find(|(_, b)| *b == baud)
            .map(|(c, _)| *c)
            .ok_or_else(|| Error::Refused(format!("unsupported speed {baud}")))?;
        self.ok(&[0x01, 0x03, code], "set speed")?;
        std::thread::sleep(Duration::from_millis(200));
        self.port.set_baud(baud)?;
        std::thread::sleep(Duration::from_millis(100));
        self.port.clear_input()?;
        self.dec.clear();
        // The camera restarts its frame sequence after a speed change (seen in the traces).
        self.idx = 0;
        Ok(())
    }

    /// Sony's session end. Also returns the camera to 9600 baud.
    pub fn disconnect(&mut self) -> Result<(), Error> {
        self.transact_timeout(&[0x01, 0x02], Duration::from_secs(3)).map(|_| ())
    }

    // ---- filesystem (read) ----

    fn path_cmd(cmd: [u8; 2], path: &str) -> Result<Vec<u8>, Error> {
        if !path.is_ascii() || path.contains('\0') {
            return Err(Error::Refused(format!("path {path:?} is not plain ASCII")));
        }
        let mut p = cmd.to_vec();
        p.extend_from_slice(path.as_bytes());
        p.push(0);
        Ok(p)
    }

    /// File or folder info; None if it does not exist.
    pub fn stat(&mut self, path: &str) -> Result<Option<DirEntry>, Error> {
        let r = self.transact(&Self::path_cmd([0x02, 0x0F], path)?)?;
        Ok(if r[2] == 0 { DirEntry::parse(&r) } else { None })
    }

    pub fn find_first(&mut self, folder: &str) -> Result<Option<DirEntry>, Error> {
        let r = self.transact(&Self::path_cmd([0x02, 0x05], folder)?)?;
        Ok(if r[2] == 0 { DirEntry::parse(&r) } else { None })
    }

    pub fn find_next(&mut self) -> Result<Option<DirEntry>, Error> {
        let r = self.transact(&[0x02, 0x06])?;
        Ok(if r[2] == 0 { DirEntry::parse(&r) } else { None })
    }

    /// Entries of a folder, the folder's own entry first (name ""). One cursor on the camera:
    /// a folder is always listed to the end before another is started.
    pub fn list_dir(&mut self, folder: &str) -> Result<Vec<DirEntry>, Error> {
        let mut out = Vec::new();
        let mut e = self.find_first(folder)?;
        while let Some(en) = e {
            out.push(en);
            if out.len() >= 5000 {
                break;
            }
            e = self.find_next()?;
        }
        Ok(out)
    }

    pub fn open_read(&mut self, path: &str) -> Result<u16, Error> {
        let mut p = vec![0x02, 0x0A, 0x00, 0x00];
        p.extend_from_slice(&Self::path_cmd([0, 0], path)?[2..]);
        let r = self.ok(&p, &format!("open {path}"))?;
        Ok(if r.len() >= 5 { u16::from_be_bytes([r[3], r[4]]) } else { 0 })
    }

    pub fn close(&mut self, handle: u16) -> Result<(), Error> {
        let h = handle.to_be_bytes();
        self.transact(&[0x02, 0x0B, h[0], h[1]]).map(|_| ())
    }

    /// Up to 2048 bytes from an open file; empty at end of file.
    pub fn read_block(&mut self, handle: u16) -> Result<Vec<u8>, Error> {
        let mut p = vec![0x02, 0x0C];
        p.extend_from_slice(&handle.to_be_bytes());
        p.extend_from_slice(&(MAX_BLOCK as u32).to_be_bytes());
        let r = self.ok(&p, "read")?;
        if r.len() < 7 {
            return Err(Error::Protocol(format!("short read reply {}", hex(&r))));
        }
        let len = u16::from_be_bytes([r[5], r[6]]) as usize;
        let data = r.get(7..7 + len).ok_or_else(|| {
            Error::Protocol(format!("read block says {len} bytes, got {}", r.len() - 7))
        })?;
        Ok(data.to_vec())
    }

    /// Whole file, byte-exact. `progress(bytes_so_far)` may return Err(Cancelled) to stop.
    pub fn read_file(
        &mut self,
        path: &str,
        progress: &mut dyn FnMut(usize) -> Result<(), Error>,
    ) -> Result<Vec<u8>, Error> {
        let size = self.stat(path)?.map(|e| e.size as usize);
        let h = self.open_read(path)?;
        let mut out = Vec::with_capacity(size.unwrap_or(0));
        let res: Result<(), Error> = (|| {
            loop {
                let block = self.read_block(h)?;
                if block.is_empty() {
                    return Ok(());
                }
                out.extend_from_slice(&block);
                progress(out.len())?;
            }
        })();
        let closed = self.close(h);
        res?;
        closed?;
        if let Some(s) = size {
            if out.len() != s {
                return Err(Error::Protocol(format!("{path}: got {} bytes, camera said {s}", out.len())));
            }
        }
        Ok(out)
    }

    // ---- filesystem (write; needs set_writes_enabled) ----

    pub fn mkdir(&mut self, path: &str) -> Result<(), Error> {
        self.ok(&Self::path_cmd([0x02, 0x03], path)?, &format!("mkdir {path}")).map(|_| ())
    }

    pub fn rmdir(&mut self, path: &str) -> Result<(), Error> {
        self.ok(&Self::path_cmd([0x02, 0x04], path)?, &format!("rmdir {path}")).map(|_| ())
    }

    pub fn delete_file(&mut self, path: &str) -> Result<(), Error> {
        self.ok(&Self::path_cmd([0x02, 0x08], path)?, &format!("delete {path}")).map(|_| ())
    }

    /// Create (or replace) a file with `data`, in 2 KB writes (≈7.5 KB/s; Sony's 1 KB writes are
    /// ~9× slower). Like Sony's software, an existing file is deleted first.
    pub fn write_file(
        &mut self,
        path: &str,
        data: &[u8],
        progress: &mut dyn FnMut(usize) -> Result<(), Error>,
    ) -> Result<(), Error> {
        if self.stat(path)?.is_some() {
            self.delete_file(path)?;
        }
        let mut p = vec![0x02, 0x0A, 0x02, 0x00];
        p.extend_from_slice(&Self::path_cmd([0, 0], path)?[2..]);
        let r = self.ok(&p, &format!("create {path}"))?;
        let h = u16::from_be_bytes([r[3], r[4]]);
        let res: Result<(), Error> = (|| {
            for (i, chunk) in data.chunks(MAX_BLOCK).enumerate() {
                let mut p = vec![0x02, 0x0D];
                p.extend_from_slice(&h.to_be_bytes());
                p.extend_from_slice(&(chunk.len() as u32).to_be_bytes());
                p.extend_from_slice(chunk);
                let r = self.transact_timeout(&p, Duration::from_secs(20))?;
                if r[2] != 0 {
                    return Err(Error::Status { what: format!("write {path}"), code: r[2] });
                }
                let n = r.get(3..7).map(dos_u32).unwrap_or(0) as usize;
                if n != chunk.len() {
                    return Err(Error::Protocol(format!("{path}: camera wrote {n} of {}", chunk.len())));
                }
                progress(i * MAX_BLOCK + chunk.len())?;
            }
            Ok(())
        })();
        let closed = self.close(h);
        res?;
        closed
    }
}

/// Speeds tried when looking for the camera: it starts at 9600 after a battery change and keeps
/// 115200 across power-switch restarts once switched.
pub const PROBE_BAUDS: [u32; 2] = [9600, 115200];

#[derive(Debug, Clone, Serialize)]
pub struct Connection {
    pub port: String,
    pub found_at_baud: u32,
    pub baud: u32,
    pub camera_id: String,
}

/// Open `port_path`, find the camera's current speed, say hello, and switch to `fast_baud`.
pub fn connect(
    port_path: &str,
    fast_baud: Option<u32>,
    trace: Option<Box<dyn Write + Send>>,
    log: &mut dyn FnMut(String),
) -> Result<(Camera, Connection), Error> {
    let mut trace = trace;
    for baud in PROBE_BAUDS {
        log(format!("Trying {baud} baud…"));
        let port = open_port(port_path, baud)?;
        let mut cam = Camera::new(port, trace.take());
        for _attempt in 0..2 {
            // The camera remembers its sequence position across sessions: `transact` steps
            // through the addresses on NAKs. A silent camera times out instead.
            match cam.hello(HostId::F1, Duration::from_millis(1500)) {
                Ok(id) => {
                    log(format!("Camera answered at {baud} baud: {id}"));
                    let mut conn = Connection {
                        port: port_path.to_string(),
                        found_at_baud: baud,
                        baud,
                        camera_id: id,
                    };
                    if let Some(fast) = fast_baud.filter(|&f| f != baud) {
                        cam.set_speed(fast)?;
                        cam.status()?;
                        conn.baud = fast;
                        log(format!("Switched link to {fast} baud"));
                    }
                    return Ok((cam, conn));
                }
                Err(e @ (Error::Io(_) | Error::Refused(_))) => return Err(e),
                Err(e) => {
                    log(format!("  no answer at {baud} baud ({e})"));
                    cam.abort();
                }
            }
        }
        trace = cam.trace.take();
    }
    Err(Error::NoCamera)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NullPort;
    impl Port for NullPort {
        fn write_all(&mut self, _: &[u8]) -> std::io::Result<()> {
            Ok(())
        }
        fn read_some(&mut self, _: &mut [u8], _: Duration) -> std::io::Result<usize> {
            Ok(0)
        }
        fn set_baud(&mut self, _: u32) -> std::io::Result<()> {
            Ok(())
        }
        fn baud(&self) -> u32 {
            9600
        }
        fn clear_input(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn forbidden_commands_are_never_sent() {
        let mut cam = Camera::new(Box::new(NullPort), None);
        cam.set_writes_enabled(true);
        for &(a, b) in FORBIDDEN {
            assert!(matches!(cam.check_permitted(&[a, b]), Err(Error::Refused(_))), "{a:02x} {b:02x}");
            assert!(matches!(cam.transact(&[a, b]), Err(Error::Refused(_))));
        }
        // Anything not on the list, e.g. the unexplained 03 01 / 03 03 / 02 07, is refused too.
        for cmd in [[0x03, 0x01], [0x03, 0x03], [0x02, 0x07], [0x02, 0x11], [0x04, 0x00]] {
            assert!(cam.check_permitted(&cmd).is_err());
        }
    }

    #[test]
    fn experimental_path_only_allows_03_01_and_03_03() {
        let mut cam = Camera::new(Box::new(NullPort), None);
        for cmd in [&[0x02, 0x10][..], &[0x02, 0x15, 0, 1], &[0x02, 0x03, b'/', 0], &[0x03, 0x02], &[0x04, 0x00]] {
            assert!(matches!(cam.transact_experimental(cmd), Err(Error::Refused(_))), "{cmd:02x?}");
        }
        // Outside transact_experimental, even 03 03 stays refused.
        assert!(cam.check_permitted(&[0x03, 0x03, 0x26]).is_err());
    }

    #[test]
    fn format_needs_the_confirmation() {
        let mut cam = Camera::new(Box::new(NullPort), None);
        assert!(matches!(cam.format_disc("yes", &mut |_| {}), Err(Error::Refused(_))));
        assert!(matches!(cam.transact(&[0x02, 0x10]), Err(Error::Refused(_))), "still forbidden everywhere else");
    }

    #[test]
    fn writes_need_enabling() {
        let mut cam = Camera::new(Box::new(NullPort), None);
        assert!(cam.check_permitted(b"\x02\x03/X\0").is_err());
        assert!(cam.check_permitted(b"\x02\x0A\x02\x00/X\0").is_err());
        assert!(cam.check_permitted(b"\x02\x0A\x00\x00/X\0").is_ok());
        cam.set_writes_enabled(true);
        assert!(cam.check_permitted(b"\x02\x03/X\0").is_ok());
    }

    #[test]
    fn long_paths_refused() {
        let cam = Camera::new(Box::new(NullPort), None);
        let mut p = vec![0x02, 0x05];
        p.extend(std::iter::repeat_n(b'A', 120));
        assert!(cam.check_permitted(&p).is_err());
    }

    #[test]
    fn parses_real_entry_and_volume() {
        // find-next reply for /PIC_MD/PIC00000/NRA00000.PMA reconstructed from listing.txt
        let mut r = vec![0x02, 0x06, 0x00, 0x00, 0x80, 0x01];
        r.extend_from_slice(b"NRA00000PMA");
        r.extend_from_slice(&[0, 0x21, 1, 0xf7, 0, 0x21, 1, 0xf7, 0, 0x21, 1, 0xf7, 0, 0, 0, 0x17]);
        r.extend_from_slice(&106752u32.to_be_bytes());
        let e = DirEntry::parse(&r).unwrap();
        assert_eq!(e.name, "NRA00000.PMA");
        assert_eq!(e.size, 106752);
        assert_eq!(e.number, 0x17);
        assert!(!e.is_dir);
    }
}
