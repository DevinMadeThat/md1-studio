# Next steps and open questions

Where to pick up next session (camera battery was low at the end of 2026-10-18).

## Before starting

* Charge the battery (or use the AC adapter). Writing is refused below power state 3 (status byte 8).
* The camera may still be at 115200 baud; `md1.py --id f1 probe` finds it.
* The disc in the camera is disc 2 = restored mirror + `PSN00019.PMP` (20 photos).

## Data collection

1. **Mirror disc 1 properly** with `md1.py mirror --disc disc1`: it was downloaded before the
   directory listing existed, so any `NRA*.PMA` sound files, its thumbnails, OV/PIC index files,
   `PDF_MD` area (if any) and timestamps are still unread.
2. Mirror any other discs the same way. Always mirror before any experiment that writes.

## Open questions

| Question | Idea for testing |
|---|---|
| What do `03 01`, `03 03`, `02 07` do? | No visible effect. Try them mid-transfer, after an open, or check status bytes / volume info before and after. |
| Remaining command space: `02 11`–`02 3F` (except denylisted), groups `04`–`07` | Only with a fresh mirror **and the write-protect tab set**; stop at the first silence. |
| Does the camera honour the write-protect tab for serial writes / `02 10`? | Set the tab, try a harmless write (`02 03 /TESTDIR`) and observe the status. |
| Narration added later with the ナレーション button | Record one, list the album: is it also `NRAnnnnn.PMA`? Same format? |
| PIC_INF flag bits (protect, rotate, bookmarks, captions) | Set each on the camera, re-read PIC_INF.PMF, diff. Sony's code says rotation = byte 5 bits 2–3, protect = byte 14 bit 0. |
| OV_INF.PMF fields: album titles, diary/free mode | Change on the camera, diff. |
| Status reply bytes 8+ (power state etc.) | Compare on battery vs AC adapter. |
| Year base of DOS timestamps | Set the camera clock, take a photo, decode. |
| Higher speeds (`01 03 05` 230400) | Probably IrDA-only; FTDI supports 230400 — harmless to try (camera answers or not). |
| Does `02 0C` read handle values matter? | Reads with handle 0 worked; Sony uses the real handle. |

## Upload / authoring ideas

* **Any JPEG onto the camera:** synthesize a PMP header for a non-camera JPEG (TLV tags
  0x10/0x20/0x21/0x24/0x11; quality byte; JPEG length) — the hand-add path is proven with a
  camera-made PMP. Keep 640×480, baseline 4:2:0, ≤ 64 KB (STD) / 128 KB (FINE).
* **Attach sound to a photo:** write `NRAnnnnn.PMA` (256-byte header copied from a real one +
  mono ATRAC1 sound units) and set PIC_INF record byte 7 = 1. Needs an ATRAC1 encoder
  (e.g. the open-source `atracdenc`).
* **New album:** MKDIR `/PIC_MD/PICnnnnn`, write PIC_INF/PIDX, add an album entry to OV_INF/OV_IDX.

## Desktop app (MD1 Studio, `app/`) — next

v0.1 (built 2026-10-18) connects, imports, browses, plays sound and exports. First real-camera
connection: 2026-10-19 (worked). Since then: browse the camera through its thumbnails, download
chosen photos, one library grouped by import day, matching of camera photos to the library.

1. **Real-camera run of the thumbnail browser**: browse disc 2 (restored, 20 photos; should show
   19 as in the library through name/size/thumbnail matching even though the restore gave the
   files new times), download `PSN00019`, then do disc 1.
2. **Restore disc from backup** (port `md1tool/restore.py`): confirmation screen, battery check
   (status power ≥ 3), write-protect hint, verify every file, "power-cycle the camera" prompt.
3. **Add photos to the camera** (port `add_photo.py`): camera-made PMPs first; arbitrary JPEGs
   need a synthesized PMP header (see above).
4. Windows and Linux builds via `.github/workflows/build.yml` (push a `v*` tag).
5. Signing/notarization for macOS distribution; LGPL note for the ATRAC1 crate.
6. Nice to have: set a real date for clock-less discs at export ("these were taken on …"),
   slideshow with sound, album covers from `OV_IDX.PMX`, show `PDF_MD` contents.

### What Sony's Album Utility 1.5 did (from its help file) vs. MD1 Studio

| Sony Album Utility | MD1 Studio |
|---|---|
| "Open Camera": camera image list with thumbnails; copy selected images to an album | Done (thumbnail browser, download chosen photos, "In library" marks) |
| Export images as BMP / JPEG (quality 1–100) / TIFF | JPEG (with EXIF/XMP), PNG, TIFF; 1–3× |
| Image info: **protect**, **caption** (14 chars) and edited date, written back to the camera | Protect: written to the camera (confirmed: the camera refuses to delete it; it shows no mark). Captions and dates stay in the library: the MD1's headers carry tag 0x11, not ALBUM's 0x12 caption, and the camera has no way to show text |
| Rotate 90°/180°, stored in PIC_INF byte 5 | Written to the camera (confirmed; bits 2–3 count counter-clockwise turns); imports start out turned the same way |
| **Copy To Camera**: any BMP/JPEG, fitted to 640 × 480, Fine or Snapshot | Done (`author.rs`): JPEG/PNG/TIFF/BMP/GIF/WebP or library photos with edits; fit or fill; standard or fine |
| **Delete** pictures on the camera (`02 15`), skipping protected ones | Done without `02 15`: index edit + file delete, protected photos refused (tested on the camera) |
| Albums with titles; new / rename / delete; **set album cover** | Library albums with covers (rename, delete, add/remove). Camera-side albums (`PIC0000n` + OV_INF titles) not written |
| Find images by recorded / edited date (on, before, after) | Search box over captions, places, taken and import dates |
| Print an image or a **contact sheet** (n per row) | Contact sheets as 300 dpi JPEG pages (Letter/A4, 3–6 per row, date/caption/file labels) |
| Copy to clipboard (with a crop frame), paste from clipboard | Copy (with edits) to the clipboard |
| Captions or dates under thumbnails | Badges; captions/dates in the viewer and contact sheets |
| Slideshow (`SSHOW.EXE`) | Slideshow with sound, crossfades, loop |
| Monitor colour/gamma calibration | Not needed today |
| TWAIN source for other apps | Not planned |
| Thumbnail cache keyed on the status "change serial" (status bytes 18–21; MD1 returns FF) | Cache keyed on file size + directory-entry times |

Camera clock: no command found (lab-notebook §16). Writes still to try: camera-side albums with
titles, attaching sound to an uploaded photo (needs an ATRAC1 encoder), restoring a whole disc
from the app.

Hard safety rules (already enforced in `md1-core/src/camera.rs`): never send `02 10`, `02 15`;
writes only inside explicit user actions; cap path payloads (firmware hangs on ~138-byte paths);
always mirror first.
