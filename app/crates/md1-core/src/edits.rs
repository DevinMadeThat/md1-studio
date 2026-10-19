//! User edits to photos: metadata (location, date/time, caption, favourite) and the "look"
//! (rotation, flip, straighten, crop, colour adjustments, noise cleanup).
//!
//! Stored per disc in `<disc>/edits.json`, keyed by photo id ("PIC00001/PSN00018"). The mirrored
//! camera files are never modified, so the backup stays byte-exact; edits are applied when
//! showing and exporting photos.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::import::save_atomic;

pub const EDITS_FILE: &str = "edits.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Location {
    pub lat: f64,
    pub lon: f64,
    /// Human-readable place, e.g. "Pike Place Market, Seattle".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Crop rectangle, as fractions (0–1) of the rotated / flipped / straightened photo.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Crop {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Per-channel levels and a midtone gamma chosen by auto-enhance (computed once, from the
/// original pixels, so the preview and the export apply exactly the same correction).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct AutoLevels {
    /// Black point per channel (R, G, B), 0–1.
    pub lo: [f64; 3],
    /// White point per channel, 0–1.
    pub hi: [f64; 3],
    pub gamma: f64,
}

/// Colour adjustments. Sliders run from -1 to 1 (0 = unchanged); denoise from 0 to 1.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Adjust {
    #[serde(default)]
    pub auto: Option<AutoLevels>,
    #[serde(default)]
    pub brightness: f64,
    #[serde(default)]
    pub contrast: f64,
    #[serde(default)]
    pub warmth: f64,
    #[serde(default)]
    pub saturation: f64,
    #[serde(default)]
    pub denoise: f64,
}

impl Adjust {
    pub fn is_identity(&self) -> bool {
        self.auto.is_none()
            && self.brightness == 0.0
            && self.contrast == 0.0
            && self.warmth == 0.0
            && self.saturation == 0.0
            && self.denoise == 0.0
    }
}

/// Everything the photo editor changes, saved together.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Look {
    #[serde(default)]
    pub rotation: u16,
    #[serde(default)]
    pub flip: bool,
    /// Degrees, -15…15, positive = clockwise.
    #[serde(default)]
    pub straighten: f64,
    #[serde(default)]
    pub crop: Option<Crop>,
    #[serde(default)]
    pub adjust: Option<Adjust>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoEdits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<Location>,
    /// Local date and time the photo was taken, "YYYY-MM-DD HH:MM:SS".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken: Option<String>,
    /// Clockwise degrees: 0, 90, 180 or 270.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub rotation: u16,
    #[serde(default, skip_serializing_if = "is_false")]
    pub flip: bool,
    #[serde(default, skip_serializing_if = "is_zero_f")]
    pub straighten: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crop: Option<Crop>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adjust: Option<Adjust>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub favorite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
}

fn is_zero(v: &u16) -> bool {
    *v == 0
}

fn is_zero_f(v: &f64) -> bool {
    *v == 0.0
}

fn is_false(v: &bool) -> bool {
    !*v
}

impl PhotoEdits {
    pub fn is_empty(&self) -> bool {
        self.location.is_none() && self.taken.is_none() && !self.has_look() && self.rotation == 0
            && !self.favorite && self.caption.is_none()
    }

    /// Edits that need the pixels re-rendered (anything beyond a plain rotation).
    pub fn has_look(&self) -> bool {
        self.flip || self.straighten != 0.0 || self.crop.is_some() || self.adjust.is_some_and(|a| !a.is_identity())
    }
}

/// A change to apply to one photo. Absent fields are left alone.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPatch {
    pub set_location: Option<Location>,
    #[serde(default)]
    pub clear_location: bool,
    pub set_taken: Option<String>,
    #[serde(default)]
    pub clear_taken: bool,
    /// Added to the current rotation (e.g. 90 or -90).
    pub rotate_by: Option<i32>,
    /// Replace rotation, flip, straighten, crop and colour adjustments (from the photo editor).
    pub set_look: Option<Look>,
    /// Turn on auto-enhance with these levels (computed by `adjust::auto_levels`), keeping the
    /// other adjustments.
    pub set_auto: Option<AutoLevels>,
    #[serde(default)]
    pub clear_auto: bool,
    pub set_favorite: Option<bool>,
    /// Empty string clears the caption.
    pub set_caption: Option<String>,
}

pub type Edits = BTreeMap<String, PhotoEdits>;

