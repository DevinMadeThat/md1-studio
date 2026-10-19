# Sony DSC-F1 / DSC-MD1 serial protocol and file formats — reverse-engineering notes

Sources analysed (all static, no hardware):

* **ALBUM** = `ALBUM.EX#` — Sony Digital Still Camera Album Utility **1.50** (Win16 NE, English). Main source.
* **TWAIN DS** = `SONYMK16.DS` — Sony DSC-F1 TWAIN 1.5 data source (Win16 NE).
* **MAC** = `DSC-F1 Album` (PowerPC PEF; C++ with traceback-table symbol names such as
  `CMKY2000::FileOpen`, `CCameraAlbum::GetNextIndexNo`) from the Mac HFS image.
* chotplay 0.06 / gphoto2 `sonydscf1` for cross-checking.

Notation:

* `segN:dddd` = byte offset (decimal) inside NE segment N of ALBUM, as printed by
  `scratchpad/re/rdis.py` (that tool resolves NE relocations, so far calls show their real target).
* `mac:0xNNNNN` = file offset in the MAC PEF data fork.
* **reply data** = the bytes after the 3-byte `cmd1 cmd2 status` echo (ALBUM keeps the status at `DS:24B9` and a
  far pointer to the reply data at `DS:24BA`). All multi-byte protocol integers are **big-endian**.
* **CONFIRMED** = read directly from code. **INFERRED** = deduced from samples, naming or context, not proven.

---

## 0. Summary of new findings

1. **Write path (CONFIRMED):** `02 02` CHDIR, `02 03` MKDIR, `02 04` RMDIR, `02 08` DELETE FILE, `02 09` RENAME,
   `02 0A` OPEN (modes 0x0000 read, 0x0002 read/write existing, 0x0200 create), `02 0D` WRITE (≤1024 bytes),
   `02 0E` SEEK. Each one was identified from its local-disk twin in ALBUM's file layer, which calls the matching
   DOS function.
2. **"Copy To Camera" never writes PMP or index files.** It sends a bare JPEG stream with `02 14` (ADD PICTURE), and the
   camera builds the PSN, PIDX and PIC_INF entries itself. Separately, ALBUM edits index files on the camera
   by rewriting the whole file (delete, create, write, close). MAC patches them in place (open 0x0002, read, seek, write).
3. There is **no commit or flush command**. ALBUM, the TWAIN DS and MAC send nothing besides
   `01 01–01 04, 02 01–02 06, 02 08–02 0F, 02 14, 02 15, 02 17, 02 18, 03 02` and the control frames 0x85 and 0x81.
   `02 07`, `02 10–02 13`, `02 16`, `03 01` and `03 03` are never sent. `02 10` (bare) = FORMAT on the MD1, according to
   the coordinator's hardware test; none of the Sony software uses it.
4. **How MD support works (MAC, CONFIRMED):** after the hello, `CMKY2000::FindPort` runs `02 0F "/PIC_CAM"`. If
   that fails it runs `02 0F "/PIC_MD"`, and the folder that answers becomes the camera root. The reply model string
   is classified as `MKY-1000`→1000, `MKY-2000`→2000, `MKY-3000`→3000, `DSC-RS`→2050. The MD1 answers `MKY-2000` or `DSC-RS`.
   ALBUM 1.50 contains the string `/PIC_MD/PIC%05d` but never references it. In ALBUM the camera is drive `0:` and
   the user browses to the folder.
5. **The DSC-2050 host ID is unreachable from the English ALBUM UI.** The Settings dialog procedure handles
   radio buttons 208/209 (camera type) and 200–205 (6 baud rates), but the `ALBUMENV` dialog template lacks those controls.
   With the default env.dat the app always says `MKY-1001` and opens the port directly at 9600/19200/38400 with no `01 03`.
6. **Status data[5] = power state (CONFIRMED by strings):** 0–2 = battery nearly empty (refused), 3–4 = on battery
   (warning), 5 = AC adapter.
7. **File timestamps** in directory, stat and volume replies are packed **DOS-style big-endian bitfields**, not Unix
   time: `YYYYYYYM MMMDDDDD HHHHHMMM MMMSSSSS` (seconds/2).
8. **PMP header is a TLV list.** Tag 0x20 = image dimensions and quality, 0x21 = recorded and edited date, 0x24 = exposure
   (APEX Tv ×100) and flash, 0x11/0x12 = text (0x12 = ALBUM caption). The layout matches chotplay's fixed F1 offsets.
9. **Volume info** (`02 01`) gives FS geometry. On the coordinator's disc, the camera's own quick format changed the
   cluster size from 4 to 32 sectors and set the label `PICTURE MD DATA`.
10. **ALBUM never tests specific status codes.** Any non-zero status is "fail", so FE/FF/FC/03 meanings come only from
    hardware observation.

---

## 1. Write path (priority section)

### 1.1 Command table (CONFIRMED)

