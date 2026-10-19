# MD1 Studio

A desktop app for the Sony DSC-MD1 (MD Cyber-shot, 1997): connect the camera over its serial
cable, copy the whole MiniDisc byte for byte, and browse the photos with the sound recorded
alongside them. Built with Tauri 2 (Rust + web UI) for macOS, Windows and Linux.

Everything it relies on is documented in [`../docs/`](../docs/README.md); the protocol code
mirrors `md1tool/md1.py`, which was proven on a real camera.

## What it does (v0.1)

* **Connect**: lists serial ports (USB-serial adapters first), finds the camera at 9600 or
  115200 baud, says hello, switches to 115200. Live status: mode, power, picture count, clock,
  disc label, free space. Polls every 15 s, which also notices when the camera powers off.
* **Import a disc**: walks every folder, copies every file (photos `PSN*.PMP`, sound
  `NRA*.PMA`, thumbnails, the album/disc index files, and `PDF_MD` if present), then converts
  photos → JPEG and sound (ATRAC1) → WAV. Re-importing the same disc (recognized by its label +
  format time) only copies new photos; files that changed on the camera are kept under
  `history/`. Nothing is ever deleted.
* **Library**: discs in the sidebar; photo grid with sound / FINE badges; filters (all / sound /
  fine); a viewer with keyboard navigation, waveform sound player, and metadata (quality,
  shutter speed, flash, shot time, file).
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

Not in the app yet (the code paths exist in `md1-core` and `md1tool`): restoring a disc from a
backup and adding photos to the camera. They write to the disc, so they'll come with explicit
confirmation screens.

## Safety

`md1-core`'s `Camera` passes every frame through an allowlist (`camera.rs`):

* read commands are always allowed;
* write commands (mkdir, create, write, delete, rmdir) only after `set_writes_enabled(true)`,
  which the app never calls in v0.1;
* `02 10` (format — it erased a disc once), `02 15` (delete picture), `02 14`, `02 09`, `02 02`
  are refused unconditionally; so is any command not on the list, and any path payload over
  96 bytes (firmware 1.14 hangs on ~138-byte paths).

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

Windows and Linux builds: `../.github/workflows/build.yml` (tauri-action) builds all platforms on
a tag push. Locally, build each OS on that OS.

### Platform notes

| OS | Serial port | Notes |
|---|---|---|
| macOS | `/dev/cu.usbserial-…` | FTDI driver is built in. Opened with termios (like pyserial). |
| Windows | `COM3` etc. | FTDI driver comes from Windows Update. Uses the `serialport` crate. |
| Linux | `/dev/ttyUSB0` | User must be in the `dialout` (or `uucp`) group. termios. |

The unsigned macOS build opens with right-click → Open the first time (or sign/notarize it with
an Apple Developer ID; see Tauri's docs).

## Testing without the camera

```sh
python3 tools/fake_camera.py ../downloads/disc2/disc --stats-file /tmp/stats.json
# FAKE CAMERA ON /dev/ttys012
cargo run -p md1-core --bin md1 -- import /dev/ttys012 "/tmp/lib/Disc 2" "Disc 2"
```

In the app, choose "Enter a port path by hand" and type the `/dev/ttys…` path. The fake camera
starts at 9600 baud with its frame sequence mid-way (like the real one), serves the mirror with
the real camera's reply layouts, and `--allow-writes` applies writes to a temporary copy.

## Where things are stored

* Library (default): `~/Pictures/MD1 Studio/<disc name>/` — same layout as `md1tool`
  (`disc/`, `listing.txt`, `jpeg/`, `audio/`, `thumbnails/`, `disc-manifest.txt`) plus
  `disc.json` (name, camera, format time, import history).
* Map tiles (OpenStreetMap, cached): the OS cache folder. Place searches go to
  nominatim.openstreetmap.org only when you press Find / paste; nothing else leaves the machine.
* Settings: the OS app-config folder (`~/Library/Application Support/app.md1studio.desktop/`).
* Serial traces of every session (md1tool's log format, readable with `md1tool/trace.py`):
  the OS log folder (`~/Library/Logs/app.md1studio.desktop/`).

## Licences

App code: MIT. `crates/atrac1` is derived from FFmpeg and is LGPL-2.1-or-later; if you
distribute binaries, ship its source (this repo) alongside, or move it into a dynamic library.
