#!/usr/bin/env python3
"""Read-only downloader for the Sony DSC-MD1 (MD Cyber-shot) over RS-232.

The MD1 speaks the DSC-F1 serial protocol (see libgphoto2 camlibs/sonydscf1 and
chotplay 0.06): 8N1, frames are C0 <addr> <payload> <checksum> C1, with 0x7D
escaping. The camera exposes a small remote filesystem; MD1 albums live under
/PIC_MD/PICnnnnn/ and each photo is PSNnnnnn.PMP (124-byte header + JPEG).

SAFETY: this tool can only ever send the commands in ALLOWED_COMMANDS. The
protocol's write (02 14) and delete (02 15) commands, format, upload, rename,
etc. are not implemented and are rejected by _send() even if a bug tried.

Extra commands found by disassembling Sony's ALBUM.EXE (segment 4):
  01 03 <code>        set link speed (0=9600 1=19200 2=38400 3=57600 4=115200 ...)
  01 04               get link speed code
  02 01               volume / free-space info
  02 05 <pattern>\\0   find first directory entry
  02 06               find next directory entry
  02 17 <b> <w16>     read a 1 KB block
  02 18 00 <w16>      size of object n;  02 18 01 <w16> streams object n
Seen but deliberately not allowed: 02 02/03/04/08 (path ops), 02 09 (rename),
02 0D (write to handle), 02 14 (write), 02 15 (delete).
DANGER: 02 10 (no arguments) FORMATS the disc — confirmed 2026-10-18. Never send it.
"""

import argparse
import datetime
import os
import shlex
import sys
import time

import serial

def default_port():
    """First USB-serial adapter found (macOS /dev/cu.usbserial-*, Linux /dev/ttyUSB*)."""
    import glob
    for pattern in ("/dev/cu.usbserial-*", "/dev/ttyUSB*", "/dev/cu.usbmodem*"):
        found = sorted(glob.glob(pattern))
        if found:
            return found[0]
    return None


DEFAULT_PORT = default_port()
BAUDS = [38400, 19200, 9600, 57600, 115200]

BOFRAME, EOFRAME, ESC = 0xC0, 0xC1, 0x7D
SENDADDR = [0x00, 0x22, 0x44, 0x66, 0x88, 0xAA, 0xCC, 0xEE]
RECVADDR = [0x0E, 0x20, 0x42, 0x64, 0x86, 0xA8, 0xCA, 0xEC]

# (byte0, byte1) of every command this tool is permitted to send. All read-only.
ALLOWED_COMMANDS = {
    (0x01, 0x01): "hello",
    (0x03, 0x02): "status",
    (0x02, 0x0A): "fopen",
    (0x02, 0x0B): "fclose",
    (0x02, 0x0C): "fread",
    (0x02, 0x0F): "finfo",
    (0x01, 0x03): "set speed",
    (0x01, 0x04): "get speed",
    (0x02, 0x01): "volume info",
    (0x02, 0x05): "find first",
    (0x02, 0x06): "find next",
    (0x02, 0x17): "block read",
    (0x02, 0x18): "object size / stream",
}

MAX_PAYLOAD = 96  # observed: 133-byte find-first OK, 138-byte one hung the camera

SPEED_CODES = {0: 9600, 1: 19200, 2: 38400, 3: 57600, 4: 115200, 5: 230400, 6: 460800, 7: 921600}

HOST_IDS = {
    "f1": b"SONY     MKY-1001         1.00",
    "md": b"SONY     DSC-2050         1.00",
}

PMP_HEADER = 0x7C


class ProtocolError(Exception):
    pass


class SequenceNak(ProtocolError):
    """Camera answered with an empty 0x83 frame: our frame address was out of sequence."""


def hexs(b):
    return " ".join(f"{x:02x}" for x in b)


def printable(b):
    return "".join(chr(x) if 32 <= x < 127 else "." for x in b)


