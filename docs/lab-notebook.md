# Lab notebook

Chronological record of experiments on the DSC-MD1 (all times 2026-10-18, local).
Serial traces for every session are in `md1tool/logs/` (decode with `md1tool/trace.py`).

## 1. Research and first contact (≈15:00)

* Manual (Japanese PDF) confirms: Digital I/O = 3.5 mm stereo minijack, RS-232C, 9.6–115.2 kbps;
  IrDA must be OFF for cable mode; disc write-protect tab; format prompt danger.
* Sony software ISO: hybrid ISO9660 + Apple HFS. Windows side 16-bit (ALBUM.EXE, TWAIN DS
  "Sony DSC-F1 TWAIN 1.5"), contains host IDs `SONY MKY-1001 1.00` and `SONY DSC-2050 1.00`
  and path `/PIC_MD/PIC%05d`. Conclusion: MD1 speaks the DSC-F1 protocol with MD paths.
* First probe: silence at every speed → IrDA was ON. After IrDA OFF: hello answered at
  **9600 baud**, camera ID `SONY MKY-2000 1.14`, status = playback, 20 pictures.
* Second session failed with `83` replies → discovered the cross-session sequence counter.
  Fixed by retrying hello with successive addresses.
* File info on guessed paths found `/PIC_MD/PIC00000/{PIC_INF.PMF,PSNnnnnn.PMP,PIDX000.PMX}` and
  `/PIC_MD/{OV_INF.PMF,OV_IDX.PMX}`.

## 2. Disc 1 download (15:12–15:40)

* 20 photos, `/PIC_MD/PIC00000/PSN00000–00019.PMP`, all Standard quality, 9600 baud,
  ~75 s each, 0 retries. JPEG at offset 0x100. Saved to `downloads/disc1/`.

## 3. Disc 2 download (15:43–16:16)

* One album `PIC00001` (PIC00000 absent → an album was deleted at some point), 16 photos:
  5 Standard, 11 Fine (header byte 0x1D: 0x17 / 0x33). All 640 × 480.
* Guessed audio paths (`SND*`, `*.PMA` next to photos, `SND_INF.PMF`…) — none existed at that time.
* Reading `/PIC_MD` as a file returned an 80×64 thumbnail-like blob, not a listing.

## 4. Sound recorded on purpose (≈17:00)

Owner enabled 音声同時記録 and shot photos 17–19 (PSN00016–18); photo 19 has sound.

## 5. Reverse engineering Sony's ALBUM.EXE (≈17:00)

Pattern-scan of NE code segments for `mov byte [..],imm` pairs, then capstone disassembly of
segment 4 (offsets 47342–53600). Command buffer at DS:24C5. Recovered the full command list
(see protocol.md), including find-first/find-next, set/get speed and volume info.

## 6. Hidden commands on the camera (17:04–17:12)

| Test | Result |
|---|---|
| `01 04` | speed code 0 |
| `02 01` | 81-byte volume info |
| `02 05 "/*.*"` | FF — wildcards not supported |
| `02 05 "/"`, `"/PIC_MD"` | OK — folder path works; find-next walks it |
| Root listing | **`/PDF_MD`** (unknown) and `/PIC_MD` |
| `/PIC_MD/PIC00001` listing | 19 photos + PIDX000.PMX + **`NRA00018.PMA`** (sound for photo 19) |
| `01 03 04` | camera switches to 115200; next frame NAKed once; stays at 115200 until power-off |
| `NRA00018.PMA` download at 115200 | 106 752 bytes in 28 s |
| PMA analysis | 256-byte header + 502 mono ATRAC1 sound units → 5.83 s; decoded via PyAV; 67 % of energy in 300–3400 Hz (speech) |
| `/PDF_MD` listing | FOLDER (empty), TITLES (16 × BOXSnnnn.TTL), STAMP/STAMP00.DAT, TOTAL.INF |
| TTL | all-zero 128 000-byte bitmaps |
| STAMP00.DAT | 60 × 24×24 1-bit stamps (rendered) |
| TOTAL.INF | "PDF-5", "topDir", "BOX 1".."BOX 16" → Sony PDF-5 document filer format |
| `02 18 00 n`, `02 17 …` (with and without an open file, both host IDs) | status 03 (unsupported) |
| Hello with host ID `DSC-2050` | camera answers `SONY DSC-RS 05.00 1.14` (vs `MKY-2000` for the F1 ID) |
| `02 0C` read length 2048 | OK; 4096 → no reply; 8192 → 0 bytes |
| `02 0A` open | returns a real handle (e.g. `00 09`) |
| Timestamps | first read as Unix time (1998-05-03); **corrected later**: DOS date/time → PDF_MD = 2006-10-12 18:40, photos = 1980-01-01 + time of day (dead clock battery) |

