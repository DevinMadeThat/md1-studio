# DSC-MD1 disc layout and file formats

What is on an MD DATA disc recorded by a DSC-MD1, as seen through the camera's serial
filesystem (see [protocol.md](protocol.md)). Observed on two discs; "disc 2" below is the one
that was fully listed.

## Folder tree (disc 2, confirmed)

```
/
├── PDF_MD/                     Sony PDF-5 "document filer" structure (created at format time)
│   ├── FOLDER/                 empty
│   ├── TITLES/
│   │   ├── BOXS0000.TTL … BOXS0016.TTL   (16 files, no BOXS0006) 128 032 bytes each
│   ├── STAMP/
│   │   └── STAMP00.DAT         18 464 bytes — 24×24 1-bit stamp glyphs
│   └── TOTAL.INF               1 012 bytes — filer index ("PDF-5", "topDir", "BOX 1"…"BOX 16")
└── PIC_MD/                     Picture MD (the camera's photos)
    ├── OV_INF.PMF              336 bytes — album list ("overview")
    ├── OV_IDX.PMX              4 096 bytes — album cover thumbnails
    └── PICnnnnn/               one folder per album (PIC00000 on disc 1, PIC00001 on disc 2)
        ├── PIC_INF.PMF         album index
        ├── PIDXnnn.PMX         thumbnail index (attribute 4080)
        ├── PSNnnnnn.PMP        one photo each
        └── NRAnnnnn.PMA        sound recorded with photo nnnnn (only for photos that have sound)
```

Albums are numbered; an album folder disappears when the album is deleted, so numbering can
start above 0 (disc 2 starts at `PIC00001`).

**Important:** the album index `PIC_INF.PMF` does not list sound files. The only way to find
`NRA*.PMA` files is a directory listing (`02 05`/`02 06`), which Sony's own PC software never
used for sound.

## Freshly formatted disc (camera's own format, confirmed)