class Camera:
    def __init__(self, port, baud, log, verbose=False):
        self.ser = serial.Serial(port, baud, bytesize=8, parity="N", stopbits=1,
                                 timeout=0.5, xonxoff=False, rtscts=False, dsrdtr=False)
        self.addr = 0
        self.log = log
        self.verbose = verbose
        self.ser.reset_input_buffer()

    def close(self):
        self.ser.close()

    def _trace(self, direction, data):
        line = f"{datetime.datetime.now().isoformat(timespec='milliseconds')} {direction} {hexs(data)}"
        self.log.write(line + "\n")
        self.log.flush()
        if self.verbose:
            print(line[:220])

    def _send(self, payload):
        key = (payload[0], payload[1]) if len(payload) >= 2 else None
        if key not in ALLOWED_COMMANDS:
            raise RuntimeError(f"refusing to send non-whitelisted command {hexs(payload[:2])}")
        if len(payload) > MAX_PAYLOAD:
            # Firmware 1.14 hangs hard (battery pull needed) on a ~138-byte find-first path.
            raise RuntimeError(f"refusing {len(payload)}-byte payload (camera locks up on long paths)")
        a = SENDADDR[self.addr]
        chk = (0x100 - ((a + sum(payload)) & 0xFF)) & 0xFF
        body = bytearray()
        for x in bytes(payload) + bytes([chk]):
            if x in (BOFRAME, EOFRAME, ESC):
                body += bytes([ESC, x ^ 0x20])
            else:
                body.append(x)
        frame = bytes([BOFRAME, a]) + bytes(body) + bytes([EOFRAME])
        self._trace(">", frame)
        self.ser.write(frame)
        self.ser.flush()
        self.addr = (self.addr + 1) % 8

    def abort(self):
        frame = bytes([BOFRAME, 0x85, 0x7B, EOFRAME])  # link-level abort, no command
        self._trace(">", frame)
        self.ser.write(frame)
        self.ser.flush()
        time.sleep(0.2)
        junk = self.ser.read(self.ser.in_waiting or 0)
        if junk:
            self._trace("<", junk)

    def _recv(self, timeout=6.0):
        """Read one frame; return (addr, payload) with escapes removed and checksum verified."""
        deadline = time.monotonic() + timeout
        raw = bytearray()
        # wait for start of frame
        while True:
            if time.monotonic() > deadline:
                if raw:
                    self._trace("<", raw)
                raise ProtocolError("timeout waiting for frame start" + (f" (got {hexs(raw[:32])})" if raw else ""))
            c = self.ser.read(1)
            if not c:
                continue
            raw += c
            if c[0] == BOFRAME:
                break
        data = bytearray()
        while True:
            if time.monotonic() > deadline:
                self._trace("<", raw)
                raise ProtocolError("timeout inside frame")
            chunk = self.ser.read(max(1, min(self.ser.in_waiting, 4096)))
            if not chunk:
                continue
            raw += chunk
            data += chunk
            if EOFRAME in chunk:
                break
        end = data.index(EOFRAME)
        extra = data[end + 1:]
        data = data[:end]
        self._trace("<", raw)
        if extra:
            self._trace("< (trailing)", extra)
        dec = bytearray()
        i = 0
        while i < len(data):
            x = data[i]
            if x == ESC and i + 1 < len(data):
                i += 1
                x = data[i] ^ 0x20
            dec.append(x)
            i += 1
        if len(dec) < 2:
            raise ProtocolError(f"short frame {hexs(dec)}")
        addr, payload, chk = dec[0], bytes(dec[1:-1]), dec[-1]
        if (addr + sum(payload) + chk) & 0xFF:
            raise ProtocolError(f"checksum error in frame {hexs(dec[:24])}...")
        return addr, payload

    def transact(self, payload, timeout=6.0, resync=True):
        # A 0x83 NAK means the frame was rejected (not executed) because its sequence
        # address was wrong (e.g. after a speed change), so resending is always safe.
        for _ in range(len(SENDADDR) if resync else 1):
            self._send(payload)
            addr, reply = self._recv(timeout)
            if not (addr == 0x83 and not reply):
                break
        else:
            raise SequenceNak("camera reports frame out of sequence")
        if addr == 0x83 and not reply:
            raise SequenceNak("camera reports frame out of sequence")
        if reply[:2] != bytes(payload[:2]):
            raise ProtocolError(f"unexpected reply {hexs(reply[:16])} to {hexs(payload[:2])}")
        return reply

    # --- protocol commands (read-only) ---

    def hello(self, host_id):
        reply = self.transact(b"\x01\x01" + host_id)
        if reply[2] != 0:
            raise ProtocolError(f"hello rejected, code {reply[2]:02x}: {hexs(reply)}")
        return reply

    def status(self):
        r = self.transact(b"\x03\x02")
        if r[2] != 0:
            raise ProtocolError(f"status error {r[2]:02x}")

        def bcd(x):
            return (x >> 4) * 10 + (x & 0x0F)
        return {
            "raw": r,
            "mode": r[3],
            "pictures": r[4] * 256 + r[5],
            "pictures2": r[6] * 256 + r[7],
            "datetime": f"{bcd(r[10]):02d}-{bcd(r[11]):02d}-{bcd(r[12]):02d} {bcd(r[13]):02d}:{bcd(r[14]):02d}"
            if len(r) > 14 else "?",
        }

    def finfo(self, name):
        r = self.transact(b"\x02\x0F" + name.encode("ascii") + b"\x00")
        if r[2] != 0:
            return None, r
        size = int.from_bytes(r[33:37], "big") if len(r) >= 37 else None
        return size, r

    def fopen(self, name):
        """Open read-only (mode 00 00); returns the camera's 16-bit file handle."""
        r = self.transact(b"\x02\x0A\x00\x00" + name.encode("ascii") + b"\x00")
        if r[2] != 0:
            raise ProtocolError(f"fopen {name} failed: {hexs(r)}")
        return int.from_bytes(r[3:5], "big") if len(r) >= 5 else 0

    def fclose(self, handle=0):
        r = self.transact(b"\x02\x0B" + handle.to_bytes(2, "big"))
        return r[2] == 0

    def fread(self, handle=0, n=0x800):
        # [handle:2][length:4]; the camera returns at most 2048 bytes per request.
        r = self.transact(b"\x02\x0C" + handle.to_bytes(2, "big") + n.to_bytes(4, "big"))
        if r[2] != 0:
            raise ProtocolError(f"fread error {hexs(r[:8])}")
        length = r[5] * 256 + r[6]
        data = r[7:7 + length]
        if len(data) != length:
            raise ProtocolError(f"fread short block: header says {length}, got {len(data)}")
        return data

    def get_speed(self):
        r = self.transact(b"\x01\x04")
        return r[2], r[3:]

    def set_speed(self, baud):
        code = {v: k for k, v in SPEED_CODES.items()}[baud]
        r = self.transact(b"\x01\x03" + bytes([code]))
        if r[2] != 0:
            raise ProtocolError(f"set speed {baud} refused: {hexs(r)}")
        time.sleep(0.2)
        self.ser.baudrate = baud
        time.sleep(0.1)
        self.ser.reset_input_buffer()
        return r

    @staticmethod
    def parse_entry(r):
        """Directory entry as returned by find first/next and finfo (after the 3-byte echo)."""
        d = r[3:]
        raw = d[3:14]
        # A folder's own entry (first reply of find-first) is named 0x01 + spaces: treat as unnamed.
        name = "" if raw[:1] < b" " else raw.decode("ascii", "replace")
        base, ext = name[:8].rstrip(), name[8:].rstrip()
        return {
            "name": base + ("." + ext if ext else ""),
            "attr": int.from_bytes(d[0:2], "big"),
            "flag": d[2],
            "is_dir": d[1] == 0x01,
            "size": int.from_bytes(r[33:37], "big") if len(r) >= 37 else None,
            "rest": d[14:30],
        }

    def find_first(self, pattern):
        r = self.transact(b"\x02\x05" + pattern.encode("ascii") + b"\x00")
        return (self.parse_entry(r) if r[2] == 0 else None), r

    def find_next(self):
        r = self.transact(b"\x02\x06")
        return (self.parse_entry(r) if r[2] == 0 else None), r

    def list_dir(self, pattern, limit=5000):
        out = []
        e, r = self.find_first(pattern)
        while e is not None and len(out) < limit:
            out.append(e)
            e, r = self.find_next()
        return out, r

    def read_file(self, name, progress=True):
        size, _ = self.finfo(name)
        handle = self.fopen(name)
        out = bytearray()
        try:
            t0 = time.monotonic()
            while True:
                block = self.fread(handle)
                if not block:
                    break
                out += block
                if progress and size:
                    rate = len(out) / max(0.001, time.monotonic() - t0)
                    print(f"\r  {name}: {len(out)}/{size} bytes ({rate:.0f} B/s)   ", end="", flush=True)
        finally:
            self.fclose(handle)
        if progress:
            print()
        if size is not None and len(out) != size:
            raise ProtocolError(f"{name}: got {len(out)} bytes but finfo said {size}")
        return bytes(out)