## 7. Firmware hang (17:12–17:13)

First `mirror` run: directory-walk bug treated the folder's self entry (name `01`) as a
subfolder, producing `find-first "/\x01/\x01/…"`. The camera answered each one with the root
listing. Payloads of 129–133 bytes worked; at **138 bytes** the camera stopped responding.
Camera showed "PC", power switch dead, required battery removal. Fixes: parse `01` names as
self, track visited entry numbers, cap payloads at 96 bytes.

## 8. Full mirror of disc 2 (17:21–)

Fixed walk listed the whole disc. Mirror at 115200 with 2048-byte reads: ~6.8 KB/s.
Result: 6 folders, 42 files, 4 237 686 bytes, all byte-exact; 19 JPEGs, 1 WAV, 20 thumbnails
extracted. SHA-256 manifest: `downloads/disc2/disc-manifest.txt`.

Diffs against the pre-shoot copies: `PIC_INF.PMF` record byte 7 = 1 for the photo with sound;
PMP headers have no sound flag.

## 9. Command sweep (17:31–17:40)

`md1tool/sweep.py`: bare two-byte commands, status check after each.
* `01 xx`: only hello / get-speed answer.
* `03 xx`: `03 01` and `03 03` return OK (unknown purpose); `03 02` status.
* `02 xx`: `02 07` → FE (unknown, supported); `02 0A` with no path → handle 0;
  **`02 10` → no reply, camera unresponsive to status → sweep stopped.**

## 10. Format incident (17:40)

Camera recovered by itself, but every path returned FF and volume info FF. After a power-switch
restart the camera showed **no photos**: `02 10` is a quick format (~50 s, matching the manual's
"クイックフォーマット 約50秒"). Disc 2 had been fully mirrored 20 minutes earlier, so nothing was
lost. Lesson: an unknown command that goes silent may be doing something long and destructive;
stop sweeping at the first silence, and write-protect the disc first.

Owner then took one photo with sound on the reformatted disc. Read-only walk: fresh layout with
no `PDF_MD`, volume label `PICTURE MD DATA`, 64 KB allocation units. Mirrored to
`downloads/disc2-reformatted/` (`PSN00000.PMP`, `NRA00000.PMA`).

Also observed: a power-switch restart does **not** reset the link speed (camera still at 115200);
only removing the battery does.

## 11. Restoring disc 2 from the mirror (17:50–18:12)

Write path taken from Sony's code (reverse-engineering-notes.md §1); new tool `md1tool/restore.py`.
* Single-file test: MKDIR `/PIC_MD/PIC00001`, create + write `PSN00000.PMP` in 1 KB chunks,
  read back → identical.
* Full run, first attempt: removed the post-format album (4 × `02 08` DELETE FILE + `02 04`
  RMDIR — all OK), created `/PDF_MD`, `FOLDER`, `STAMP`, `TITLES`. Writes ran at only ~0.85 KB/s
  (≈1.2 s per 1 KB chunk); stopped to optimise. Interrupting mid-frame made the camera drop back
  to 9600 baud.
