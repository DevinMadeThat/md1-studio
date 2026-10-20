# MD1 Studio

A desktop app for the Sony DSC-MD1 (MD Cyber-shot, 1997): connect the camera over its serial
cable, copy the whole MiniDisc byte for byte, and browse the photos with the sound recorded
alongside them. Built with Tauri 2 (Rust + web UI) for macOS, Windows and Linux.

Everything it relies on is documented in [`../docs/`](../docs/README.md); the protocol code
mirrors `md1tool/md1.py`, which was proven on a real camera.

![The camera screen: the disc's photos as thumbnails, four chosen to download](../docs/images/screenshot-camera.jpg)

## What it does (v0.1)

* **Connect**: lists serial ports (USB-serial adapters first), finds the camera at 9600 or
  115200 baud, says hello, switches to 115200. Live status: mode, power, picture count, clock,
  disc label, free space. Polls every 15 s, which also notices when the camera powers off.
* **Browse the camera** (`md1-core/src/browse.rs`): reads only the listing, the album indexes
  and the camera's own 80 × 60 thumbnails (`PIDX*.PMX`, 4 KB a photo), so a disc's photo list
  appears in seconds. Those files are cached per disc by size and directory-entry times, so
  browsing again reads nothing that hasn't changed. Each photo is matched against the library
  (same file size, plus the same creation time, thumbnail, or album and number; a disc restored
  from a backup gets new file times but keeps the rest) and marked **In library**.
* **Download chosen photos**: the picked `PSN*.PMP` files and their `NRA*.PMA` sound, plus
  the small index and thumbnail files (reused from browsing, not read twice), then photos →
  JPEG and sound (ATRAC1) → WAV. Each photo's import time is recorded in `disc.json`.
* **Back up the whole disc**: every file (including `PDF_MD` if present), so it can be restored.
  Either way, photos from one disc go into one folder (recognized by its label + format time);
  files that changed on the camera are kept under `history/`. Nothing is ever deleted.
* **Library**: **All photos** across every disc folder, grouped by import day (newest first),
  plus each disc on its own (with a count of photos not downloaded yet); sound / FINE badges;
  filters (all / ★ / sound / fine); a viewer with keyboard navigation, waveform sound player,
  and metadata (quality, shutter speed, flash, shot time, import date, file).
* **Viewer**: pinch / ⌘± / double-click to zoom, drag or two-finger scroll to pan; the zoom and
  position carry over as you step through photos. Optional auto-play and loop of the sound.
* **Edit metadata** (one photo, or a selection: shift-click for ranges, ⌘-click to toggle, ⌘A):
  * **Location**: search a place (OpenStreetMap's Nominatim geocoder; no account or key), or
    paste coordinates in any common form or a Google/Apple Maps link (short `maps.app.goo.gl`
    links are expanded). Shows a map preview; remembers recent places.
  * **Date & time**: set it for one photo, the same for many, or "keep the time between shots"
    (the earliest gets the date you enter; the rest keep the gaps the camera recorded, which
    still works when the camera's clock battery is dead).
  * **Rotate** left/right, **favourite** (★, F key; filter by favourites), **caption**.
* **Photo editor** (E in the viewer):
  * Adjust: **auto-enhance** (per-channel levels that remove half of a colour cast so lamp-lit
    rooms stay warm, plus a gentle midtone lift), **brightness, contrast, warmth, saturation**,
    and **noise & blockiness** cleanup (edge-preserving bilateral filter).
  * Crop & straighten: aspect presets (free, original, square, 4:3, 3:2, 16:9; portrait photos
    get portrait crops), ±15° straighten (auto-fills, no blank corners), rotate, flip.
  * Batch: auto-enhance or favourite a whole selection.
  * The live preview (`ui/src/look.ts`) and the export renderer (`crates/md1-core/src/adjust.rs`)
    implement the same formulas; `tools/check_look_parity.ts` checks they agree pixel-for-pixel.
  Edits live in `<disc>/edits.json`; the camera files in the backup are never modified.
* **Export**: selected photos or a whole disc, at original size or **2×/3× upscaled**
  (Lanczos + light sharpening), with or without edits → JPEGs with EXIF (Sony DSC-MD1,
  shutter, flash, your date (or the camera's when its clock was set), GPS, caption) and XMP
  (caption, place, ★ favourite as rating 5) that Photos and Lightroom read, plus a matching
  `.wav` for photos with sound. A rotation-only photo keeps its original JPEG data.
* **Open old backups**: "Add backup folder…" accepts any `downloads/discN` folder made by
  `md1tool` (full mirrors and the older photo-only `raw/` layout).

* **Imports and albums**: the sidebar lists each import (by date and time, like Apple Photos'
  Imports) and the user's albums (`<library>/albums.json`: ordered item keys and a cover). The
  per-disc folders sit in a collapsed "MiniDiscs" list; new ones are named after the day they
  were first imported (`MiniDisc 2026-10-19`).
* **Help** (`ui/src/help.ts`): how-to topics, the labelled camera drawings, the cheat-sheet images and
  `cheatsheet/md1_cheatsheet_data.json`, bundled from `../cheatsheet/` at build time (Vite
  `import.meta.glob`, so the images aren't duplicated in the repo), searchable in English or
  Japanese; cheat sheets open full screen with zoom.
* **Camera thumbnails on connect** are optional (toggle on the connect and camera screens).
* **Search**, **slideshow with sound** (`ui/src/slideshow.ts`), **copy to clipboard**, **contact
  sheets** (`ui/src/contactSheet.ts`, 300 dpi JPEG pages), export as **JPEG, PNG or TIFF**.
* **Write to the camera** (`crates/md1-core/src/author.rs`), always after a confirmation sheet
  that warns when the camera is on battery:
  * *Add pictures*: any image or library photo → 640 × 480 (fit or fill) → baseline 4:2:0 JPEG
    in the camera's own layout (no APPn, tables before the frame header, component ids 0/1/2)
    with a synthesized PMP header, an 80 × 64 thumbnail block, and the album index and album
    list updated. Proven on the hardware 2026-10-19 (docs/lab-notebook.md §16).
  * *Rotate / protect*: PIC_INF record byte 5 bits 2–3 (counter-clockwise quarter turns) and
    byte 14 bit 0, where Sony's software keeps them. Both confirmed on the camera: it shows the
    turn, and refuses to delete a protected photo (it shows no mark for protection). Photos
    turned on the camera start out turned the same way when imported.
  * The album is edited only if it matches the layout we've proven (counts agree, one thumbnail
    block per photo, a single album on the disc); every file is read back and compared; the
    files the app writes are the photo first, then the indexes.

* **Delete from the library**: the photo's files (PMP, sound, JPEG, WAV) go to the system Trash
  (`trash` crate); its edits and import time are forgotten and it leaves any albums.

Not in the app yet: restoring a whole disc from a backup (`md1tool/restore.py`), camera-side
albums, and sound for uploaded photos.

## Safety

`md1-core`'s `Camera` passes every frame through an allowlist (`camera.rs`):

* read commands are always allowed;
* write commands (mkdir, create, write, delete, rmdir) only after `set_writes_enabled(true)`,
  which `author::write_files` turns on for the duration of a write the user confirmed;
* `03 01` / `03 03` with parameters only through `transact_experimental` (used by `md1 try`);
* `02 10` (format — it erased a disc once), `02 15` (delete picture), `02 14`, `02 09`, `02 02`
  are refused by the allowlist; so is any command not on the list, and any path payload over
  96 bytes (firmware 1.14 hangs on ~138-byte paths). The one exception is
  `Camera::format_disc`, which sends `02 10` only when given the exact confirmation phrase in
  `camera::FORMAT_CONFIRMATION`; the UI asks three times (type FORMAT, then a 5-second countdown)
  before it calls it, and the backend refuses below battery level 3.
* Deleting photos on the camera doesn't use `02 15` (its argument was never pinned down: list
  position or photo number); it removes the photo's index record and thumbnail block, writes the
  indexes, then deletes `PSN`/`NRA` files with `02 08`. Protected photos are refused.

Unit tests assert this, and the fake camera counts any dangerous command it receives.

## Layout

```
app/
├── crates/
│   ├── md1-core/     protocol (frame, transport, camera), disc formats, import, library, export
│   │   ├── src/bin/md1.rs          command-line front end (ports, probe, ls, import, scan, wav, export)
│   │   └── tests/replay.rs         replays a real camera session (media bytes blanked) byte for byte
│   └── atrac1/       ATRAC1 decoder, a Rust port of FFmpeg's (LGPL-2.1+); matches FFmpeg to 6e-8
├── src-tauri/        Tauri backend: commands, settings, camera session, events
├── ui/               frontend (TypeScript, no framework): index.html, src/main.ts, styles.css
└── tools/
    ├── fake_camera.py         a fake DSC-MD1 on a pseudo-terminal, for testing without hardware
    ├── sanitize_trace.py      blank photo/sound bytes out of a serial trace before sharing it
    └── make_atrac1_fixture.py regenerate the synthetic ATRAC1 test vectors (needs PyAV)
```

## Building

Requirements: Rust (rustup), Node 20+. On Linux also `libwebkit2gtk-4.1-dev`,
`libudev-dev` and the other [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```sh
cd app
npm install
npm run tauri dev        # run with hot reload
npm run tauri build      # release: src-tauri/../target/release/bundle/{macos,dmg}/…
cargo test -p md1-core -p atrac1
```

`../.github/workflows/build.yml` (tauri-action) builds every platform: pushing a `v*` tag makes a
draft GitHub release with the installers; running the workflow by hand ("Run workflow" on the
Actions tab) builds them as downloadable artifacts without a release. Locally, build each OS on
that OS. Per-OS prerequisites are in the [top-level README](../README.md#build-from-source).

### Platform notes

| OS | Serial port | Notes |
|---|---|---|
| macOS | `/dev/cu.usbserial-…` | FTDI driver is built in. Opened with termios (like pyserial). |
| Windows | `COM3` etc. | FTDI driver comes from Windows Update. Uses the `serialport` crate. |
| Linux | `/dev/ttyUSB0` | User must be in the `dialout` (or `uucp`) group. termios. |

The builds aren't signed. On macOS, the first launch needs System Settings → Privacy & Security →
Open Anyway (or `xattr -dr com.apple.quarantine "/Applications/MD1 Studio.app"`); on Windows,
SmartScreen's More info → Run anyway. Signing needs an Apple Developer ID / a Windows code-signing
certificate; tauri-action picks them up from repository secrets (see Tauri's docs).

## Testing without the camera

```sh
python3 tools/fake_camera.py ../downloads/disc2/disc --stats-file /tmp/stats.json
# FAKE CAMERA ON /dev/ttys012
cargo run -p md1-core --bin md1 -- browse /dev/ttys012                  # photo list (JSON)
cargo run -p md1-core --bin md1 -- get /dev/ttys012 "/tmp/lib/Disc 2" /PIC_MD/PIC00001/PSN00018.PMP
cargo run -p md1-core --bin md1 -- import /dev/ttys012 "/tmp/lib/Disc 2" "Disc 2"   # whole disc
```

In the app, choose "Enter a port path by hand" and type the `/dev/ttys…` path. The fake camera
starts at 9600 baud with its frame sequence mid-way (like the real one), serves the mirror with
the real camera's reply layouts, and `--allow-writes` applies writes to a temporary copy.

### Self-test inside the real app

The UI harness used during development mocks Tauri's IPC, so it can't catch problems in the real
web view (that's how a too-strict Content-Security-Policy once broke the editor). Run the
built app with `MD1_DIAG=1` to have it check, from inside the web view, that binary IPC
results arrive as `ArrayBuffer`s, that a photo decodes, that map tiles load, and that asset
URLs can be fetched; results are printed to stderr as `DIAG …`:

```sh
MD1_DIAG=1 "target/release/bundle/macos/MD1 Studio.app/Contents/MacOS/md1-studio"
```

With `MD1_DIAG_PORT=/dev/ttys…` (a fake camera) as well, it also connects, browses the camera
through IPC, and checks that the thumbnails decode. Browsing only reads, so this is safe.

## Where things are stored

* Library (default): `~/Pictures/MD1 Studio/Disc N/`, one folder per physical disc — same
  layout as `md1tool` (`disc/`, `listing.txt`, `jpeg/`, `audio/`, `thumbnails/`,
  `disc-manifest.txt`) plus `disc.json` (name, camera, format time, import history, per-photo
  import times). After a selective download `disc/` holds only the photos you picked (and every
  index file), so it isn't a complete backup until you use **Back up the whole disc**.
* Camera index cache (thumbnails and album indexes from browsing): the OS cache folder,
  `camera/<disc label + format time>/`.
* Map tiles (OpenStreetMap, cached): the OS cache folder. Place searches go to
  nominatim.openstreetmap.org only when you press Find / paste; nothing else leaves the machine.
* Settings: the OS app-config folder (`~/Library/Application Support/app.md1studio.desktop/`).
* Serial traces of every session (md1tool's log format, readable with `md1tool/trace.py`):
  the OS log folder (`~/Library/Logs/app.md1studio.desktop/`).

## Licences

App code: MIT. `crates/atrac1` is derived from FFmpeg and is LGPL-2.1-or-later; if you
distribute binaries, ship its source (this repo) alongside, or move it into a dynamic library.
