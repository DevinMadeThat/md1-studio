# Hardware and setup

## What works (confirmed 2026-10-18)

```
DSC-MD1 "DIGITAL I/O" jack (3.5 mm TRS, RS-232C)
   └─ Qaoquda "DB9 female ↔ 3.5 mm male" RS-232 cable (DB9 pins 2/3/5 → tip/ring/sleeve)
        └─ OIKWAN USB-to-RS232 adapter (FTDI FT232R, male DB9)
             └─ USB-A → USB-C adapter → MacBook (macOS 15, Apple Silicon)
```

Parts: [OIKWAN USB to RS232 (FTDI)](https://www.amazon.com/dp/B0759HSLP1) and
[Qaoquda DB9 female to 3.5 mm cable](https://www.amazon.com/dp/B06WLP4LTP).

* macOS uses its built-in FTDI driver; the port appears as `/dev/cu.usbserial-<serial>`
  (the suffix is the adapter's serial number). Nothing to install.
* No null-modem adapter was needed: the cheap TRS cable's TX/RX happen to match the camera.
* Linux (`/dev/ttyUSB0`, user in the `dialout`/`uucp` group) and Windows (`COMn`, FTDI driver
  from Windows Update) should work the same; untested with a real camera so far. Per-OS install
  steps are in the [top-level README](../README.md#install).

## Camera preparation

1. Power from the AC adapter or a full battery (a session stalls if the camera powers down).
2. Function switch → **再生/オーディオ** (playback).
3. MENU → 準備 (Setup) → **IrDA → OFF**. With IrDA ON the cable jack is ignored.
4. Optional: 準備 → パワーセーブ → OFF to stop the screen sleeping.
5. Plug the cable into **デジタルI/O端子** — on the jog-dial side, below DC IN, under the rubber
   flap (lowest of the three openings there). Not the headphone jack on the other side.
6. For safety while experimenting, slide the disc's write-protect tab so the hole is open.

While a session is active the camera shows "PC" and three Japanese characters (probably 通信中, "communicating"); the camera's buttons are ignored.

## Where the jacks are

* Power-switch side: mic/line-in, AV OUT, headphone/remote jack (top to bottom). The headphone
  jack carries playback audio for analog capture.
* Jog-dial side: IrDA window, DC IN, DIGITAL I/O (top to bottom).

See `cheatsheet/MD1-diagram-*.png` for labelled drawings.

## Known quirks

| Symptom | Cause / fix |
|---|---|
| No reply at any speed | IrDA is ON, wrong jack, camera asleep, or camera still at a speed set earlier (try 115200). |
| Hello answered by an empty `83` frame | Sequence mismatch from a previous session; resend with the next address (md1.py does this). |
| Camera frozen with "PC" on screen, power switch dead | Firmware hang. Remove the battery. Triggered reproducibly by a ~138-byte path; has also happened occasionally on its own (owner's experience). |
| Silence after a speed change | Camera keeps the new speed until the battery is removed (a power-switch restart keeps it). Try 115200 first. |
| Camera silent for ~50 s, then every path "not found" | Something started a format (`02 10`). Never send unknown commands without a full mirror and the write-protect tab set. |
| Camera's clock reads 1950/1970 | Dead internal clock battery; timestamps restart at each power loss. |

## Software pieces

* `md1tool/md1.py` — Python 3 + pyserial CLI (probe, ls, get, pull, mirror, raw). Read-only.
* `md1tool/restore.py` — writes a mirror back to a disc (mkdir/create/2 KB writes/verify). Gated by `--yes-write-to-the-disc`.
* `md1tool/add_photo.py` — appends a camera-format photo to an album (PSN + thumbnail + index edits).
* `md1tool/photo_info.py` — per-photo metadata (quality, shutter, flash, sound, time) → CSV.
* `md1tool/trace.py` — decodes the per-session serial traces in `md1tool/logs/`.
* `md1tool/sweep.py` — command-code sweep. **Dangerous** (found the format command the hard way); gated.
* PyAV (bundled ffmpeg) + numpy decode ATRAC1 sound to WAV.
* `SONYDSCUv15.iso` — Sony Digital Still Camera Utility 1.5 (Windows 3.1/95, 16-bit; classic
  Mac OS 68k/PPC). Does not run on modern 64-bit Windows or macOS; its value here was as a
  protocol reference (see reverse-engineering-notes.md).
