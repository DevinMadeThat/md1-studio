# DSC-MD1 serial protocol

Reference for talking to a Sony DSC-MD1 (MD Cyber-shot, 1997) over its Digital I/O port.
Everything marked **confirmed** was observed on a real camera (firmware reply `1.14`) with
`md1tool/md1.py`. Items marked **inferred** come from disassembling Sony's 1997 Windows software
(see [reverse-engineering-notes.md](reverse-engineering-notes.md)) or from the open-source DSC-F1
tools (libgphoto2 `sonydscf1`, chotplay 0.06), and have not been exercised on the camera.

The MD1 speaks the same protocol family as the DSC-F1 (1996). Sony's PC software calls itself
"Sony DSC-F1 TWAIN 1.5".

## Physical layer

| Item | Value |
|---|---|
| Connector | Camera "DIGITAL I/O" jack, 3.5 mm stereo (TRS), RS-232C levels |
| Wiring that worked | Generic "DB9 female ↔ 3.5 mm TRS" RS-232 cable (DB9 pins 2/3/5 → T/R/S) + FTDI USB-RS232 adapter. **No null modem needed.** |
| Serial format | 8 data bits, no parity, 1 stop bit, no flow control |
| Initial speed | **9600 baud** after a battery-out restart (confirmed). The camera ignores other speeds until told to switch. |
| Camera settings | Function switch on 再生/オーディオ (playback). Menu → 準備 → **IrDA OFF** (with IrDA ON the jack is dead). |
| Speed persistence | Once switched (`01 03`), the camera keeps the new speed across host reconnects **and power-switch restarts**; a battery pull returns it to 9600. `01 02` (disconnect) also returned it to 9600 once, yet after the next power-switch restart it was back at 115200 — so a host should simply try 9600 and 115200. |

## Framing (confirmed)

```
C0  <addr>  <payload ...>  <checksum>  C1
```

* `C0` start, `C1` end.
* Escape: any `C0`, `C1` or `7D` inside addr/payload/checksum is sent as `7D, byte XOR 0x20`
  (the camera escapes its replies; it also accepts escaped host frames).
* `checksum = (0x100 - (addr + sum(payload))) & 0xFF`, i.e. addr + payload + checksum ≡ 0 (mod 256).

### Sequence addresses

* Host frames cycle through `00 22 44 66 88 AA CC EE` (index 0–7), one step per frame.
* Camera replies carry `0E 20 42 64 86 A8 CA EC`; the reply to host index *i* uses camera index *i+1*.
* **Out of sequence → NAK**: the camera answers with an empty frame of address `83`
  (`C0 83 7D 5D C1`, the checksum `7D` being escaped). The rejected frame is **not executed**,
  so it is always safe to resend it with the next address.
* The camera **remembers its sequence position across host sessions** and resets it after a
  speed change. A robust host simply retries on `83` with successive addresses (≤ 8 tries).
* Abort / link reset frame: `C0 85 7B C1` (address 85, empty payload).

## Reply format (confirmed)

Replies echo the two command bytes, then a status byte, then data:

```
<cmd0> <cmd1> <status> <data ...>
```

| Status | Meaning (observed) |
|---|---|
| `00` | OK |
| `03` | Command not supported in this mode (seen for 02 17, 02 18) |
| `FC` | Find-first on an empty folder |
| `FE` | Find-next: end of folder |
| `FF` | Not found / bad path (file info, find-first) |

## Commands

### Session

| Cmd | Params | Reply data | Notes |
|---|---|---|---|
| `01 01` hello | 30-char host ID | 30-char camera ID | **Confirmed.** Host `SONY     MKY-1001         1.00` (DSC-F1 software) → camera `SONY     MKY-2000         1.14`. Host `SONY     DSC-2050         1.00` (MD-native software) → camera `SONY     DSC-RS 05.00     1.14`. Both IDs give the same command set as far as tested. |
| `01 02` disconnect | — | status | **Confirmed**: Sony's session end. Also returns the link to **9600 baud**. |
| `01 03` set speed | 1 byte code | code accepted | **Confirmed** for code 4. Codes: 0 = 9600, 1 = 19200, 2 = 38400, 3 = 57600, 4 = 115200, 5 = 230400, 6 = 460800, 7 = 921600 (5–7 are presumably IrDA-only). Switch the host port to the new speed ~0.2 s after the reply; the next frame will be NAKed once (sequence reset). |
| `01 04` get speed | — | 1 byte code | **Confirmed** (returns 0 at power-up). |
| `03 02` status | — | 30 bytes | **Confirmed.** See below. |