| Cmd | ALBUM wrapper | ALBUM file-layer fn → local twin | Meaning | Request params | Reply |
|---|---|---|---|---|---|
| 02 02 | seg4:48360 | seg2:45444 → CRT `chdir` (DOS 3Bh, seg1:14968) | **CHDIR** | ASCIIZ path; strlen ≤ 0x80; sends strlen+1 bytes | status only (wrapper → 0 or −2) |
| 02 03 | seg4:48448 | seg2:45172 → CRT `mkdir` (DOS 39h, seg1:14954) | **MKDIR** | ASCIIZ path ≤ 0x80 | status only (0 / −1) |
| 02 04 | seg4:48540 | seg2:44900 → CRT `rmdir` (DOS 3Ah, seg1:15006) | **RMDIR** | ASCIIZ path ≤ 0x80 | status only |
| 02 08 | seg4:50050 | seg2:44628 → CRT `unlink` (DOS 41h, seg1:15556) | **DELETE FILE** | ASCIIZ path ≤ 0x80 | status only |
| 02 09 | seg4:50142 | seg2:~42580 → CRT `rename` (DOS 56h, seg1:15512) | **RENAME** | `old\0new\0`, strlen(old)+strlen(new) ≤ 0x7F | status only |
| 02 0A | seg4:50288 | seg2:41236 / 41512 / 41788 → `_lopen` / `_lcreat` | **OPEN** | `mode16` + ASCIIZ path | data[0..1] = handle16 |
| 02 0B | seg4:50388 | seg2:42102 → `_lclose` | CLOSE | handle16 | status only |
| 02 0C | seg4:50448 | seg2:42204 → `_hread` | READ | handle16, len32 | data[0..3] = count32, then data; error if count > requested |
| 02 0D | seg4:50760 | seg2:42326 → `_hwrite` | **WRITE** | handle16, len32, `len` bytes; wrapper rejects len > 0x400 | data[0..3] = bytes written (32-bit); error if > requested |
| 02 0E | seg4:51058 | seg2:42448 → `_llseek` | **SEEK** | handle16, offset32, origin16 (0 SET, 1 CUR, 2 END, passed straight through) | data[0..3] = new position |
| 02 0F | seg4:51292 | seg2:43132 / 43688 → DOS findfirst | STAT | ASCIIZ path | 0x22-byte entry (§3.3) |
| 02 14 | seg4:52242 | seg2:49246 | **ADD PICTURE** (JPEG stream) | flag8, len32, data (≤ 0x400) | status only |
| 02 15 | seg4:52386 | — | **DELETE PICTURE** by number | u16 | status only |