def connect(args, log):
    """Open the port and complete the hello handshake, trying bauds/IDs as needed."""
    bauds = [args.baud] if args.baud else BAUDS
    ids = [args.id] if args.id else ["f1", "md"]
    for baud in bauds:
        cam = Camera(args.port, baud, log, args.verbose)
        for idname in ids:
            for attempt in range(2):
                try:
                    # The camera keeps its frame sequence across sessions; step through
                    # the 8 addresses until it accepts one (each NAK advances ours by one).
                    for _ in range(len(SENDADDR)):
                        try:
                            reply = cam.hello(HOST_IDS[idname])
                            break
                        except SequenceNak:
                            continue
                    else:
                        raise ProtocolError("no frame address accepted")
                    print(f"Connected at {baud} baud using host id '{idname}'.")
                    print(f"  camera hello reply: {hexs(reply)}")
                    print(f"                      {printable(reply)}")
                    if getattr(args, "speed", None) and args.speed != baud:
                        cam.set_speed(args.speed)
                        cam.status()
                        print(f"  switched link to {args.speed} baud")
                    return cam
                except ProtocolError as e:
                    print(f"  {baud} baud, id '{idname}', try {attempt + 1}: {e}")
                    cam.abort()
        cam.close()
    return None


def cmd_listen(args, log):
    s = serial.Serial(args.port, args.baud or 38400, timeout=0.5)
    print(f"Listening passively on {args.port} at {s.baudrate} baud for {args.seconds}s (sending nothing)...")
    end = time.monotonic() + args.seconds
    got = bytearray()
    while time.monotonic() < end:
        got += s.read(256)
    s.close()
    print(f"Received {len(got)} bytes: {hexs(got[:128])}")


