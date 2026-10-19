//! Byte transport under the protocol: a real serial port, or anything else implementing `Port`
//! (tests use a scripted fake).

use std::io;
use std::time::Duration;

pub trait Port: Send {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()>;
    /// Read whatever is available, waiting at most `timeout`. Ok(0) means nothing arrived.
    fn read_some(&mut self, buf: &mut [u8], timeout: Duration) -> io::Result<usize>;
    fn set_baud(&mut self, baud: u32) -> io::Result<()>;
    fn baud(&self) -> u32;
    /// Throw away anything received but not yet read.
    fn clear_input(&mut self) -> io::Result<()>;
}

/// Open a serial port for the camera: 8N1, no flow control.
pub fn open_port(path: &str, baud: u32) -> io::Result<Box<dyn Port>> {
    #[cfg(unix)]
    return Ok(Box::new(unix::TermiosPort::open(path, baud)?));
    #[cfg(not(unix))]
    return Ok(Box::new(SerialPort::open(path, baud)?));
}

/// Windows: the `serialport` crate.
#[cfg(not(unix))]
pub struct SerialPort {
    inner: Box<dyn serialport::SerialPort>,
    baud: u32,
}

#[cfg(not(unix))]
impl SerialPort {
    pub fn open(path: &str, baud: u32) -> io::Result<Self> {
        let inner = serialport::new(path, baud)
            .data_bits(serialport::DataBits::Eight)
            .parity(serialport::Parity::None)
            .stop_bits(serialport::StopBits::One)
            .flow_control(serialport::FlowControl::None)
            .timeout(Duration::from_millis(100))
            .open()
            .map_err(to_io)?;
        Ok(Self { inner, baud })
    }
}

#[cfg(not(unix))]
fn to_io(e: serialport::Error) -> io::Error {
    match e.kind {
        serialport::ErrorKind::Io(kind) => io::Error::new(kind, e.description),
        serialport::ErrorKind::NoDevice => io::Error::new(io::ErrorKind::NotFound, e.description),
        _ => io::Error::other(e.description),
    }
}

#[cfg(not(unix))]
impl Port for SerialPort {
    fn write_all(&mut self, data: &[u8]) -> io::Result<()> {
        use std::io::Write;
        self.inner.write_all(data)?;
        self.inner.flush()
    }

    fn read_some(&mut self, buf: &mut [u8], timeout: Duration) -> io::Result<usize> {
        use std::io::Read;
        self.inner.set_timeout(timeout.max(Duration::from_millis(1))).map_err(to_io)?;
        match self.inner.read(buf) {
            Ok(n) => Ok(n),
            Err(e) if e.kind() == io::ErrorKind::TimedOut => Ok(0),
            Err(e) => Err(e),
        }
    }

    fn set_baud(&mut self, baud: u32) -> io::Result<()> {
        self.inner.set_baud_rate(baud).map_err(to_io)?;
        self.baud = baud;
        Ok(())
    }

    fn baud(&self) -> u32 {
        self.baud
    }

    fn clear_input(&mut self) -> io::Result<()> {
        self.inner.clear(serialport::ClearBuffer::Input).map_err(to_io)
    }
}

/// macOS / Linux: plain termios, as pyserial does (proven on the camera). Unlike the
/// `serialport` crate this also works on pseudo-terminals, so tools/fake_camera.py can be used.
#[cfg(unix)]
mod unix {
    use super::Port;
    use std::ffi::CString;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::time::Duration;

    pub struct TermiosPort {
        fd: OwnedFd,
        baud: u32,
    }

    fn check(r: libc::c_int) -> io::Result<libc::c_int> {
        if r < 0 { Err(io::Error::last_os_error()) } else { Ok(r) }
    }