#### Status reply (`03 02`), data bytes after `03 02 00`

| Offset | Example | Meaning |
|---|---|---|
| 0 | `01` | Function-switch mode: 1 = playback, 2 = record (auto), 3 = record (manual) (from gphoto2) |
| 1–2 | `00 13` | Picture count in the current album (19) |
| 3–4 | `00 13` | Second picture count (same so far) |
| 7–11 | `50 01 01 02 13` | Camera clock, BCD: YY MM DD hh mm (clock unset → "50-01-01") |
| rest | | Unknown |

### Filesystem (all confirmed unless noted)

The camera exposes the MD Data disc as a small hierarchical filesystem with 8.3 names and
`/`-separated absolute paths (e.g. `/PIC_MD/PIC00001/PSN00000.PMP`).

| Cmd | Params | Reply data | Notes |
|---|---|---|---|
| `02 01` volume info | — | 78 bytes | 32-byte blank volume label, two timestamps, then allocation counts: total `0x44D0` (17616) units, free `0x3DDE` (15838). |
| `02 05` find first | folder path `\0` | dir entry | **Takes a folder path, no wildcards** (`/`, `/PIC_MD`, `/PIC_MD/PIC00001`). `*.*` patterns return FF. The first entry returned is the folder itself (name byte `01`). |
| `02 06` find next | — | dir entry | Repeat until status `FE`. Single cursor: finish a folder before listing another. |
| `02 0A` open | mode16 `00 00`, path `\0` | handle16 | Mode `00 00` = read. Returns a 16-bit handle (e.g. `00 09`). |
| `02 0B` close | handle16 | — | |
| `02 0C` read | handle16, length32 | `00 00` len16 data | **Max 2048 bytes per request** (4096 → no reply). Empty data = EOF. Handle 0 is also accepted. |
| `02 0E` seek | handle16, offset32, whence16 | | From chotplay/Sony code; untested. |
| `02 0F` file info | path `\0` | dir entry | Works for files and folders. |

#### Directory entry (find first / find next / file info), after the 3-byte echo + status

