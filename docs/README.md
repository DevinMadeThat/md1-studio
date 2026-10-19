# Sony DSC-MD1 (MD Cyber-shot) — reverse-engineering notes

Getting photos and sound off a 1997 Sony DSC-MD1 MiniDisc camera with a modern computer, and
documenting how it works so an app can be built on top.

| Document | Contents |
|---|---|
| [hardware-and-setup.md](hardware-and-setup.md) | Cables, camera settings, jack locations, quirks and recovery, tool list |
| [protocol.md](protocol.md) | Serial framing, sequence numbers, every known command (read + write), sweep results, hazards |
| [disc-format.md](disc-format.md) | Folder tree; PMP / PMA / PMF / PMX / PDF_MD formats; timestamps; adding a photo by hand |
| [reverse-engineering-notes.md](reverse-engineering-notes.md) | Findings from disassembling Sony's 1997 software (ALBUM.EXE, TWAIN DS, Mac code) |
| [lab-notebook.md](lab-notebook.md) | Chronological log of every experiment and result, incl. the format incident |
| [next-steps.md](next-steps.md) | Open questions, untested commands, app ideas |
| [references.md](references.md) | Sony software/manual, community posts, related open-source code, hardware |
| [../app/README.md](../app/README.md) | **MD1 Studio**, the desktop app (Tauri + Rust): build, test, safety, layout |

## What works (all confirmed on the camera, 2026-10-18)

| Capability | How |
|---|---|
| Read photos byte-exact | open / read (2 KB) / close; JPEG at offset 0x100 of each `PSN*.PMP` |
| **Read sound recorded with photos** | hidden `NRA*.PMA` files, ATRAC1 → WAV via PyAV |
| List any folder | undocumented find-first / find-next (`02 05` / `02 06`) |
| ~8× faster link | undocumented set-speed `01 03 04` → 115200 baud |
| Thumbnails, per-photo metadata | `PIDX*.PMX` blocks; PMP TLV header (quality, shutter, flash) |
| **Write files** | mkdir / create / 2 KB writes / delete / rmdir (~7.5 KB/s) |
| **Restore a whole disc from a mirror** | `restore.py` — camera showed all photos and played the sound again |
| **Add a photo to the camera** | `add_photo.py` — photo + thumbnail + index edits; camera displays it |

**Danger:** `02 10` formats the disc with no confirmation (learned by erasing a disc that had
been mirrored minutes earlier). `02 15` deletes pictures. See protocol.md "Firmware hazards".

## Tooling (`md1tool/`, Python 3 venv at `md1tool/.venv`: pyserial, av, numpy, pillow)

```
md1.py --id f1 probe                                    # finds the speed (9600 or 115200), handshake + status
md1.py --baud 9600 --speed 115200 ls / /PIC_MD           # list folders (camera then stays at 115200)
md1.py --baud 115200 mirror --disc disc3                 # copy every file, convert photos / sound / thumbnails
md1.py --baud 115200 get /PIC_MD/PIC00001/NRA00018.PMA -o x.pma
md1.py --baud 115200 raw "02 05 s:/PIC_MD"               # whitelisted command, raw replies
restore.py downloads/disc2/disc --chunk 2048 --yes-write-to-the-disc   # write a mirror back
add_photo.py downloads/disc1/raw/PIC00000/PSN00000.PMP --album PIC00001
photo_info.py downloads/disc1 downloads/disc2 > photo-metadata.csv
trace.py md1tool/logs/<session>.log                      # decode a serial trace
```

## Desktop app

`app/` holds **MD1 Studio** (macOS now; Windows/Linux via the CI workflow): connect, import a
whole disc, browse photos with their sound, export JPEG+EXIF and WAV. Rust core
(`app/crates/md1-core`), ATRAC1 decoder (`app/crates/atrac1`), fake camera for testing
(`app/tools/fake_camera.py`). Read-only towards the camera in v0.1.

## Data on disk (the original investigator's machine; not in the repository)

The lab notebook refers to these folders. `downloads/` and `md1tool/logs/` are git-ignored because
they contain the photos and sound.


* `downloads/disc1/` — 20 photos (raw PMP + JPEG); not yet re-mirrored with the directory walk.
* `downloads/disc2/` — full byte-exact mirror (`disc/`), JPEGs, WAV, thumbnails, SHA-256 manifest.
* `downloads/disc2-reformatted/` — the one photo + sound taken after the accidental format.
* `downloads/photo-metadata.csv` — per-photo quality / shutter / flash / sound / time.
* `cheatsheet/` — phone cheat sheets, menu maps, relabelled diagrams (English).
