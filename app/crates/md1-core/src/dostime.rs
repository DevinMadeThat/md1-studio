//! DOS-style packed date/time, big-endian, as used in the camera's directory entries:
//! `YYYYYYYM MMMDDDDD HHHHHMMM MMMSSSSS`, year from 1980, seconds / 2.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct DosTime {
    pub year: u16,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
}

impl DosTime {
    pub fn from_u32(v: u32) -> Self {
        let d = (v >> 16) as u16;
        let t = (v & 0xFFFF) as u16;
        Self {
            year: (d >> 9) + 1980,
            month: ((d >> 5) & 15) as u8,
            day: (d & 31) as u8,
            hour: (t >> 11) as u8,
            minute: ((t >> 5) & 63) as u8,
            second: ((t & 31) * 2) as u8,
        }
    }

    /// 1980-01-01: the camera's clock was never set (or its backup battery is dead). Only the
    /// time of day is then meaningful, as "time since the clock started".
    pub fn clock_unset(&self) -> bool {
        self.year == 1980 && self.month <= 1 && self.day <= 1
    }

    pub fn iso(&self) -> String {
        format!(
            "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }

    /// "YYYY:MM:DD HH:MM:SS" for EXIF.
    pub fn exif(&self) -> String {
        format!(
            "{:04}:{:02}:{:02} {:02}:{:02}:{:02}",
            self.year, self.month, self.day, self.hour, self.minute, self.second
        )
    }
}

/// Current UTC time as ISO-8601, without pulling in a date crate.
pub fn now_utc_iso() -> String {
    iso_utc(std::time::SystemTime::now())
}

/// A system time as ISO-8601 UTC, e.g. "2026-10-19T23:40:58.009Z".
pub fn iso_utc(t: std::time::SystemTime) -> String {
    let secs = t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0);
    let days = (secs / 86400.0).floor() as i64;
    let rem = secs - days as f64 * 86400.0;
    // Howard Hinnant's civil_from_days.
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    let h = (rem / 3600.0) as u32;
    let mi = ((rem % 3600.0) / 60.0) as u32;
    let s = rem % 60.0;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:06.3}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_values() {
        // docs/disc-format.md: 0x354C9501 = 2006-10-12 18:40:02, 0x00210F5C = 1980-01-01 01:58:56
        assert_eq!(DosTime::from_u32(0x354C9501).iso(), "2006-10-12 18:40:02");
        let t = DosTime::from_u32(0x00210F5C);
        assert_eq!(t.iso(), "1980-01-01 01:58:56");
        assert!(t.clock_unset());
    }
}