def cmd_probe(args, log):
    cam = connect(args, log)
    if not cam:
        print("\nNo valid reply from the camera. Check: power on, function switch on PLAY,"
              " IrDA menu OFF, cable fully seated; then try a null-modem adapter (TX/RX swap).")
        return 1
    st = cam.status()
    modes = {1: "playback", 2: "record (auto)", 3: "record (manual)"}
    print(f"Status: mode={st['mode']} ({modes.get(st['mode'], '?')}), pictures={st['pictures']}"
          f" ({st['pictures2']}), camera clock={st['datetime']}")
    print(f"  raw: {hexs(st['raw'])}")
    cam.close()
    return 0


def cmd_info(args, log):
    cam = connect(args, log)
    if not cam:
        return 1
    cam.status()
    for name in args.paths:
        try:
            size, r = cam.finfo(name)
            print(f"{name}: {'NOT FOUND' if size is None else f'{size} bytes'}   [{hexs(r)}]")
        except ProtocolError as e:
            print(f"{name}: error {e}")
            cam.abort()
    cam.close()
    return 0


def cmd_get(args, log):
    cam = connect(args, log)
    if not cam:
        return 1
    cam.status()
    data = cam.read_file(args.path)
    out = args.output or os.path.join(args.outdir, args.path.strip("/").replace("/", "_"))
    if os.path.exists(out):
        print(f"{out} already exists; not overwriting.")
    else:
        with open(out, "xb") as f:
            f.write(data)
        print(f"Saved {len(data)} bytes to {out}")
    cam.close()
    return 0