* **2048-byte write chunks: ~7.5 KB/s, 9× faster**, verified identical (MiniDisc data sectors
  are 2 KB, so 1 KB writes cost a read-modify-write each).
* Full restore with 2 KB chunks: 40 files written + 2 already identical, every file read back
  and SHA-256-compared: all identical. Order: photos/sound/thumbnails → PIC_INF.PMF →
  OV_IDX.PMX / OV_INF.PMF → PDF_MD.
* Independent listing afterwards: 48 entries, same names and sizes as the pre-format listing.
* `01 02` (session end, sent by restore.py) returns the camera to 9600 baud.
* Not identical to the original at the sector level: the camera's format uses 64 KB clusters
  (original 8 KB), timestamps and entry numbers are new.

## 12. Owner verification of the restore (≈18:30)

After a power-switch restart the camera showed **all 19 photos again, and photo 19 played its
sound**. A disc rebuilt file-by-file over the serial link is fully accepted by the camera.
Camera came back at 115200 baud after that restart (not 9600).

## 13. `03 01`, `03 03`, `02 07` with the owner watching (18:35–18:38)

Sent twice, the second time with spoken announcements from the Mac (`say`) 15 s apart.
Replies: `03 01` OK, `03 03` OK, `02 07` FE, status normal. **No visible, audible or mechanical
effect**; the screen stayed on "PC" + three Japanese characters. Purpose remains unknown.

## 14. Uploading a photo (18:40–18:50)