pub fn load(disc_dir: &Path) -> Edits {
    fs::read(disc_dir.join(EDITS_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(disc_dir: &Path, edits: &Edits) -> std::io::Result<()> {
    save_atomic(&disc_dir.join(EDITS_FILE), &serde_json::to_vec_pretty(edits).unwrap())
}

/// "YYYY-MM-DD HH:MM:SS" with sane ranges (seconds optional on input).
pub fn normalize_taken(s: &str) -> Option<String> {
    let s = s.trim().replace('T', " ");
    let (date, time) = s.split_once(' ').unwrap_or((&s, "00:00:00"));
    let d: Vec<u32> = date.split(['-', ':', '/']).map(|x| x.parse().ok()).collect::<Option<_>>()?;
    let mut t: Vec<u32> = time.split(':').map(|x| x.parse().ok()).collect::<Option<_>>()?;
    if d.len() != 3 || !(2..=3).contains(&t.len()) {
        return None;
    }
    t.resize(3, 0);
    let ok = (1900..=2100).contains(&d[0]) && (1..=12).contains(&d[1]) && (1..=31).contains(&d[2])
        && t[0] < 24 && t[1] < 60 && t[2] < 60;
    ok.then(|| format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}", d[0], d[1], d[2], t[0], t[1], t[2]))
}

/// Apply patches to a disc's edits file and save it.
pub fn apply(disc_dir: &Path, patches: &[(String, EditPatch)]) -> Result<Edits, String> {
    let mut edits = load(disc_dir);
    for (id, p) in patches {
        let e = edits.entry(id.clone()).or_default();
        if let Some(loc) = &p.set_location {
            if !(-90.0..=90.0).contains(&loc.lat) || !(-180.0..=180.0).contains(&loc.lon) {
                return Err(format!("{id}: coordinates out of range"));
            }
            e.location = Some(loc.clone());
        }
        if p.clear_location {
            e.location = None;
        }
        if let Some(t) = &p.set_taken {
            e.taken = Some(normalize_taken(t).ok_or_else(|| format!("{id}: not a date and time: {t}"))?);
        }
        if p.clear_taken {
            e.taken = None;
        }
        if let Some(r) = p.rotate_by {
            e.rotation = (e.rotation as i32 + r).rem_euclid(360) as u16 / 90 * 90;
            // Keep a crop on the same part of the picture.
            if let Some(c) = e.crop {
                let turns = r.rem_euclid(360) / 90;
                e.crop = Some((0..turns).fold(c, |c, _| Crop { x: 1.0 - c.y - c.h, y: c.x, w: c.h, h: c.w }));
            }
        }
        if let Some(look) = &p.set_look {
            e.rotation = (look.rotation as i32).rem_euclid(360) as u16 / 90 * 90;
            e.flip = look.flip;
            e.straighten = look.straighten.clamp(-45.0, 45.0);
            e.crop = look.crop.filter(|c| c.w > 0.0 && c.h > 0.0 && !(c.x == 0.0 && c.y == 0.0 && c.w == 1.0 && c.h == 1.0));
            e.adjust = look.adjust.filter(|a| !a.is_identity());
        }
        if p.set_auto.is_some() || p.clear_auto {
            let mut a = e.adjust.unwrap_or_default();
            a.auto = p.set_auto;
            e.adjust = Some(a).filter(|a| !a.is_identity());
        }
        if let Some(f) = p.set_favorite {
            e.favorite = f;
        }
        if let Some(c) = &p.set_caption {
            let c = c.trim();
            e.caption = (!c.is_empty()).then(|| c.to_string());
        }
    }
    edits.retain(|_, e| !e.is_empty());
    save(disc_dir, &edits).map_err(|e| e.to_string())?;
    Ok(edits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patches_apply_and_empty_entries_vanish() {
        let dir = std::env::temp_dir().join(format!("md1-edits-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let loc = Location { lat: 47.6097, lon: -122.3422, name: Some("Pike Place".into()) };
        let e = apply(
            &dir,
            &[
                ("A/PSN00000".into(), EditPatch { set_location: Some(loc.clone()), rotate_by: Some(-90), ..Default::default() }),
                ("A/PSN00001".into(), EditPatch { set_taken: Some("1998-05-03T14:22".into()), ..Default::default() }),
            ],
        )
        .unwrap();
        assert_eq!(e["A/PSN00000"].rotation, 270);
        assert_eq!(e["A/PSN00000"].location, Some(loc));
        assert_eq!(e["A/PSN00001"].taken.as_deref(), Some("1998-05-03 14:22:00"));
        let e = apply(&dir, &[("A/PSN00001".into(), EditPatch { clear_taken: true, ..Default::default() })]).unwrap();
        assert!(!e.contains_key("A/PSN00001"));
        assert_eq!(load(&dir).len(), 1);
        assert!(apply(&dir, &[("x".into(), EditPatch { set_taken: Some("yesterday".into()), ..Default::default() })]).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }
}