def cmd_ls(args, log):
    cam = connect(args, log)
    if not cam:
        return 1
    cam.status()
    for pat in args.patterns:
        entries, last = cam.list_dir(pat)
        print(f"{pat}: {len(entries)} entries (end reply: {hexs(last[:8])})")
        for en in entries:
            kind = "<DIR>" if en["is_dir"] else f"{en['size']:>9}"
            print(f"  {en['name']:<13} {kind}  attr={en['attr']:04x} flag={en['flag']:02x}  {hexs(en['rest'])}")
    cam.close()
    return 0


def parse_raw(tokens):
    """Tokens: hex bytes ('02'), 's:text' (NUL-terminated ASCII), 'w:NNN' (16-bit big-endian)."""
    out = bytearray()
    for t in tokens:
        if t.startswith("s:"):
            out += t[2:].encode("ascii") + b"\x00"
        elif t.startswith("w:"):
            out += int(t[2:], 0).to_bytes(2, "big")
        else:
            out.append(int(t, 16))
    return bytes(out)


def cmd_raw(args, log):
    cam = connect(args, log)
    if not cam:
        return 1
    cam.status()
    for spec in args.commands:
        payload = parse_raw(shlex.split(spec))
        try:
            cam._send(payload)
            frames = []
            while True:
                try:
                    _, reply = cam._recv(timeout=args.timeout if not frames else 1.5)
                except ProtocolError:
                    break
                frames.append(reply)
            for f in frames:
                print(f"{spec!r} -> [{len(f)}] {hexs(f[:64])}{' ...' if len(f) > 64 else ''}")
                print(f"{'':>{len(repr(spec))}}    {printable(f[:64])}")
            if not frames:
                print(f"{spec!r} -> no reply")
                cam.abort()
        except RuntimeError as e:
            print(f"{spec!r} -> {e}")
    cam.close()
    return 0


PMA_HEADER = 0x100
ATRAC1_SU = 212


def pma_to_wav(pma, wav_path):
    """NRAnnnnn.PMA = 256-byte header + mono ATRAC1 sound units (212 bytes, 512 samples @ 44.1 kHz).

    Wrap the units in a MiniDisc .aea container and decode with ffmpeg's ATRAC1 decoder (PyAV).
    Returns the duration in seconds.
    """
    import tempfile
    import wave

    import av
    import numpy as np

    n = (len(pma) - PMA_HEADER) // ATRAC1_SU
    units = pma[PMA_HEADER:PMA_HEADER + n * ATRAC1_SU]
    hdr = bytearray(2048)
    hdr[0:4] = (0x800).to_bytes(4, "little")
    hdr[4:20] = b"DSC-MD1 audio".ljust(16, b"\0")
    hdr[264] = 1  # channels
    with tempfile.NamedTemporaryFile(suffix=".aea", delete=False) as t:
        t.write(bytes(hdr) + units)
        aea = t.name
    try:
        pcm = []
        with av.open(aea, format="aea") as c:
            for frame in c.decode(audio=0):
                pcm.append(frame.to_ndarray().reshape(-1))
        samples = np.concatenate(pcm)
        if samples.dtype.kind == "f":
            samples = (np.clip(samples, -1, 1) * 32767).astype("<i2")
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(samples.tobytes())
        return len(samples) / 44100
    finally:
        os.unlink(aea)