Path handling (seg2:45000–45160 and every other camera branch): the DOS path is copied, each `\` becomes `/`, and
everything up to and including the first `:` is stripped. Example: `0:\PIC_MD\PIC00001\PSN00000.PMP` becomes
`/PIC_MD/PIC00001/PSN00000.PMP`. For RENAME the app first sends `02 02 <parent dir>` (seg2:42829), then
`02 09` with **basenames only** (seg2:43043). So a current-directory concept exists. Whether `02 09` also accepts
full paths is untested.

### 1.2 `02 0A` open modes actually used

| Caller | Mode sent | Local twin | Meaning |
|---|---|---|---|
| seg2:41453 | `00 00` | `_lopen(path, 0x20)` = OF_READ \| OF_SHARE_DENY_WRITE | read |
| seg2:41729 | `00 02` | `_lopen(path, 1)` = OF_WRITE | write to an existing file, no create |
| seg2:42043 and seg2:47179 | `02 00` | `_lcreat(path, 0)` | create |
| mac:0x23e50 (`CCameraFile` ctor; the only `FileOpen` call in MAC) | `00 02` | — | MAC reads **and** writes through this one handle, so 0x0002 = read/write existing |

On the wire: `02 0A <mode_hi> <mode_lo> <path…> 00` (seg4:50311 stores `ch` then `cl`; MAC encodes a 16-bit big-endian value).

ALBUM's create sequence (seg2:41788–42050 and seg2:47144–47179) never relies on 0x0200 to truncate:
`02 0F path` → if status == 0 then `02 08 path` → `02 0A 02 00 path`.
INFERRED: append = open 0x0002, then `02 0E h 00000000 0002`.

### 1.3 `02 0D` write as the apps drive it

ALBUM (seg2:48808, camera twin of `_hwrite`):

1. `03 02` status first (seg2:48839). This gates on the connection and on battery state.
2. Repeat `len/1024` times: copy 1024 bytes to `DS:1A0E`, send
   `02 0D <h16> 00 00 04 00 <1024 bytes>` (seg2:49003), and check that the returned count is 0x400.
3. Send the remainder in one final `02 0D` (seg2:49158).

MAC `CMKY2000::FileWrite1K` (mac:0x20be8): `02 0D h16 len32 data`, response timeout 4000 ms. It expects a
reply frame of 11 bytes (3 echo/status + 4 count + 4 framing). `FileRead1K` uses the same 1 KB unit.
**The maximum chunk used by every Sony implementation is 1024 bytes.** The coordinator found reads of up to 2048
bytes work on the MD1. Writes above 1024 bytes are untested.

### 1.4 `02 14` ADD PICTURE vs `02 0D`

* Params: `flag8 len32 data[len]`, with len ≤ 0x400 per frame. There is no filename or handle (seg4:52248–52364).
* Framing of a transfer (seg2:49246): flag **0** = first frame, **1** = middle frames, **2** = last frame. A file that fits in one frame is sent
  with flag 2. Reply = status only. On error the app shows string 15012 "Camera's memory is full or communication error!".
  MAC `AddPicture` (mac:0x212b4) uses a response timeout of **8000 ms**, so the camera does real work per frame.
* Payload (ALBUM seg3:6970–7410): the source file is read into RAM (≤ 0x1FBD0 bytes). ALBUM scans the first 10000
  bytes for `FF D8` and sends from SOI onward, so a **bare JFIF stream** goes out. The camera then creates the
  PSN/PIDX/PIC_INF entries. INFERRED caveat: ALBUM passes the whole file length while starting at the SOI offset, so up
  to 0x100 bytes of trailing junk can follow EOI when the source is a PMP.
* Before uploading, ALBUM checks free space with `02 01` and requires `file_size*5/4 ≤ free` (seg3:7125–7163).
  As §3.2 shows, that formula yields *sectors*, not bytes, on the MD1.
* MAC (`CImage::Upload`, mac:0x1e8a4): `AddPicture` in 1 KB chunks, then `CCameraAlbum::GetLastImage`, then it copies
  rotation, camera info and name into the new picture with `CCameraImage::WriteInformations`. That function rewrites the
  index entry and the PMP header in place with open 0x0002, read, seek, write.
* Conclusion: use `02 0D` for a byte-exact restore. Use `02 14` only to let the camera import a new JPEG through
  its own indexing.

### 1.5 `02 15` DELETE PICTURE (destructive)

`02 15 <u16>`; reply = status only. ALBUM callers: seg3:54354 (delete the selection) and seg3:61317 ("delete all":
it walks from the last entry to the first and skips entries whose PIC_INF protect bit is set; string 15019 "Protected
images remained."). Afterwards ALBUM deletes its local cache copies and re-reads `03 02`. Failure → "DELETE ERROR".
ALBUM passes the list position. MAC passes `CCameraImage+0x186` (`GetIndexNo`). chotplay passes the PSN number.
The argument is therefore a 16-bit image number; whether it is the position or the PSN number is unresolved.

### 1.6 "Copy To Camera" / "copy album to camera": the full sequence (CONFIRMED)

* Album copy (seg3:56568, prompt 15506 "Is it OK to copy the selected album to the camera?"): for each selected
  album, read that album's PIC_INF (seg3:16168, ALBUM's PIC_INF reader). Then, for each PSN number, call
  seg3:5542 under the progress text "Copying image %d out of %d…" (seg3:57050).
* seg3:5542 is a dispatcher: if `dest_path[0] == '0'` (the camera drive) it calls seg3:6970 (**02 14 upload**);
  otherwise it calls seg3:7456 (local copy that writes files and PIC_INF). Single-image copy (seg3:42983 and 43296) and
  drag-and-drop (seg3:53167 and 53590) use the same dispatcher.
* seg3:6970 order: read the target album's PIC_INF → `02 01` free-space check → read the local file → `03 02` →
  `02 14` frames → update the local `cache\cache.env` (seg3:47034).
* **No MKDIR, no PMP write and no index write is sent to the camera for a copy.**

### 1.7 Index-file edits on a camera album

ALBUM helper seg2:46922 ("write buffer to path") has 60+ callers, among them the PIC_INF writers at seg3:17038
(slot table), 17708 (rotation), 18586 (delete entry) and 19712 (add entry), plus the OV_INF and OV_IDX writers. For
a camera path it sends:

1. `03 02` (via seg2:47758)
2. `02 0F path` → if it exists, `02 08 path` (seg2:47144, seg2:47162)
3. `02 0A 02 00 path` → handle (seg2:47179)
4. `02 0D` in 1 KB chunks (seg2:47303 → 48808)
5. `02 0B` (seg2:47403)

It then mirrors the data into the local cache `%scache\<name>`. So the camera accepts host-written
PIC_INF.PMF and OV_INF.PMF. Rotate, protect and caption edits of camera images are stored this way.
MKDIR, RMDIR and CHDIR on the camera go through seg2:45172, 44900 and 45444. Their callers are album management
(seg3:0, 704, 3948, 4544; seg3:4544 copies an album folder: MKDIR, copy the tree via seg2:35706, rebuild OV_IDX.PMX
at seg3:5233–5513). Return to root = up to 1000 × `02 02 ".."` (string seg2:0xc934, loop at seg2:48260).

### 1.8 Commit and re-index

No such command exists in ALBUM, the TWAIN DS or MAC. After writes the app only re-reads `03 02`. It compares the
32-bit value at status data[0x12..0x15] with the copy in `cache\cache.env` to decide whether to re-download the camera
index (seg3:47239, 47559, 50923, 54705). Holding Ctrl forces a refresh. Session end = `01 02` (§2.1). INFERRED:
the camera re-reads its index files as needed; power-cycling after a restore is the safe option.

### 1.9 Restore recipe implied by the code (INFERRED, untested)

1. `02 03 /PIC_MD/PICnnnnn` for each album directory (camera format already creates `/PIC_MD`). Create parents first.
2. For every file: `02 0F` → if it exists, `02 08` → `02 0A 02 00 <path>` → `02 0D` in ≤1024-byte chunks, checking the returned
   count → `02 0B`.
3. Write payload files first (`PSN*.PMP`, `NRA*.PMA`, `PIDX*.PMX`), then the indexes: `PIC_INF.PMF` per album,
   then `/PIC_MD/OV_IDX.PMX` and `/PIC_MD/OV_INF.PMF`. The app always writes payload before index.
4. `01 02`, then power-cycle the camera.
5. Expect a different cluster size than the original disc (§3.2), so files will not land at their original positions.
   The 4-byte "entry number" in directory entries will also differ.

---

## 2. Link layer, session and control commands

### 2.1 Session commands (CONFIRMED)

| Cmd | Where | Notes |
|---|---|---|
| `01 01` hello | seg4:47116 | Sends the host ID (30 chars). The reply data is an ASCII ID that ALBUM copies (≤255 bytes) from `DS:24D0`. If reply chars [13..14] == `RS` → link type 1 (serial/"RS"); if == `IR` → link type 2 (infrared, retries raised to 6) (seg4:47267–47322). |
| `01 02` | seg4:47342 | Sent with retry count forced to 1 and no params, only from the disconnect path: seg2:48198 (connection refcount reaches 0) and seg2:48216/48241, followed by COM close. MAC `Disconnect` (mac:0x20544) sends `01 02` and then waits 20 ticks. chotplay calls it "reset" and uses it for error recovery. |
| `01 03 <code>` set speed | seg4:52568 | Codes 0..7 = 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600. Non-zero status → error 100; unsupported baud → 102. After success: close the port, reopen at the new rate, reset sequence counters (seg4:53120), verify with `01 04`. Used **only when link type == RS** (seg2:50562). |
| `01 04` get speed | seg4:52914 | Reply data[0] = code 0..7 (status non-zero → 100). |
| `03 02` status | seg4:52040 | See §3.1. Sent before almost every operation (seg2:47758 "check connected"). |
| `02 01` volume info | seg4:47384 | See §3.2. Twin = DOS 36h get-disk-free (seg2:45716). |
| `02 05` / `02 06` find first / next | seg4:48632 / 49358 | Return the raw status byte. Callers loop until any non-zero status (seg2:44398–44583); FE is never tested specifically. |
| `02 17 <u8><u16>` | seg4:52448 | **No callers in ALBUM.** The wrapper exists (also in the TWAIN DS). Reply: data[0] = status/flag; 1024 bytes copied from data+5. A block read of a numbered object. MD1 answers status 03. |
| `02 18 00 <u16>` | seg4:53130 | Object size: reply data[5..8] = size32. |
| `02 18 01 <u16>` | seg4:53278 | Streamed object download (below). |

`02 18` is used only when link type == **IR** (seg2:62454, `cmp [0x3C6],2`). ALBUM parses the image number out of
the `…\0nnn` folder or file name (seg2:62443–62620), looks the number up in PIC_INF, then sends `02 18 00 n` for the
size and `02 18 01 n` for the data. It is the infrared camera's image-by-number API, which explains why the MD1
(serial, RS) answers 03.

`02 18 01` stream (seg4:53278–53693). The host sends one request frame, then receives frames without sending
anything else. Each reply has data[0] = flag (0 = first, 1 = more, 2 = end), data[1..4] = chunk length,
data[5..8] = offset (INFERRED), and data[9..] = payload. The payload is copied to buffer+offset with TOOLHELP
`MemoryWrite`. The receive sequence number increments per frame. At the end the host sends the **0x85 control frame**
(`C0 85 7B C1`, seg4:53694).

### 2.2 Framing details visible in ALBUM

* Address byte (seg4:46860–46899): `((recv_seq & 7) << 5) | ((send_seq & 7) << 1)`. With both counters in step this
  gives `00, 22, 44, …, EE`.
* Control frames are built at seg4:53694 and seg4:54122: `C0 85 7B C1` (abort / end-of-stream; MAC also sends it as
  the first thing in `Connect`, mac:0x1ff5c) and `C0 81 7F C1` (host "resend/NAK", sent on retry when
  `[bp-4]` is set, seg4:46947).
* The send routine (seg4:46854) retries `DS:3C0` times (2 normally, 1 for `01 02`, 6 on IR). In RS mode it aborts with
  −10 if Esc is held (`GetAsyncKeyState(VK_ESCAPE)`, seg4:46927).
* Timeouts (MAC): 1000/2000 ms for most commands, 4000 ms for WRITE, 8000 ms for ADD PICTURE.

### 2.3 Status and error codes

ALBUM never compares `DS:24B9` against specific values (searched all `cmp` of status in seg2/3/4). The wrappers do:

* `== 0` success, otherwise −1 (or −2 for CHDIR). FIND, CLOSE and STAT return the raw status byte to callers, which
  only test for non-zero.
* MAC's error object packs `0x0300 | (cmd2 << 8 | status)` (e.g. `0x4A00|status` for OPEN), again with no case analysis.

Hardware observations (coordinator): 00 OK; FE end of directory; FF not found; 03 unsupported command or parameter; FC seen.

Internal ALBUM return codes (useful when matching its behaviour): −10 Esc abort; −11 battery too low; −12 user declined
the battery warning; −13 not connected; −1000 invalid settings or baud index; −1001 user cancelled retry;
100 = set/get speed refused; 102 = unsupported baud; −10000/−10001 = bad `02 18` stream flag; −20000 = stream overrun.

### 2.4 Host ID / "DSC-F1 compatibility" (CONFIRMED)

ALBUM keeps two connect routines:

| | seg2:50856 (camera type 1) | seg2:49998 (camera type 2) |
|---|---|---|
| Host ID (seg2:0xc914 / 0xc8f4) | `SONY     MKY-1001         1.00` | `SONY     DSC-2050         1.00` |
| Port speeds | opens COM directly at 9600, 19200 or 38400 (index 0..2) | opens at 9600, hello, then if the reply says `RS` sends `01 03` (index 0..7, up to 921600) and verifies with `01 04` |
| Battery state 3/4 | accepted silently | Yes/No warning (string 15522) |
| COM auto-detect | tries COM1..COM5 | tries COM1..COM5 |

* Selection: `DS:6FC6` (1 or 2) is set in the Settings dialog procedure (seg4:3814–3870) from `DS:6FBC`
  (radio 208 = type 2 using baud `DS:6FC2`, radio 209 = type 1 using baud `DS:6FC4`). Defaults on a fresh install:
  type 1, F1 baud index 2 (38400), DSC baud index 4 (115200) (seg2:10745).
* The English `ALBUMENV` dialog template has **no** controls 200–205 or 208/209. Only 9600/19200/38400 (210–212) exist,
  so the UI always picks the MKY-1001 path. Workaround (INFERRED): `env.dat` in the program directory is a raw
  0x30-byte dump of `DS:6F9A–6FC9` (seg2:16287–16453). Word +0x22 (`6FBC`) = 1 selects DSC-2050 mode, +0x28 (`6FC2`) is
  that mode's baud index, and +0x2C (`6FC6`) is the active type.
* Paths and commands are otherwise **identical** in both modes. Neither ALBUM mode switches between PIC_CAM and PIC_MD.
* MAC (`Connect`, mac:0x1ff1c): sends 0x85, then hello = `"SONY     "` + (preference ? `"MKY-XXXX"` : `"DSC-XXXX"`, padded to 17)
  + `"0000"`, with **literal X's**. That suggests the camera only checks the `MKY-` or `DSC-` prefix (INFERRED). It then
  classifies the reply model (bytes 9..16): `MKY-1000`→1000, `MKY-2000`→2000, `MKY-3000`→3000, `DSC-RS`→2050.
  Speed change (`ChangeRate`/`ConfirmRate`) only happens for 2050 (mac:0x1fa10). Then it probes `/PIC_CAM` and falls back
  to `/PIC_MD` (mac:0x1fb7c–0x1fbec). Observed MD1 replies: `SONY MKY-2000 1.14` and `SONY DSC-RS 05.00 1.14`.

---

## 3. Reply layouts

### 3.1 `03 02` status (30 bytes of reply data)

ALBUM copies all 30 bytes (seg4:52090), then patches a few fields. MAC `CameraStatus` (mac:0x210d8) decodes them.

| data off | size | Meaning | Evidence |
|---|---|---|---|
| 0 | 1 | Function dial (chotplay: 1 play, 2 rec-auto, 3 rec-manual) | MAC byte 0; chotplay |
| 1–2 | 2 | Picture count | MAC u16; ALBUM uses only low byte data[2] |
| 3–4 | 2 | Picture count 2 (shown as "Total" in the Open Camera dialog) | ALBUM seg4:24411 uses data[4]; MAC u16 |
| 5 | 1 | **Power state:** 0–2 = battery nearly discharged (string 15020, refuse), 3–4 = running on battery (string 15522), 5 = AC | CONFIRMED seg2:47940–48160 |
| 6 | 1 | ? | MAC byte |
| 7–11 | 5 | Clock: year, month, day, hour, minute in BCD (chotplay); MD1 with unset clock returns `50 01 01 00 12` | chotplay; sample |
| 12 | 1 | Seconds (INFERRED, BCD) | sample `07` |
| 13–17 | 5 | ? (MD1: `00 01 00 01 00`) | MAC copies bytewise |
| 18–21 | 4 | **Change serial**: ALBUM stores it in `cache\cache.env` to decide whether its thumbnail and index cache is stale. MD1 returns `FF FF FF FF`. | CONFIRMED seg3:47239+ |
| 22–29 | 8 | zero | — |

### 3.2 `02 01` volume info

The ALBUM parser is seg4:47384–48358. The disk-free consumer is seg2:45716.

| data off | size | Field | Evidence and samples (before format → after camera format) |
|---|---|---|---|
| 0–1 | 2 | ? (FS version?) | `0001` → `0003` |
| 2 | 1 | ? | `00` → `01` |
| 3 | 1 | ? | `62` both |
| 4–35 | 32 | **Volume label** (ASCII, NUL-padded) | empty → `PICTURE MD DATA` |
| 36–39 | 4 | Packed date/time 1 (created) | ALBUM bitfield decode |
| 40–43 | 4 | Packed date/time 2 (modified) | |
| 44–45 | 2 | **Sectors per cluster** | `0004` → `0020` |
| 46–49 | 4 | Total clusters | `44D0` (17616) → `089A` (2202) |
| 50–53 | 4 | Total clusters (again) / usable clusters | same values |
| 54–57 | 4 | **Free clusters** | `3DDE` → `0852` (2130) |
| 58–61 | 4 | ? | `05F2` → `0028` |
| 62–65 | 4 | ? | 0 |
| 66–67 | 2 | ? (entry count?) | `0007` → `0003` |
| 68–69 | 2 | ? | `002A` → `0006` |
| 70–77 | 8 | Constant across format: `C0 62 51 0C 00 61 EB 5C` — disc or drive unique ID? (INFERRED) | not parsed by ALBUM |

ALBUM computes "free bytes" = free clusters × data[44..45] (seg2:45813–45836). That is really *free sectors*;
× 2048 gives bytes (17616×4×2048 ≈ 2202×32×2048 ≈ 144 MB). Consequence: **the camera's own quick format changed the
allocation unit from 8 KB to 64 KB clusters.**

### 3.3 Directory entry (`02 05` / `02 06` / `02 0F`; 34 bytes of reply data)

Parser: seg4:48698–49345 (find-first), the same layout for STAT (seg4:51381+). MAC `FileStatus` decodes 0x22 bytes.

| off | size | Field |
|---|---|---|
| 0–1 | 2 | Attributes (`0001` = directory; `0080` = file; `4080` seen on PIDX000.PMX; `0000` on PDF_MD files) |
| 2 | 1 | Flag byte |
| 3–13 | 11 | 8.3 name, space padded. A folder's own first entry from find-first is named 0x01. |
| 14–17 | 4 | Packed date/time #1. **This is the one ALBUM displays** (seg2:43560–43629). |
| 18–21 | 4 | Packed date/time #2 |
| 22–25 | 4 | Packed date/time #3 |
| 26–29 | 4 | 32-bit value (ALBUM copies it, never uses it; monotonically increasing per created object → entry or object number, INFERRED) |
| 30–33 | 4 | File size |

Packed date/time (CONFIRMED by bit masks in seg4:47498–47714 and 48764–49214): bytes `b0 b1 b2 b3` form two
big-endian words. The date word is year:7 (bits 15..9), month:4, day:5. The time word is hour:5, minute:6, second/2:5.
ALBUM forces year = 0 for camera files (seg2:43566) and uses `second = field` without ×2. The year base is not
determined. Camera stamps with an unset clock decode to year 0, Jan 1. The PDF_MD files decode to year 26, which is
1996 with a 1970 base or 2006 with a 1980 base. #1/#2/#3 look like created / modified / accessed-or-attribute-changed
(INFERRED from samples: #3 usually equals #1, but equals #2 for OV_INF.PMF).

---

## 4. File formats

### 4.1 Common Sony "PMx" header (TLV)

Every PMF, PMX and PMP file starts with a tag-0x10 TLV record. seg3:2172 reads the BE32 values at +8 and +12;
seg3:2329 writes them.

```
00  10            tag 0x10 (file header)
01  12            length 0x12
02  ver16         0x0009 (F1-era samples) / 0x0100 (MD1)
04  type8         0x00 OV_INF, 0x01 PIC_INF, 0x10 PMP, 0x11 OV_IDX, 0x12 PIDX   (INFERRED from samples)
05  00
06  ntags8 / ?    PMP: number of TLV records (5); PMF/PMX: 01/02/03 (meaning unknown)
07  00
08  body_off32    offset of the body (0x14 F1 PIC_INF, 0x40 F1 OV_INF, 0x100 everything on MD1)
0C  body_len32    PMF: length of body; PMX block / PMP: JPEG length
10  4 bytes       0 (part of tag 0x10)
14  next TLV ...
```

TLV walker seg3:2404 (`find tag`): records are `tag8 len8 data[len]`, at most 100 of them, all inside the first
0x100 bytes. The per-tag copy sizes used by ALBUM are 0x10→20, 0x11/0x12→string, 0x13→0x48, 0x14→2, 0x20/0x21→0x1C,
0x24→0x18 bytes.

### 4.2 PMP picture (`PSNnnnnn.PMP`)

The header is the TLV list in the first 0x100 bytes; the JPEG starts at `body_off` (0x100) and is `body_len` long.
MD1 sample PSN00018 has tags at 0x00 (0x10), 0x14 (0x20), 0x30 (0x21), 0x4C (0x24), 0x64 (0x11). The F1 layout
used by chotplay is the same set in a different order. Its fixed offsets (quality 0x1D, take date 0x4C, comment 0x34,
speed 0x66, flash 0x76) are exactly "tag record + field" for an F1 file. **Parse the tags; do not use fixed offsets.**

Image Information dialog (`PMD_GRPINFO`, code seg4:13250–15260) uses:

| Tag | Field (offset in record incl. tag/len) | Meaning | Evidence |
|---|---|---|---|
| 0x20 | +2..3, +4..5 | width, height (640, 480) | sample; MAC `PreparePictureMDImageData` |
| 0x20 | +9 | **quality**, BCD: ≥33 "fine", ≥17 "standard", else "snap shot" (0x33 FINE, 0x17 STD, 0x08 economy) | seg4:13379–13442 |
| 0x20 | +0x14..0x17 | second width/height pair (640×480) | sample |
| 0x21 | +4..9 | **recorded** year (2-digit binary; <50 → 20xx, else 19xx via seg2:40314), month, day, hour, minute, second; 0xFF = not set | seg4:13547–13700 |
| 0x21 | +0x0C..0x11 | **edited** date, same encoding (MAC `SetEditDate` mac:0x1d4cc writes it) | seg4:13731–14170 |
| 0x24 | +2..3 | **shutter** = APEX Tv × 100 (BE16); 0x8000/0xFFFF = n/a. Display buckets: <3.32 "1/7.5", <4.32 "1/15", <5.32 "1/30", <6.23 "1/60", <7.16 "1/100", <8.55 "1/250", <9.55 "1/500", else "1/1000" (constants at DGROUP 0x1330–0x134C) | seg4:14197–14578 |
| 0x24 | +6..7, +8..9, +0x0C..0x0D | three more "%03d/100" values shown in hidden dialog items 121, 122 and 130 (aperture/EV?, INFERRED) | seg4:14665–15100 |
| 0x24 | +0x12 | **flash**: non-zero "ON", 0 "OFF" | seg4:15128–15151 |
| 0x12 | +4.. | **caption** string (edit box limited to 14 chars, EM_LIMITTEXT 0x0E) | seg4:15190–15258 |
| 0x11 | +4.. | text field (len 0x42 on MD1; chotplay "comment" on F1) | sample |

MD1 sample values: quality 0x33 (fine), shutter 0x0298 → Tv 6.64 → "1/100", dates 0xFF (clock unset), flash 0.

### 4.3 PIC_INF.PMF (per album `PICnnnnn/`)

Body at `body_off` (0x14 on F1, 0x100 on MD1); base = file + body_off. Readers and writers: seg3:15676–20356.

| base off | size | Field | Evidence |
|---|---|---|---|
| +4 | 2 | Last assigned or next PSN number (the add function stores the new number here) | seg3:20139–20152 |
| +6 | 2 | **Image count** | seg3:16298, 19842 |
| +0x0A, +0x0B | 1+1 | Number of PIDX files (both incremented when count % 16 == 0) | seg3:19856–19872 |
| +0x0E | 2 | MD1 sample = count | sample |
| +0x0C | 256×4 | **PIDX allocation table**: record k = `[0]` PIDX file number k (0 if unused), `[1]` 0, `[2..3]` thumbnails stored in PIDXk.PMX | seg3:17221–17280, 19895–19933 |
| +0x40C | count×16 | **Image entries** | |

Image entry (16 bytes):

| off | Field | Evidence |
|---|---|---|
| 0–1 | **Album folder number** (`PICnnnnn` → nnnnn; parsed from the path by seg3:5586) | seg3:20239–20254; MD1 = 0001 for all |
| 2–3 | **PSN number** (`PSNnnnnn.PMP`) | seg3:16391–16407, 20258–20268 |
| 4 | ? (MD1: 01) | — |
| 5 | bits 2–3 = **rotation** 0/4/8/0xC (quarter turns; direction unconfirmed); ALBUM's reader also keeps the whole byte | seg3:17692–17696, 17918–17926, 27404–27422 |
| 6 | ? | — |
| 7 | MD1: 01 only on the entry whose PSN has an `NRA` sound file → **sound flag** (INFERRED; ALBUM never reads it) | sample |
| 8–13 | MD1: FF×6 | — |
| 14 | bit 0 = **protect** (drawn as the "lock" bitmap) | seg3:16629, 42506 |
| 15 | ? | — |

### 4.4 OV_INF.PMF (album list, `/PIC_MD/OV_INF.PMF`)

Reader seg3:9246 retries the open up to 11 times and rejects body_off ≥ 500.

| base off | size | Field |
|---|---|---|
| +0..1 | 2 | Non-zero = valid (if 0, the album count is treated as 0) — MD1 `0010` |
| +2..3 | 2 | Returned to the caller (next album number?) — MD1 `0002` |
| +4..5 | 2 | **Album count** — MD1 `0001` |
| +0x0B..0x0F | | FF in MD1 |
| +0x20 | count×0x30 | Album entries |

Album entry (0x30 bytes): +0..1 album folder number; +2..3 and byte +6 combined into one value by the reader
(meaning unclear); +4..5 image count (MD1: 0x0010; INFERRED); +0x0E bit 0 protect (drawn as a lock for album lists,
seg3:42474–42506); F1 sample has the ASCII title `PIC00000` at +8 (INFERRED: album title field).

### 4.5 PMX thumbnail containers (`OV_IDX.PMX`, `PIDXnnn.PMX`)

A sequence of **4096-byte blocks**, one thumbnail per block. Each block = its own 0x100-byte TLV header (type 0x12
PIDX or 0x11 OV_IDX, body_off 0x100, body_len = JPEG size) + JPEG (SOI at block+0x100). MD1 PIDX000.PMX = 19 blocks
for 19 pictures; OV_IDX.PMX = 1 block (album cover). The OV_IDX header has extra bytes at +0x14..0x17
(`92 16 A0 21`). The thumbnail for image *i* lives in the PIDX file and slot given by the PIC_INF allocation table:
16 per PIDX file (seg3:19856), so slot = i mod 16 and file = i div 16 (INFERRED from the 16-per-file rule;
chotplay derives it from the table). ALBUM errors: `PMX_Create[GetGrpSort ERROR|DATA ERROR|JPEG(2B) ERROR|JPEG(3) ERROR|PIDX FILE SIZE ERROR]`.

### 4.6 Sound

ALBUM 1.50 has `SOUND`/`SOUND_` bitmaps in its resources, but no code references them. The bitmap names it loads
(`lock`, `simbol`, `yhai`…, seg3:0xAF7C–0xB03C) do not include "sound". No `NRA`/`.PMA` string exists in ALBUM, the
TWAIN DS or MAC. **None of the Sony 1997 software understands sound files.** The only trace is the PIC_INF entry
byte 7 (§4.3) and the unused bitmap.

### 4.7 Other local files

* `env.dat`: raw 0x30-byte settings dump (§2.4).
* `cache\cache.env`: 4-byte change serial (§3.1).
* `cache2\pic_cam\pic%05d`: IR image cache.
* `PMDTEMP.DAT` sample: contains `0:\PIC_MD\PIC00000\PIDX000.PMX`, i.e. a camera path on drive `0:`.

---

## 5. Hidden or other capabilities

* **No remote control, shutter release, live preview or clock-set command** exists in ALBUM, the TWAIN DS (same command
  table: its globals `es:[0x15]/[0x16]` take exactly 01 02/03/04, 02 01–06, 08–0F, 14, 17, 18, 03 02 plus hello) or MAC
  (`CMKY2000` methods: FindPort, OpenPort, Connect, ChangeRate, ConfirmRate, Disconnect, FileOpen/Close/Read/Read1K/
  Write/Write1K/Seek, FileStatus, CameraStatus, AddPicture, DeletePicture).
* The IR camera path (`02 18` stream, image number API) is the only "extra" API. `02 17` (1 KB block by number) has a
  wrapper but no caller.
* MAC writes MD-specific PMP headers itself (`CExternalImage::PreparePictureMDImageData`, `CPictureMDSaveOptionDialog`).
  It prepares an MD-format image and then uploads with `02 14`.

## 6. Things to avoid

* `02 10` = format (hardware-confirmed by the coordinator; never sent by the Sony software).
* `02 15 n` deletes a picture (no confirmation, index semantics uncertain).
* `02 08`, `02 04`, and `02 0A 02 00` on an existing path (ALBUM always deletes first, so create-over-existing behaviour
  is untested).
* `02 14` makes the camera create new PSN/PIDX/PIC_INF entries. Do not use it for byte-exact restores.
* Rewriting `PIC_INF.PMF` / `OV_INF.PMF` with inconsistent counts or allocation tables. The camera trusts these files
  (ALBUM and MAC both write them directly).
