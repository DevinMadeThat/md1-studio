# MD1 Studio

Get photos **and their recorded sound** off a **Sony DSC-MD1** (MD Cyber-shot, 1997), the
camera that recorded 640×480 JPEGs onto MiniDisc (MD DATA) discs, using a modern computer and a
cheap serial cable.

This repository has three parts:

| Folder | What it is |
|---|---|
| [`app/`](app/README.md) | **MD1 Studio**: a desktop app for macOS, Windows and Linux (Tauri + Rust). Connect the camera, copy a whole disc, browse photos with their sound, and export JPEGs (with EXIF) and WAVs. |
| [`docs/`](docs/README.md) | **What we know about the camera**: the serial protocol, the on-disc file formats (including the hidden ATRAC sound files), findings from Sony's 1997 software, and a dated lab notebook of every experiment. |
| [`md1tool/`](md1tool/) | The original **Python research tools**, used to work all of this out against a real camera: download, mirror, restore a disc, add a photo, decode traces. |
| [`cheatsheet/`](cheatsheet/README.md) | **English cheat sheets** for the Japanese-only camera: buttons, every menu, on-screen messages. |

## What works

All confirmed on a real DSC-MD1 (firmware 1.14):

* Reading every file on the disc, byte for byte, at 115,200 baud (the camera starts at 9,600).
* **Sound recorded with a photo**: stored as hidden `NRAnnnnn.PMA` files (mono ATRAC1) that
  Sony's own PC software never read. Decoded to WAV.
* Photo metadata: quality (standard/fine), shutter speed, flash, shot time.
* Writing: restoring a whole disc from a backup, and adding a photo to an album (Python tools;
  coming to the app).

## Quick start

**Hardware**: a USB–RS-232 adapter (FTDI chip recommended) and a "DB9 female to 3.5 mm TRS"
RS-232 cable into the camera's DIGITAL I/O jack. On the camera, set the function switch to
playback (再生) and turn IrDA off (MENU → 準備 → IrDA → OFF). Details:
[docs/hardware-and-setup.md](docs/hardware-and-setup.md).

**App**: see [app/README.md](app/README.md) to build it (`npm install && npm run tauri build`).
Releases for each OS are built by GitHub Actions when a `v*` tag is pushed.

**Python tools**:

```sh
python3 -m venv md1tool/.venv && md1tool/.venv/bin/pip install pyserial av numpy pillow
md1tool/.venv/bin/python md1tool/md1.py probe                  # find the camera
md1tool/.venv/bin/python md1tool/md1.py --baud 9600 --speed 115200 mirror --disc mydisc
```

## ⚠️ Be careful with your disc

The camera obeys commands without confirmation, and one of them, `02 10`, **formats the disc**.
We found that out by erasing one (it was restored from a backup made minutes earlier). The app
and `md1tool` refuse to send it, and the app never writes to the disc. Before trying anything
experimental yourself, mirror the disc first. See
[docs/protocol.md → Firmware hazards](docs/protocol.md#firmware-hazards-confirmed).

## Testing without a camera

[`app/tools/fake_camera.py`](app/tools/fake_camera.py) emulates a DSC-MD1 on a
pseudo-terminal, built from real camera traces. Both the app and `md1tool` work against it.
The Rust tests replay a real camera session (with the photo and sound content blanked out).

## Contributing

Have a DSC-MD1, a DSC-F1, or another Sony MD DATA device? Traces, disc dumps and corrections
are very welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) first: serial traces contain
your photos, and there's a script to scrub them.

## Credits

* The DSC-F1 protocol work in [libgphoto2](https://github.com/gphoto/libgphoto2)
  (`camlibs/sonydscf1`) and chotplay, which pointed the way.
* [FFmpeg](https://ffmpeg.org/)'s ATRAC1 decoder, ported to Rust in `app/crates/atrac1`.
* Community notes on the MD1 and Sony's DSC Utility 1.5; see
  [docs/references.md](docs/references.md).

Sony, Cyber-shot and MiniDisc are trademarks of Sony Group Corporation. This project is not
affiliated with or endorsed by Sony.

## License

MIT (see [LICENSE](LICENSE)), except `app/crates/atrac1`, which is derived from FFmpeg and
licensed LGPL-2.1-or-later (see [NOTICE](NOTICE)).