After the camera formats a disc (`02 10`, same as the menu's quick format) and one photo with
sound is taken:

```
/PIC_MD/OV_INF.PMF            336
/PIC_MD/OV_IDX.PMX           4096
/PIC_MD/PIC00000/PIC_INF.PMF 1308
/PIC_MD/PIC00000/PSN00000.PMP
/PIC_MD/PIC00000/PIDX000.PMX 4096
/PIC_MD/PIC00000/NRA00000.PMA
```

* **No `PDF_MD`.** The camera does not create it, so on disc 2 it came from another MD DATA
  device (the disc's original format, 2006-10-12), e.g. a Sony PDF-5.
* Volume label (volume-info bytes 3–34): `PICTURE MD DATA` (blank on the PDF-5-formatted disc).
* Allocation unit: volume-info field `00 20` (32 sectors = 64 KB, the MiniDisc cluster) versus
  `00 04` (8 KB) on the PDF-5 format; unit counts 2202 total / 2130 free versus 17616 / 15838.

## Timestamps

Directory entries carry 32-bit **DOS-style packed date/time** values, big-endian
(`YYYYYYYM MMMDDDDD HHHHHMMM MMMSSSSS`, year from 1980, seconds/2) — identified from Sony's code
(reverse-engineering-notes.md §0.7); the 1980 base is assumed.

* `PDF_MD` entries on disc 2: `0x354C9501` = **2006-10-12 18:40:02** — when that disc was first
  formatted by another MD DATA device.
* Photos: date word always `0x0021` = **1980-01-01** (the camera's clock is unset because its
  backup battery is dead); only the time-of-day part advances, so the values give **shot order
  and the time between shots** within one clock run (e.g. `0x00210F5C` = 01:58:56).
* An earlier version of these notes read them as Unix time (1998-05-03); that was wrong.

## PSNnnnnn.PMP — photo

* 256-byte header, then a standard baseline JFIF JPEG starting at offset `0x100`
  (`FF D8 FF`), ending with `FF D9`. 640 × 480 regardless of quality.
* (The DSC-F1 PMP format puts the JPEG at `0x7C`; the MD1 uses `0x100`.)

The header is a list of **TLV records** — `[tag8][len8][len bytes]` — not fixed offsets
(confirmed against Sony's code; on MD1 files they fall at 0x00, 0x14, 0x30, 0x4C, 0x64).

| Tag | MD1 offset | Contents |
|---|---|---|
| `0x10` | 0x00 | File header: type byte at +4 (`0x10` = PMP), JPEG length (BE32) at +0x0C |
| `0x20` | 0x14 | Image: width at +2, height at +4 (BE16, 640 × 480); **quality at +9: `0x17` STD, `0x33` FINE** |
| `0x21` | 0x30 | Recorded / edited dates (`0xFF` = clock unset) |
| `0x24` | 0x4C | Exposure: **shutter = APEX Tv × 100 (BE16) at +2** (e.g. 491 → 1/30 s, 664 → 1/100, 997 → 1/1000); three more ×100 values at +6, +8, +0x0C (aperture/EV?); **flash fired at +0x12** (non-zero = on) |
| `0x11` / `0x12` | 0x64 | Text (0x12 = caption written by Sony's album software) |

`md1tool/photo_info.py` extracts these into a CSV (see `downloads/photo-metadata.csv`).

File sizes: Standard ≈ 60–64 KB, Fine ≈ 106–128 KB (the camera budgets 64 KB / 128 KB).

## NRAnnnnn.PMA — sound recorded with a photo

* 256-byte header, then **mono ATRAC1** sound units back to back.
* ATRAC1 sound unit: 212 bytes = 512 samples at 44.1 kHz (11.6 ms). Byte 0 and byte 211 are
  equal, byte 1 and byte 210 are equal (block-size mode, mirrored) — `AC A0 … A0 AC` in practice.
* Example: `NRA00018.PMA` = 106 752 bytes = 256 + 502 × 212 + 72 trailing bytes → 5.83 s.
  The camera's "record sound with shot" mode (音声同時記録) records ~6 s.
* Header bytes seen: `10 12 01 00 20 00 02 00 00 00 01 00 FF FF FF FF … 30 36 00 04 …`.
* Decoding: wrap the units in a MiniDisc `.aea` container (2048-byte header: `00 08 00 00`, title
  at 4, channel count at byte 264 = 1) and decode with ffmpeg's `atrac1` decoder.
  `md1tool/md1.py` does this with PyAV (`pma_to_wav`).
* Narration added later with the ナレーション button is presumably stored the same way (same
  prefix "NRA" = narration); not yet verified.

## PIC_INF.PMF — album index

* Starts `10 12 01 00`; `0x0C`–`0x0F` = file length (big-endian; 1548 → 1596 bytes when three
  photos were added).
* `0x104`–`0x105`, `0x106`–`0x107`, `0x10E`–`0x10F`: picture counts (all changed 16 → 19 when
  three photos were added).
* From `0x50C`: one 16-byte record per picture (confirmed by diffing before/after shooting):

| Byte | Example | Meaning |
|---|---|---|
| 0–1 | `00 01` | Album number (PIC00001) |
| 2–3 | `00 12` | Picture number → `PSN00018.PMP` |
| 4 | `01` | Always 01 so far |
| 5 | `00` | Flags. **Bits 2–3 = rotation, in quarter turns counter-clockwise** (confirmed 2026-10-19: `04` makes the camera show the photo turned 90° counter-clockwise) |
| 6 | `00` | Flags (unknown) |
| 7 | `00` / **`01`** | **Has sound** — `01` exactly when `NRAnnnnn.PMA` exists (photo 18 on disc 2) |
| 8–13 | `FF FF FF FF FF FF` | Unused / title link? |
| 14 | `00` | **Bit 0 = protect** (confirmed 2026-10-19: the camera shows no mark, but its delete menu refuses the photo with a red message) |
| 15 | `00` | |

* So the index *does* flag sound, but never names the file; the file is `NRA` + the same
  5-digit number as the photo.
* The photo's own PMP header carries **no** sound flag (diffing PSN00017 vs PSN00018 shows only
  the JPEG length and the per-shot value at `0x4E` changing).

## OV_INF.PMF — album list

336 bytes. Contains the album folder names (`PIC00000`) and per-album counts at `0x100`
(`00 14` = 20 pictures). Diary/free album mode and titles probably live here.

## PMX — thumbnail containers

`OV_IDX.PMX` (album covers) and `PIDXnnn.PMX` (photo thumbnails), confirmed layout:

* A sequence of **4096-byte blocks, one per picture**, in the same order as the PIC_INF records
  (`PIDX000.PMX` = 19 × 4096 bytes for 19 photos).
* Each block: 256-byte header (`10 12 01 00 12 00 01 00 00 00 01 00` + **JPEG length BE32 at
  0x0C**, rest zero), then the thumbnail JPEG at 0x100, then zero padding to 4096.
* Thumbnail: baseline JPEG, **80 × 64 = 80 × 60 picture + 4 flat rows at the bottom**,
  ≈3 KB.
* The camera also displays thumbnails written by an ordinary encoder (PIL: JFIF header,
  component IDs 1/2/3, 4:2:0) — confirmed by the hand-added photo.

## Album counts that must stay consistent (confirmed by hand-adding a photo)

| File | Offset | Field |
|---|---|---|
| `PIC_INF.PMF` | 0x0C–0x0F | body length = file length − 0x100 |
| `PIC_INF.PMF` | 0x104, 0x106, 0x10E (BE16 each) | picture count (three copies) |
| `PIC_INF.PMF` | 0x50C + 16·i | picture record i (see above) |
| `OV_INF.PMF` | 0x100 and 0x124 (BE16 each) | picture count of the album (two copies); album number at 0x120 (0001 for PIC00001, 0000 for PIC00000) |
| `OV_INF.PMF` | 0x102 (BE16) | **album mode** (inferred): `0001` on the camera-formatted disc = Diary (the camera's default after formatting; standard quality only), `0002` on disc 2, which holds FINE photos = Free. The camera's menu switches Diary → Free one way only; we don't write this field |

## Adding a photo by hand (confirmed working)

The MD1 rejects Sony's `02 14` add-picture command, but writing the files directly works
(`md1tool/add_photo.py`):

1. Write `PSNnnnnn.PMP` (next free number) — a complete camera-format PMP (256-byte TLV header +
   JPEG). Tested with a PMP originally made by the camera (copied from another disc).
2. Rewrite `PIDX000.PMX` with one more 4096-byte thumbnail block appended.
3. Rewrite `PIC_INF.PMF` with one more 16-byte record (album no., PSN no., `01`, flags 0, sound 0,
   `FF`×6, `00 00`) and the three counts and body length updated.
4. Rewrite `OV_INF.PMF` with both album counts incremented.
5. Power-cycle the camera. The photo appears at the end of the album, with its thumbnail in the
   index view.

Not yet tried: a JPEG that the camera did not take (needs a synthesized PMP header: TLV tags
0x10/0x20/0x21/0x24/0x11, quality byte, JPEG length), attaching sound (`NRAnnnnn.PMA` + record
byte 7 = 1), or adding a new album.

## PDF_MD — Sony PDF-5 document-filer structure

The PDF-5 was a Sony MD DATA "personal document filer". Its directory exists on this camera
disc, apparently created when the disc was formatted.

* `TOTAL.INF`: index with the string `PDF-5`, a `topDir` entry and 16 entries `BOX 1` … `BOX 16`.
* `TITLES/BOXSnnnn.TTL`: 32-byte header (`82 10 01 00 …`, data length `0x1F400` = 128 000) then
  128 000 bytes of title bitmap — **all zero** (unused) on this disc.
* `STAMP/STAMP00.DAT`: 32-byte header (`90 10 01 00 … 48 00` = 18 432 bytes data, `3C 18 18` =
  60 glyphs of 24 × 24), then 1-bit glyphs, 72 bytes each. Contents: numbers 1–12, hiragana index
  tabs (あかさたなはまやらわ), # 月 ○ △ × ☆ ¥ $ * ! ?, pictograms (eyes, lips, pointing hand,
  knife & fork, runner, palette, note, bag, house, car, cup, heart, people) and circled office
  stamps 注 特 秘 重 必 暑 賀 返 参 済 未 急, plus a few hatch patterns. The camera never shows them.

## Volume

`02 01` reports 17 616 allocation units total, 15 838 free (disc 2, 19 photos + 1 sound file),
i.e. about 90 % free.
