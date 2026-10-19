# Contributing

Thanks for helping keep these cameras useful. Bug reports, traces from other firmware versions,
disc dumps, translations and code are all welcome.

## Privacy first: traces and dumps contain your photos

* **Serial traces** (`md1tool/logs/*.log`, and MD1 Studio's `serial-*.log` in the OS log folder)
  record every byte read from the disc, which means your pictures and recorded sound. Before
  sharing one, scrub it:

  ```sh
  python3 app/tools/sanitize_trace.py my-session.log my-session.sanitized.log
  ```

  This zeroes photo, thumbnail and sound content but keeps file sizes, directory listings, index
  files and the whole protocol exchange, so the trace still replays. Check the result before
  you share it.
* **Disc mirrors** (`downloads/…`, `~/Pictures/MD1 Studio/…`) are your photos. Don't attach
  them to issues. If a bug needs a file, the index files (`PIC_INF.PMF`, `OV_INF.PMF`) and the
  first 256 bytes of a `.PMP` (its header) are usually enough.
* `.gitignore` already keeps `downloads/`, `md1tool/logs/` and camera file types out of git.

## Safety rules for code that talks to the camera

These rules exist because a disc was erased by sending an unexplored command:

1. Never send `02 10` (format) or `02 15` (delete picture). `md1-core` refuses them and the
   unit tests check that; keep it that way.
2. Write commands only inside an explicit, confirmed user action, and never in the app's
   default (read-only) mode.
3. Keep path payloads short. Firmware 1.14 hangs, and needs its battery pulled, on a find-first
   path of about 138 bytes. `md1-core` caps payloads at 96 bytes.
4. When exploring unknown commands, mirror the disc first, set the write-protect tab, and stop
   at the first silence. See docs/lab-notebook.md §9–10.

## Development

* App: `cd app && npm install && npm run tauri dev`; tests: `cargo test -p md1-core -p atrac1`.
* Without hardware: `python3 app/tools/fake_camera.py <mirror dir>`, then use the printed
  `/dev/ttys…` path (in the app: "Enter a port path by hand").
* Protocol or format discoveries: add them to `docs/protocol.md` / `docs/disc-format.md`, and
  log the experiment (date, what was sent, what happened) in `docs/lab-notebook.md`. Mark
  findings as **confirmed** on hardware or **inferred** from code.
* Rust: `cargo fmt`, `cargo clippy`. TypeScript: `npm run build` must type-check.