def walk(cam, path="/", seen=None, depth=0):
    """Yield (path, entry) for every file and folder on the disc, depth first.

    The camera keeps a single find-first/find-next cursor, so each folder is read
    completely before descending into its subfolders. Each entry carries a unique
    entry number (last 4 bytes of 'rest'); folders already visited are skipped so a
    confused reply can never send the walk round in circles.
    """
    seen = set() if seen is None else seen
    entries, _ = cam.list_dir(path)
    if entries and not entries[0]["name"]:  # first entry is the folder itself
        seen.add(bytes(entries[0]["rest"][-4:]))
    children = [en for en in entries if en["name"]]
    for en in children:
        yield (path.rstrip("/") + "/" + en["name"]), en
    if depth >= 8:
        return
    for en in children:
        key = bytes(en["rest"][-4:])
        if en["is_dir"] and key not in seen:
            seen.add(key)
            yield from walk(cam, path.rstrip("/") + "/" + en["name"], seen, depth + 1)


def all_jpegs(data):
    """Every complete JPEG embedded in a blob (thumbnail index files hold many)."""
    out, i = [], 0
    while True:
        a = data.find(b"\xff\xd8\xff", i)
        if a < 0:
            return out
        b = data.find(b"\xff\xd9", a)
        if b < 0:
            return out
        out.append(data[a:b + 2])
        i = b + 2


def convert_disc(discdir):
    """Turn a mirrored disc into viewable files: photos, sound and thumbnails."""
    mirror = os.path.join(discdir, "disc")
    made = {"jpeg": 0, "audio": 0, "thumbs": 0}
    for root, _, files in os.walk(mirror):
        album = os.path.basename(root)
        for fn in sorted(files):
            src = os.path.join(root, fn)
            data = open(src, "rb").read()
            stem, ext = os.path.splitext(fn)
            if ext == ".PMP" and stem.startswith("PSN"):
                jpg = extract_jpeg(data)
                if jpg:
                    os.makedirs(os.path.join(discdir, "jpeg"), exist_ok=True)
                    save_new(os.path.join(discdir, "jpeg", f"{album}_{stem}.jpg"), jpg)
                    made["jpeg"] += 1
            elif ext == ".PMA":
                os.makedirs(os.path.join(discdir, "audio"), exist_ok=True)
                wav = os.path.join(discdir, "audio", f"{album}_{stem}.wav")
                if not os.path.exists(wav):
                    pma_to_wav(data, wav)
                made["audio"] += 1
            elif ext == ".PMX":
                tdir = os.path.join(discdir, "thumbnails", f"{album}_{stem}")
                os.makedirs(tdir, exist_ok=True)
                for k, j in enumerate(all_jpegs(data)):
                    save_new(os.path.join(tdir, f"{k:04d}.jpg"), j)
                    made["thumbs"] += 1
    return made


