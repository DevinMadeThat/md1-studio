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

v0.1 (built 2026-10-18) connects, imports, browses, plays sound and exports. Still to do:

1. **First real-camera run**: connect, import disc 1 properly (fills in its sound, thumbnails and
   times), re-import disc 2 (should copy only the added `PSN00019.PMP` + changed index files).
2. **Restore disc from backup** (port `md1tool/restore.py`): confirmation screen, battery check
   (status power ≥ 3), write-protect hint, verify every file, "power-cycle the camera" prompt.
3. **Add photos to the camera** (port `add_photo.py`): camera-made PMPs first; arbitrary JPEGs
   need a synthesized PMP header (see above).
4. Windows and Linux builds via `.github/workflows/build.yml` (push a `v*` tag).
5. Signing/notarization for macOS distribution; LGPL note for the ATRAC1 crate.
6. Nice to have: set a real date for clock-less discs at export ("these were taken on …"),
   slideshow with sound, album covers from `OV_IDX.PMX`, show `PDF_MD` contents.

Hard safety rules (already enforced in `md1-core/src/camera.rs`): never send `02 10`, `02 15`;
writes only inside explicit user actions; cap path payloads (firmware hangs on ~138-byte paths);
always mirror first.