* `02 14` (Sony's "Copy To Camera"): first frame answered with status **03 — unsupported on the
  MD1**. Nothing written.
* Manual method (`md1tool/add_photo.py`): wrote disc 1's original `PSN00000.PMP` as
  `/PIC_MD/PIC00001/PSN00019.PMP`, appended a PIL-generated 80×60(+4) thumbnail block to
  `PIDX000.PMX`, appended a record + bumped counts in `PIC_INF.PMF`, bumped both counts in
  `OV_INF.PMF`. All four files verified by read-back.
* After a power cycle the owner confirmed **photo #20 (the uploaded test picture) shows, and its thumbnail
  appears in the index view.**

## State at end of session (2026-10-18 ≈18:50)

* Disc in the camera: **disc 2 as restored + one added photo** (`PSN00019.PMP`, 20 pictures).
  Its exact pre-addition state = `downloads/disc2/disc/` (manifest `disc-manifest.txt`).
* Disc 1: only photos and `PIC_INF.PMF` downloaded (before directory listing existed); not yet
  re-listed for sound files, thumbnails or timestamps.
* Camera battery low; session paused.

## 15. Desktop app, no camera attached (2026-10-18 evening)

Started **MD1 Studio** (`app/`, Tauri 2 + Rust); see `app/README.md`. Verified without hardware:

* **Replay of a real session**: `app/crates/md1-core/tests/replay.rs` feeds the camera's
  recorded replies from the post-format mirror (`20261018-173447-mirror.log`) to the Rust client;
  every frame it sends (hello with one NAK retry, status, directory walk, every open / 2 KB read /
  close with real handles) is **byte-identical** to what md1.py sent the real camera.
* **ATRAC1 in Rust** (`crates/atrac1`, port of FFmpeg's decoder): max difference vs FFmpeg 6e-8
  on both sound files; WAVs within 1 LSB of md1tool's.
* **Fake camera** (`app/tools/fake_camera.py`): md1.py `mirror` through it reproduces
  `downloads/disc2/disc` exactly; the Rust `md1 import` through it gives an identical mirror and
  `listing.txt`, identical JPEGs, and zero dangerous commands (fake camera's counters).
* Observed on the fake (modelled on the real traces): after `01 03` the next frame at address
  index 0 is accepted without a NAK, so the client resets its index to 0 after a speed change.

**Data loss (mine):** while cleaning up its test logs, a helper agent deleted 9 older files in
`md1tool/logs/` by pattern: `post-format-walk.log`, `post-restore-walk.log`, `walktest.log`,
`sweep-01-03.out`, `sweep-02-07.out`, `sweep-results.tsv`, `upload-test.log`,
`watch-test.log`, `watch-test2.log`. No backup existed. Their results are in this notebook and
in protocol.md; partial reconstructions from the session transcript are in
`md1tool/logs/recovered-from-transcript/`. The dated `md1.py` session logs are intact.

## 16. Real camera with the app's Rust code (2026-10-19, ≈17:00–17:40)

Disc 2 (restored + `PSN00019`, 20 photos) in the camera, on battery (power 4). Traces:
`md1tool/logs/*-rust-*.log`.

* **App's first real session (owner):** connect, thumbnail browse, download of `PSN00019`
  only. Worked.
* **Clock: no luck.** `03 03` and `03 01` with a BCD date/time in five layouts (`YY MM DD hh mm
  ss`, 4-digit year `20 YY …`, and a leading `01` selector) all return status `00` and change
  nothing: the status clock stays `50-01-01`. No Sony program sets the clock either
  (reverse-engineering-notes §5). Setting it would need the untested command space; not swept.
* **Added a photo the camera didn't take** (`md1 add`, md1-core `author.rs`): a Wikimedia JPEG
  fitted to 640 × 480, encoded baseline 4:2:0 and rewritten into the camera's JPEG layout (no
  APPn, DQT/DHT before SOF0, component ids 0/1/2), with a synthesized 256-byte PMP header
  (template from a camera STD photo, quality byte 0x17, exposure fields 0x8000 = unknown,
  flash 0). Wrote `PSN00020.PMP` (37 876 bytes), `PIDX000.PMX` (+1 block), `PIC_INF.PMF`
  (+1 record, counts 21), `OV_INF.PMF`; every file read back identical. Rust `write_file`
  (delete, create, 2 KB writes, close) worked first time on the hardware.
* **Album-index edits:** photo 1 record byte 5 |= 0x04 (rotation, one quarter turn per Sony's
  code), photo 2 record byte 14 bit 0 (protect). Read back identical.
* Correction: `OV_INF.PMF` holds the album number at **0x120** (0001 on disc 2, 0000 on the
  camera-formatted disc), not 0x122.
* **Owner's check after a power cycle:** photo 21 (the uploaded picture) appears and displays.
  Photo 1 is shown turned **counter-clockwise**, so the rotation bits count counter-clockwise
  quarter turns (the app now writes and reads them that way). Photo 2 shows **no protect mark**,
  but the camera's delete button refuses it: choosing the first delete option gives a message
  in red, while an unprotected photo offers two options. So byte 14 bit 0 is the protect flag.
* Library imports now start a photo turned the way the camera shows it (unless it was already
  edited in the library).
* **Deleted photo 21** (the test upload) with `md1 del`: record and thumbnail block removed from
  `PIC_INF.PMF`/`PIDX000.PMX`, counts updated in both index files, then `PSN00020.PMP` deleted
  (`NRA00020.PMA` didn't exist and was skipped). Browse afterwards: 20 photos, 20 thumbnails.
  Rehearsed first on the fake camera, including a photo with sound.
* **Format from the app**: rehearsed on the fake camera (`md1 format` with the confirmation
  phrase; the fake goes silent, then serves an empty disc).

## 17. Owner formats disc 2 from the app (2026-10-19 evening)

The owner used **Format disc…** in MD1 Studio on disc 2 (everything on it already backed up).
It worked: the camera went quiet, the app reported success and disconnected. **The camera kept
showing “PC”** afterwards; switching it off and on cleared that. After reconnecting, the camera
took a photo normally. The app now says beforehand what will happen and shows these next
steps after a format (switch off and on, Diary mode, take a photo before sending pictures).