    fn speed(baud: u32) -> io::Result<libc::speed_t> {
        Ok(match baud {
            9600 => libc::B9600,
            19200 => libc::B19200,
            38400 => libc::B38400,
            57600 => libc::B57600,
            115200 => libc::B115200,
            230400 => libc::B230400,
            _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, format!("unsupported speed {baud}"))),
        })
    }

    impl TermiosPort {
        pub fn open(path: &str, baud: u32) -> io::Result<Self> {
            let c = CString::new(path).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "bad path"))?;
            let raw = check(unsafe { libc::open(c.as_ptr(), libc::O_RDWR | libc::O_NOCTTY | libc::O_NONBLOCK) })?;
            let port = Self { fd: unsafe { OwnedFd::from_raw_fd(raw) }, baud };
            port.configure(baud)?;
            Ok(port)
        }

        fn configure(&self, baud: u32) -> io::Result<()> {
            let fd = self.fd.as_raw_fd();
            unsafe {
                let mut t: libc::termios = std::mem::zeroed();
                check(libc::tcgetattr(fd, &mut t))?;
                libc::cfmakeraw(&mut t);
                t.c_cflag |= libc::CREAD | libc::CLOCAL | libc::CS8;
                t.c_cflag &= !(libc::CSTOPB | libc::PARENB | libc::CRTSCTS);
                t.c_iflag &= !(libc::IXON | libc::IXOFF | libc::IXANY);
                t.c_cc[libc::VMIN] = 0;
                t.c_cc[libc::VTIME] = 0;
                let s = speed(baud)?;
                check(libc::cfsetispeed(&mut t, s))?;
                check(libc::cfsetospeed(&mut t, s))?;
                check(libc::tcsetattr(fd, libc::TCSANOW, &t))?;
            }
            Ok(())
        }

        fn poll(&self, events: libc::c_short, timeout: Duration) -> io::Result<bool> {
            let mut p = libc::pollfd { fd: self.fd.as_raw_fd(), events, revents: 0 };
            let ms = timeout.as_millis().min(i32::MAX as u128) as libc::c_int;
            loop {
                match check(unsafe { libc::poll(&mut p, 1, ms) }) {
                    Ok(n) => return Ok(n > 0),
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(e) => return Err(e),
                }
            }
        }
    }

    impl Port for TermiosPort {
        fn write_all(&mut self, mut data: &[u8]) -> io::Result<()> {
            while !data.is_empty() {
                let n = unsafe { libc::write(self.fd.as_raw_fd(), data.as_ptr().cast(), data.len()) };
                if n < 0 {
                    let e = io::Error::last_os_error();
                    if e.kind() == io::ErrorKind::WouldBlock || e.kind() == io::ErrorKind::Interrupted {
                        self.poll(libc::POLLOUT, Duration::from_secs(2))?;
                        continue;
                    }
                    return Err(e);
                }
                data = &data[n as usize..];
            }
            unsafe { libc::tcdrain(self.fd.as_raw_fd()) };
            Ok(())
        }

        fn read_some(&mut self, buf: &mut [u8], timeout: Duration) -> io::Result<usize> {
            if !self.poll(libc::POLLIN, timeout)? {
                return Ok(0);
            }
            let n = unsafe { libc::read(self.fd.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) };
            if n < 0 {
                let e = io::Error::last_os_error();
                return if e.kind() == io::ErrorKind::WouldBlock { Ok(0) } else { Err(e) };
            }
            if n == 0 {
                // poll said readable but nothing came: the device went away (adapter unplugged).
                return Err(io::Error::new(io::ErrorKind::BrokenPipe, "serial port closed"));
            }
            Ok(n as usize)
        }

        fn set_baud(&mut self, baud: u32) -> io::Result<()> {
            self.configure(baud)?;
            self.baud = baud;
            Ok(())
        }

        fn baud(&self) -> u32 {
            self.baud
        }

        fn clear_input(&mut self) -> io::Result<()> {
            check(unsafe { libc::tcflush(self.fd.as_raw_fd(), libc::TCIFLUSH) }).map(|_| ())
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct PortInfo {
    pub path: String,
    /// "FTDI USB serial" etc., when the OS tells us.
    pub description: String,
    pub is_usb: bool,
    /// FTDI / Prolific / CH340 / CP210x USB-serial chips: very likely the camera cable.
    pub likely_adapter: bool,
}

/// Serial ports worth offering, most likely camera adapter first. On macOS only the `cu.*`
/// call-out devices are listed (the `tty.*` twins block on carrier detect).
pub fn list_ports() -> Vec<PortInfo> {
    let mut out: Vec<PortInfo> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !(cfg!(target_os = "macos") && p.port_name.starts_with("/dev/tty.")))
        .filter(|p| {
            let n = p.port_name.to_lowercase();
            !(n.contains("bluetooth") || n.contains("debug-console") || n.contains("wlan-debug"))
        })
        .map(|p| {
            let (is_usb, likely, desc) = match &p.port_type {
                serialport::SerialPortType::UsbPort(u) => {
                    let known = matches!(u.vid, 0x0403 | 0x067B | 0x1A86 | 0x10C4);
                    let desc = [u.manufacturer.clone(), u.product.clone()]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" ");
                    (true, known, if desc.is_empty() { format!("USB {:04x}:{:04x}", u.vid, u.pid) } else { desc })
                }
                serialport::SerialPortType::PciPort => (false, false, "Built-in serial port".into()),
                _ => (false, false, String::new()),
            };
            let n = p.port_name.to_lowercase();
            let likely = likely || n.contains("usbserial") || n.contains("ttyusb");
            PortInfo { path: p.port_name, description: desc, is_usb, likely_adapter: likely }
        })
        .collect();
    out.sort_by_key(|p| (!p.likely_adapter, !p.is_usb, p.path.clone()));
    out
}