| Offset | Size | Meaning |
|---|---|---|
| 0 | 2 | Attributes: `0080` normal file, `4080` thumbnail index file, `0000` PDF_MD file, `0001` folder, `0101`/`0201` "this folder" entry |
| 2 | 1 | Always `01` so far |
| 3 | 11 | Name, 8 + 3, space-padded, no dot. `01` + spaces = the folder itself |
| 14 | 4 | Timestamp, DOS packed date/time (big-endian), created? |
| 18 | 4 | DOS date/time (modified?) |
| 22 | 4 | DOS date/time |
| 26 | 4 | Entry number (unique per file/folder on the disc; folder's own entry repeats its number) |
| 30 | 4 | Size in bytes (folders report 2048) |

### Write path (confirmed on hardware 2026-10-18; semantics from Sony's code)

| Cmd | Params | Reply | Hardware result |
|---|---|---|---|
| `02 02` CHDIR | path `\0` | status | Not exercised |
| `02 03` MKDIR | path `\0` | status | **Works** (created `/PIC_MD/PIC00001`, `/PDF_MD`, …) |
| `02 04` RMDIR | path `\0` | status | **Works** on an emptied folder |
| `02 08` DELETE FILE | path `\0` | status | **Works** |
| `02 09` RENAME | `old\0new\0` (basenames after CHDIR) | status | Not exercised |
| `02 0A` OPEN mode `02 00` | create | handle16 | **Works**. Sony always deletes an existing file first instead of relying on truncation. |
| `02 0A` OPEN mode `00 02` | read/write existing | handle16 | Not exercised |
| `02 0D` WRITE | handle16, len32, data | data[0..3] = bytes written | **Works.** Sony writes 1024-byte chunks (≈0.85 KB/s on the MD1). **2048-byte chunks work and are ~9× faster (≈7.5 KB/s)** — one MiniDisc data sector per write instead of a read-modify-write of half a sector. |
| `02 14` ADD PICTURE | flag8 (0 first / 1 middle / 2 last), len32, ≤1024 bytes of bare JPEG | status | **Unsupported on the MD1** (status `03` on the first frame, nothing written). DSC-F1 only. Use the manual method in disc-format.md ("Adding a photo by hand"). |
| `02 15` DELETE PICTURE | u16 | status | Not exercised (destructive) |
| `02 10` FORMAT | — | (silent ~50 s) | **Formats the disc.** See hazards. |

There is no commit/flush command; power-cycle the camera after writing index files so it re-reads them.
Session end used by Sony's software: `01 02`.

### Other commands seen in Sony's software

| Cmd | Params | Status | Notes |
|---|---|---|---|
| `02 17` | byte, word16 | returns `03` | Infrared-link image API; no callers in ALBUM. Unsupported on the MD1 serial link. |
| `02 18` | 0/1, word16 | returns `03` | Infrared-link "object n" size / streamed download. Unsupported on the serial link. |

## Command sweep results (confirmed, 2026-10-18)

Every code `01 00`–`01 3F`, `03 00`–`03 3F` and `02 00`–`02 10` was sent **bare** (no
parameters) except the denylisted destructive ones. Status `03` = unsupported.

| Cmd | Reply | Notes |
|---|---|---|
| `01 00`, `01 05`–`01 3F` | `03` | Unsupported |
| `01 01` (no ID) | `00` + camera ID | Hello works even without a host ID |
| `01 04` | `00 FF` | Speed code `FF` while running at 115200 (it was `00` at 9600) |
| `03 00`, `03 04`–`03 3F` | `03` | Unsupported |
| **`03 01`** | `00`, no data | **Supported, purpose unknown.** Re-tested with the owner watching: no screen change, no beep, no drive activity. Not used by any Sony software. |
| **`03 03`** | `00`, no data | **Supported, purpose unknown.** Same: no visible or audible effect. |
| `02 05`, `02 06`, `02 0B`, `02 0C`, `02 0E`, `02 0F` | `FF` | Supported; fail for lack of parameters |
| **`02 07`** | `FE` | **Supported, not used by Sony's software**; FE like find-next end — maybe "close find". No visible effect. |
| `02 0A` (no path) | `00`, handle `00 00` | An empty path opens *something* (the volume?) |
| **`02 10`** | **no reply for ~50 s, then camera idle** | **FORMAT. Quick-formats the disc. Destroyed disc 2's contents.** |

The sweep was stopped at `02 10`; `02 11`–`02 FF` and groups `04`–`07` remain untested.

## Firmware hazards (confirmed)

* **`02 10` formats the disc** — no arguments, no confirmation. During the ~50 s format the
  camera does not answer; afterwards every path returns `FF` until the camera is power-cycled,
  then the disc shows a fresh `PICTURE MD DATA` volume with an empty `/PIC_MD`.

* **Long paths hang the camera.** A `02 05` find-first with a 133-byte payload still worked;
  the next one (138 bytes) locked the camera so hard that the power switch stopped working and the
  battery had to be removed. Keep payloads short (md1.py refuses anything over 96 bytes).
* The camera shows "PC" on its screen while a session is open.
* The camera auto-powers off after a few minutes of inactivity (power-save setting), which looks
  like a dead link; the host should re-handshake.

## Throughput (confirmed)

| Link | Read size | Effective rate |
|---|---|---|
| 9600 baud | 1024 | ~850 B/s (≈ 75 s per 64 KB photo) |
| 115200 baud | 1024 | ~3.8 KB/s |
| 115200 baud | 2048 | measured during the disc-2 mirror (see lab notebook) |

The MiniDisc drive's seek/spin-up time dominates small reads; the serial line is not the bottleneck at 115200.