def cmd_mirror(args, log):
    discdir = os.path.join(args.outdir, args.disc)
    mirror = os.path.join(discdir, "disc")
    cam = connect(args, log)
    if not cam:
        return 1
    cam.status()
    print("Listing every folder on the disc...")
    tree = list(walk(cam, "/"))
    files = [(p, en) for p, en in tree if not en["is_dir"]]
    total = sum(en["size"] or 0 for _, en in files)
    print(f"{len(tree) - len(files)} folders, {len(files)} files, {total:,} bytes")
    os.makedirs(discdir, exist_ok=True)
    with open(os.path.join(discdir, "listing.txt"), "w") as f:
        for p, en in tree:
            f.write(f"{p}\t{'DIR' if en['is_dir'] else en['size']}\tattr={en['attr']:04x}\t{hexs(en['rest'])}\n")
    skip = tuple(args.skip or ())
    failures = []
    for i, (p, en) in enumerate(files, 1):
        dest = os.path.join(mirror, p.lstrip("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        immutable = os.path.basename(p).startswith(("PSN", "NRA"))  # photos/sound never change
        if immutable and os.path.exists(dest) and os.path.getsize(dest) == en["size"]:
            continue
        if skip and p.startswith(skip):
            continue
        print(f"[{i}/{len(files)}] {p} ({en['size']:,} bytes)")
        for attempt in range(3):
            try:
                save_new(dest, cam.read_file(p))
                break
            except (ProtocolError, serial.SerialException) as e:
                print(f"\n  error: {e}; re-syncing")
                cam.abort()
                time.sleep(0.5)
        else:
            failures.append(p)
    cam.close()
    made = convert_disc(discdir)
    print(f"\nConverted: {made['jpeg']} photos, {made['audio']} sound files, {made['thumbs']} thumbnails")
    print("Failed: " + ", ".join(failures) if failures else "All files mirrored.")
    return 1 if failures else 0


def extract_jpeg(pmp):
    """PMP = 124-byte Picture MD header followed by a plain JPEG."""
    start = pmp.find(b"\xff\xd8\xff")
    if start < 0:
        return None
    end = pmp.rfind(b"\xff\xd9")
    return pmp[start:end + 2] if end > start else pmp[start:]


def save_new(path, data):
    """Write data atomically unless an identical file is already there."""
    if os.path.exists(path) and os.path.getsize(path) == len(data) and open(path, "rb").read() == data:
        return
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def cmd_pull(args, log):
    cam = connect(args, log)
    if not cam:
        return 1
    st = cam.status()
    print(f"Camera reports {st['pictures']} pictures (current album).")

    # Disc label: tag output folders so a second disc can't collide with the first.
    disc = args.disc
    discdir = os.path.join(args.outdir, disc)
    jpgdir = os.path.join(discdir, "jpeg")
    os.makedirs(jpgdir, exist_ok=True)

    # Disc-level indexes (small) are kept as part of the raw backup.
    for idx in ("OV_INF.PMF", "OV_IDX.PMX"):
        size, _ = cam.finfo(f"/PIC_MD/{idx}")
        if size is not None:
            save_new(os.path.join(discdir, idx), cam.read_file(f"/PIC_MD/{idx}", progress=False))

    if args.album:
        albums = [args.album]
    else:
        albums = []
        for a in range(args.max_albums):
            if cam.finfo(f"/PIC_MD/PIC{a:05d}/PIC_INF.PMF")[0] is not None:
                albums.append(f"PIC{a:05d}")
    print(f"Albums on disc: {', '.join(albums) or 'none found'}")

    names = []
    for album in albums:
        os.makedirs(os.path.join(discdir, "raw", album), exist_ok=True)
        inf = cam.read_file(f"/PIC_MD/{album}/PIC_INF.PMF", progress=False)
        save_new(os.path.join(discdir, "raw", album, "PIC_INF.PMF"), inf)
        expected = int.from_bytes(inf[0x104:0x106], "big") if len(inf) >= 0x106 else 0
        found, misses, n = 0, 0, 0
        while (found < expected or expected == 0) and misses < 60 and n < 2000:
            name = f"/PIC_MD/{album}/PSN{n:05d}.PMP"
            size, _ = cam.finfo(name)
            if size is None:
                misses += 1
            else:
                names.append((album, name, size))
                found += 1
                misses = 0
            n += 1
        note = "" if found == expected else f"  (index says {expected} - check!)"
        print(f"  {album}: {found} photo files{note}")

    failures = []
    for i, (album, name, size) in enumerate(names, 1):
        base = name.rsplit("/", 1)[1]
        rawpath = os.path.join(discdir, "raw", album, base)
        if os.path.exists(rawpath) and os.path.getsize(rawpath) == size:
            print(f"[{i}/{len(names)}] {base}: already downloaded, skipping")
            continue
        for attempt in range(1, 4):
            try:
                print(f"[{i}/{len(names)}] {base} ({size} bytes, attempt {attempt})")
                data = cam.read_file(name)
                break
            except (ProtocolError, serial.SerialException) as e:
                print(f"\n  transfer error: {e}; re-syncing")
                cam.abort()
                cam.close()
                time.sleep(1)
                cam = connect(args, log)
                if not cam:
                    return 1
                cam.status()
        else:
            failures.append(base)
            continue
        save_new(rawpath, data)
        jpg = extract_jpeg(data)
        if jpg:
            jpath = os.path.join(jpgdir, f"{album}_{base[:-4]}.jpg")
            with open(jpath, "wb") as f:
                f.write(jpg)
            ok = "" if jpg.endswith(b"\xff\xd9") else "  (warning: no JPEG end marker)"
            print(f"  saved {rawpath} and {jpath}{ok}")
        else:
            print(f"  saved {rawpath} (no JPEG found inside!)")
    cam.close()
    print(f"\nDone. {len(names) - len(failures)}/{len(names)} files downloaded."
          + (f" Failed: {', '.join(failures)}" if failures else ""))
    return 1 if failures else 0


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", default=DEFAULT_PORT, help="serial port (default: first USB-serial adapter found)")
    p.add_argument("--baud", type=int, help="fixed baud rate (default: try 38400, 19200, 9600, 57600, 115200)")
    p.add_argument("--id", choices=sorted(HOST_IDS), help="host id for hello (default: try f1, then md)")
    p.add_argument("-v", "--verbose", action="store_true", help="print raw serial traffic")
    p.add_argument("--speed", type=int, choices=sorted(SPEED_CODES.values()),
                   help="after connecting at --baud, switch the link to this speed (e.g. 115200)")
    p.add_argument("--outdir", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "downloads"))
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("listen", help="only listen on the port; sends nothing")
    s.add_argument("--seconds", type=float, default=3)
    sub.add_parser("probe", help="handshake + status (reads nothing from the disc)")
    s = sub.add_parser("info", help="file size/attributes for camera paths")
    s.add_argument("paths", nargs="+")
    s = sub.add_parser("get", help="download one camera file, byte-for-byte")
    s.add_argument("path")
    s.add_argument("-o", "--output")
    s = sub.add_parser("pull", help="download every photo in an album (raw .PMP + extracted .jpg)")
    s.add_argument("--disc", required=True, help="label for this disc; output goes to downloads/<disc>/")
    s.add_argument("--album", help="only this album (e.g. PIC00000); default: every album on the disc")
    s.add_argument("--max-albums", type=int, default=100)
    s = sub.add_parser("mirror", help="copy every file on the disc (byte-exact), then convert photos/sound/thumbnails")
    s.add_argument("--disc", required=True, help="label; output goes to downloads/<disc>/")
    s.add_argument("--skip", action="append", help="path prefix to leave out (repeatable)")
    s = sub.add_parser("ls", help="directory listing via find-first/find-next")
    s.add_argument("patterns", nargs="+")
    s = sub.add_parser("raw", help="send whitelisted commands with custom parameters, print every reply frame")
    s.add_argument("commands", nargs="+", help="e.g. '02 18 00 w:0'  or  '02 05 s:/PIC_MD/*.*'")
    s.add_argument("--timeout", type=float, default=6.0)
    args = p.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    logdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
    os.makedirs(logdir, exist_ok=True)
    logpath = os.path.join(logdir, datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + f"-{args.cmd}.log")
    with open(logpath, "w") as log:
        rc = {"listen": cmd_listen, "probe": cmd_probe, "info": cmd_info, "get": cmd_get,
              "pull": cmd_pull, "ls": cmd_ls, "raw": cmd_raw, "mirror": cmd_mirror}[args.cmd](args, log)
    print(f"(serial trace: {logpath})")
    return rc or 0


if __name__ == "__main__":
    sys.exit(main())
