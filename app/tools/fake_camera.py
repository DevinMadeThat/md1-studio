#!/usr/bin/env python3
"""Fake Sony DSC-MD1 camera on a pseudo-terminal, for testing clients without hardware.

Serves a mirrored disc directory (as written by `md1tool/md1.py mirror`) over the DSC-F1/MD1
serial protocol (docs/protocol.md). Reply layouts are copied from real camera traces in
md1tool/logs/. Standard library only.

Usage:
    python3 app/tools/fake_camera.py [DISC_DIR] [options]
    # prints:  FAKE CAMERA ON /dev/ttys012
    md1tool/.venv/bin/python md1tool/md1.py --port /dev/ttys012 --baud 9600 --speed 115200 --id f1 ls /PIC_MD

    DISC_DIR          mirror root (default downloads/disc2/disc); ../listing.txt supplies the
                      original entry order, timestamps and entry numbers when present.
Options:
    --start-baud N    camera link speed at start (9600 = after a battery pull; default 9600)
    --start-seq N     expected host frame index 0-7 at start (default 3: clients must resync)
    --latency S       delay per command, emulating the MiniDisc drive (default 0.01)
    --power N         status power byte (0-2 low, 3-4 battery, 5 AC; default 4)
    --allow-writes    accept mkdir/rmdir/delete/create/write; applied to a temporary COPY
                      of DISC_DIR (path printed at start). The original is never touched.
    --no-baud-check   accept frames whatever speed the client set on the pty
    --no-garbage      at a wrong client speed, stay silent instead of sending line noise
    --log FILE        serial trace in md1tool's log format ("> hex" host, "< hex" camera)
    --stats-file FILE JSON counters, rewritten after every frame: commands seen, NAKs,
                      and the dangerous ones (format 02 10, add 02 14, delete-picture 02 15)

Behaviour emulated:
    * framing with 0x7D escapes, checksum check (bad frames ignored), abort frame C0 85 7B C1
    * sequence addresses: out-of-sequence frames get the empty 0x83 NAK and are not executed;
      the expected index survives client sessions and resets to 0 after 01 03 (set speed)
    * link speed: the pty carries no real baud rate, but the client's termios speed is read
      from the pty; if it differs from the camera's speed, frames are dropped (line noise is
      returned), like the real camera at the wrong baud
    * 02 0C reads of more than 2048 bytes get no reply at all
    * 02 10 FORMAT: loud warning, 5 s of silence, then (with --allow-writes) the copy is wiped
      to an empty /PIC_MD and every path returns FF until the fake camera is restarted
    * paths longer than 120 bytes in a path command "hang" the camera until restarted
"""
import argparse
import datetime
import json
import os
import select
import shutil
import signal
import sys
import tempfile
import termios
import time
import tty

BOF, EOF, ESC = 0xC0, 0xC1, 0x7D
SENDADDR = [0x00, 0x22, 0x44, 0x66, 0x88, 0xAA, 0xCC, 0xEE]
RECVADDR = [0x0E, 0x20, 0x42, 0x64, 0x86, 0xA8, 0xCA, 0xEC]
NAK_FRAME = bytes([0xC0, 0x83, 0x7D, 0x5D, 0xC1])
SPEED_CODES = {0: 9600, 1: 19200, 2: 38400, 3: 57600, 4: 115200}

CAMERA_IDS = {  # reply to hello, by host id (confirmed on the real camera)
    b"SONY     MKY-1001         1.00": b"SONY     MKY-2000         1.14",
    b"SONY     DSC-2050         1.00": b"SONY     DSC-RS 05.00     1.14",
}
DEFAULT_CAMERA_ID = b"SONY     MKY-2000         1.14"

# Real 02 01 (volume info) reply from disc 2, md1tool/logs/20261018-170426-raw.log.
VOLINFO_TRACE = ("c0 a8 02 01 00 00 01 00 62" + " 00" * 32 + " 35 4c 95 01 00 21 0f 69 00 04 00 00 44 d0"
                 " 00 00 44 d0 00 00 3d de 00 00 05 f2 00 00 00 00 00 07 00 2a 7d e0 62 51 0c 00 61 eb 5c ac c1")

PATH_COMMANDS = {(0x02, c) for c in (0x02, 0x03, 0x04, 0x05, 0x08, 0x09, 0x0A, 0x0F)}
WRITE_COMMANDS = {(0x02, 0x03), (0x02, 0x04), (0x02, 0x08), (0x02, 0x09), (0x02, 0x0D)}
DANGEROUS = {(0x02, 0x10): "FORMAT", (0x02, 0x14): "ADD PICTURE", (0x02, 0x15): "DELETE PICTURE"}
HANG_PAYLOAD = 120
MAX_READ = 2048

ROOT_REST = bytes.fromhex("354c9501 00210008 00210008 00000002")  # root self entry, real trace


def hexs(b):
    return " ".join(f"{x:02x}" for x in b)


def unescape(body):
    out, i = bytearray(), 0
    while i < len(body):
        x = body[i]
        if x == ESC and i + 1 < len(body):
            i += 1
            x = body[i] ^ 0x20
        out.append(x)
        i += 1
    return bytes(out)


def frame(addr, payload):
    chk = (0x100 - ((addr + sum(payload)) & 0xFF)) & 0xFF
    body = bytearray()
    for x in bytes([addr]) + bytes(payload) + bytes([chk]):
        if x in (BOF, EOF, ESC):
            body += bytes([ESC, x ^ 0x20])
        else:
            body.append(x)
    return bytes([BOF]) + bytes(body) + bytes([EOF])


def warn(msg):
    print(f"\n{'!' * 70}\n!!! {msg}\n{'!' * 70}", file=sys.stderr, flush=True)


class Node:
    def __init__(self, is_dir, attr, rest):
        self.is_dir = is_dir
        self.attr = attr
        self.rest = rest            # 16 bytes: 3 DOS timestamps + entry number
        self.children = []          # names, in camera order (folders only)


class Disc:
    """In-memory directory model over a real folder, using listing.txt for camera metadata."""

    def __init__(self, root, listing=None, writable=False):
        self.root = root
        self.nodes = {"/": Node(True, 0x0201, ROOT_REST)}
        self.next_entry = 3
        meta = {}
        if listing and os.path.exists(listing):
            for line in open(listing):
                parts = line.rstrip("\n").split("\t")
                if len(parts) < 4:
                    continue
                path, kind, attr = parts[0], parts[1], int(parts[2].split("=")[1], 16)
                rest = bytes.fromhex(parts[3].replace(" ", ""))
                meta[path] = (kind == "DIR", attr, rest)
                parent = path.rsplit("/", 1)[0] or "/"
                self._add(path, kind == "DIR", attr, rest, parent)
                self.next_entry = max(self.next_entry, int.from_bytes(rest[12:16], "big") + 1)
        # Anything on disk that listing.txt does not mention (or no listing at all).
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames.sort()
            rel = "/" + os.path.relpath(dirpath, root).replace(os.sep, "/")
            rel = "/" if rel in ("/.", "/") else rel
            for d in dirnames:
                p = rel.rstrip("/") + "/" + d
                if p not in self.nodes:
                    self._add(p, True, 0x0001, self._new_rest(), rel)
            for f in sorted(filenames):
                if f.startswith(".") or f.endswith(".part"):
                    continue
                p = rel.rstrip("/") + "/" + f
                if p not in self.nodes:
                    attr = 0x4080 if f.startswith("PIDX") else 0x0080
                    self._add(p, False, attr, self._new_rest(), rel)

        if writable:  # empty folders are in listing.txt but not in the mirror tree
            for path, n in self.nodes.items():
                if n.is_dir:
                    os.makedirs(self.disk(path), exist_ok=True)

    def _new_rest(self):
        n = self.next_entry
        self.next_entry += 1
        now = datetime.datetime.now()
        dos = (0x0021 << 16) | (now.hour << 11) | (now.minute << 5) | (now.second // 2)  # 1980-01-01, clock unset
        return dos.to_bytes(4, "big") * 3 + n.to_bytes(4, "big")

    def _add(self, path, is_dir, attr, rest, parent):
        if parent not in self.nodes:
            gp = parent.rsplit("/", 1)[0] or "/"
            self._add(parent, True, 0x0001, self._new_rest(), gp)
        self.nodes[path] = Node(is_dir, attr, rest)
        name = path.rsplit("/", 1)[1]
        if name not in self.nodes[parent].children:
            self.nodes[parent].children.append(name)

    def disk(self, path):
        return os.path.join(self.root, path.lstrip("/"))

    def size(self, path):
        n = self.nodes[path]
        return 0x800 if n.is_dir else os.path.getsize(self.disk(path))

    def entry(self, path, self_entry=False):
        n = self.nodes[path]
        if self_entry:
            attr = 0x0201 if path == "/" else 0x0101
            name = b"\x01" + b" " * 10
        else:
            attr = n.attr
            base = path.rsplit("/", 1)[1]
            stem, _, ext = base.partition(".")
            name = stem.encode().ljust(8)[:8] + ext.encode().ljust(3)[:3]
        return attr.to_bytes(2, "big") + b"\x01" + name + n.rest + self.size(path).to_bytes(4, "big")

    def create_file(self, path):
        parent = path.rsplit("/", 1)[0] or "/"
        if parent not in self.nodes or not self.nodes[parent].is_dir:
            return False
        if path in self.nodes and self.nodes[path].is_dir:
            return False
        open(self.disk(path), "wb").close()
        if path not in self.nodes:
            attr = 0x4080 if path.rsplit("/", 1)[1].startswith("PIDX") else 0x0080
            self._add(path, False, attr, self._new_rest(), parent)
        return True

    def mkdir(self, path):
        parent = path.rsplit("/", 1)[0] or "/"
        if path in self.nodes or parent not in self.nodes or not self.nodes[parent].is_dir:
            return False
        os.makedirs(self.disk(path))
        self._add(path, True, 0x0001, self._new_rest(), parent)
        return True

    def remove(self, path, want_dir):
        n = self.nodes.get(path)
        if path == "/" or n is None or n.is_dir != want_dir or (want_dir and n.children):
            return False
        (os.rmdir if want_dir else os.remove)(self.disk(path))
        del self.nodes[path]
        parent, name = (path.rsplit("/", 1)[0] or "/"), path.rsplit("/", 1)[1]
        self.nodes[parent].children.remove(name)
        return True

    def wipe(self):
        for name in os.listdir(self.root):
            p = os.path.join(self.root, name)
            shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
        os.makedirs(os.path.join(self.root, "PIC_MD"))
        self.nodes = {"/": Node(True, 0x0201, ROOT_REST)}
        self._add("/PIC_MD", True, 0x0001, self._new_rest(), "/")


class FakeCamera:
    def __init__(self, a, disc):
        self.a = a
        self.disc = disc
        self.seq = a.start_seq % 8
        self.baud = a.start_baud
        self.hung = False
        self.formatted = False
        self.cursor = None          # pending find-next entries, or None
        self.handles = {}           # handle -> dict(path, pos, write)
        self.last_handle = None
        self.stats = {"frames": 0, "naks": 0, "dropped_wrong_baud": 0, "bad_checksum": 0,
                      "commands": {}, "dangerous": {v: 0 for v in DANGEROUS.values()}}
        self.log = open(a.log, "a") if a.log else None

        self.master, self.slave = os.openpty()
        tty.setraw(self.slave)
        self.path = os.ttyname(self.slave)

    # --- I/O ---

    def trace(self, direction, data):
        if self.log:
            self.log.write(f"{datetime.datetime.now().isoformat(timespec='milliseconds')} {direction} {hexs(data)}\n")
            self.log.flush()

    def write(self, data):
        self.trace("<", data)
        view = memoryview(data)
        while view:
            n = os.write(self.master, view)
            view = view[n:]

    def client_baud(self):
        try:
            attrs = termios.tcgetattr(self.slave)
            return attrs[5]  # ospeed; on macOS the B* constants equal the numeric rate
        except termios.error:
            return None

    def save_stats(self):
        if self.a.stats_file:
            tmp = self.a.stats_file + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.stats, f, indent=1, sort_keys=True)
            os.replace(tmp, self.a.stats_file)

    def run(self):
        print(f"FAKE CAMERA ON {self.path}", flush=True)
        print(f"  serving {self.disc.root}  (camera speed {self.baud}, expected frame index {self.seq},"
              f" writes {'ON (copy)' if self.a.allow_writes else 'OFF'})", flush=True)
        buf = bytearray()
        in_frame = False
        while True:
            r, _, _ = select.select([self.master], [], [], 1.0)
            if not r:
                continue
            try:
                chunk = os.read(self.master, 4096)
            except OSError:
                time.sleep(0.05)
                continue
            for x in chunk:
                if x == BOF:
                    in_frame = True
                    buf = bytearray([x])
                elif in_frame:
                    buf.append(x)
                    if x == EOF:
                        in_frame = False
                        self.on_frame(bytes(buf))
                        buf = bytearray()

    # --- frame level ---

    def on_frame(self, raw):
        self.trace(">", raw)
        self.stats["frames"] += 1
        if self.hung:
            return
        cb = self.client_baud()
        if not self.a.no_baud_check and cb is not None and cb != self.baud:
            self.stats["dropped_wrong_baud"] += 1
            if not self.a.no_garbage:
                self.write(bytes([0x00, 0xF8, 0x80, 0x00, 0xFE][: 2 + len(raw) % 4]))
            self.save_stats()
            return
        dec = unescape(raw[1:-1])
        if len(dec) < 2 or sum(dec) & 0xFF:
            self.stats["bad_checksum"] += 1
            return
        addr, payload = dec[0], dec[1:-1]
        if addr == 0x85 and not payload:   # abort / link reset: no reply
            self.cursor = None
            return
        if addr not in SENDADDR or SENDADDR.index(addr) != self.seq or len(payload) < 2:
            self.stats["naks"] += 1
            self.write(NAK_FRAME)
            self.save_stats()
            return
        idx = self.seq
        self.seq = (self.seq + 1) % 8
        key = (payload[0], payload[1])
        name = f"{key[0]:02x} {key[1]:02x}"
        self.stats["commands"][name] = self.stats["commands"].get(name, 0) + 1
        if key in PATH_COMMANDS and len(payload) > HANG_PAYLOAD:
            warn(f"{len(payload)}-byte path payload: the real firmware hangs here (battery pull). Fake camera now unresponsive.")
            self.hung = True
            self.save_stats()
            return
        time.sleep(self.a.latency)
        reply = self.dispatch(key, payload[2:])
        if reply is not None:
            self.write(frame(RECVADDR[(idx + 1) % 8], bytes(payload[:2]) + reply))
            if key == (0x01, 0x03) and reply[:1] == b"\x00":
                self.baud = SPEED_CODES[payload[2]]
                self.seq = 0
            elif key == (0x01, 0x02):
                self.baud = 9600
        self.save_stats()

    # --- commands ---

    def path_arg(self, p):
        s = bytes(p).split(b"\x00", 1)[0].decode("ascii", "replace")
        if len(s) > 1:
            s = s.rstrip("/")
        return s

    def lookup(self, path):
        if self.formatted:
            return None
        return self.disc.nodes.get(path)

    def dispatch(self, key, p):
        if key in DANGEROUS:
            what = DANGEROUS[key]
            self.stats["dangerous"][what] += 1
            warn(f"CLIENT SENT {what} ({key[0]:02x} {key[1]:02x})")
            if key == (0x02, 0x10):
                self.save_stats()
                time.sleep(5)
                if self.a.allow_writes:
                    self.disc.wipe()
                    warn("format emulated: the COPY now holds an empty /PIC_MD")
                self.formatted = True
                return None
            return b"\x03"

        if key == (0x01, 0x01):
            return b"\x00" + CAMERA_IDS.get(bytes(p[:30]), DEFAULT_CAMERA_ID)
        if key == (0x01, 0x02):
            return b"\x00"
        if key == (0x01, 0x03):
            return (b"\x00" + bytes(p[:1])) if p and p[0] in SPEED_CODES else b"\x03"
        if key == (0x01, 0x04):
            return b"\x00" + (b"\x00" if self.baud == 9600 else b"\xff")
        if key == (0x03, 0x02):
            return b"\x00" + self.status_data()
        if key in ((0x03, 0x01), (0x03, 0x03)):
            return b"\x00"
        if key == (0x02, 0x07):
            return b"\xfe"
        if key == (0x02, 0x01):
            return unescape(bytes.fromhex(VOLINFO_TRACE)[1:-1])[3:-1]

        if key == (0x02, 0x05):
            path = self.path_arg(p)
            n = self.lookup(path)
            self.cursor = None
            if n is None or not n.is_dir:
                return b"\xff"
            if not n.children:
                return b"\xfc"
            self.cursor = [path.rstrip("/") + "/" + c for c in n.children]
            return b"\x00" + self.disc.entry(path, self_entry=True)
        if key == (0x02, 0x06):
            if self.cursor is None:
                return b"\xff"
            if not self.cursor:
                return b"\xfe"
            return b"\x00" + self.disc.entry(self.cursor.pop(0))
        if key == (0x02, 0x0F):
            path = self.path_arg(p)
            if self.lookup(path) is None:
                return b"\xff"
            return b"\x00" + self.disc.entry(path)

        if key == (0x02, 0x0A):
            if len(p) < 2:
                return b"\xff"
            mode = int.from_bytes(p[:2], "big")
            path = self.path_arg(p[2:])
            write = mode != 0x0000
            if write and not self.a.allow_writes:
                print(f"  (refused open mode {mode:04x} {path}: writes disabled)", file=sys.stderr)
                return b"\x03"
            if path == "" and not write:
                return b"\x00" + self.new_handle(None, False)
            if mode == 0x0200:
                if self.formatted or not self.disc.create_file(path):
                    return b"\xff"
            else:
                n = self.lookup(path)
                if n is None or n.is_dir:
                    return b"\xff"
            return b"\x00" + self.new_handle(path, write)
        if key == (0x02, 0x0B):
            h = int.from_bytes(p[:2], "big") if len(p) >= 2 else None
            if h is None:
                return b"\xff"
            self.handles.pop(h, None)
            return b"\x00"
        if key == (0x02, 0x0C):
            if len(p) < 6:
                return b"\xff"
            hd = self.handle(int.from_bytes(p[:2], "big"))
            n = int.from_bytes(p[2:6], "big")
            if n > MAX_READ:
                return None  # the real camera never answers
            if hd is None:
                return b"\xff"
            data = b""
            if hd["path"]:
                with open(self.disc.disk(hd["path"]), "rb") as f:
                    f.seek(hd["pos"])
                    data = f.read(n)
                hd["pos"] += len(data)
            return b"\x00\x00\x00" + len(data).to_bytes(2, "big") + data
        if key == (0x02, 0x0E):
            if len(p) < 8:
                return b"\xff"
            hd = self.handle(int.from_bytes(p[:2], "big"))
            if hd is None or not hd["path"]:
                return b"\xff"
            off, whence = int.from_bytes(p[2:6], "big", signed=True), int.from_bytes(p[6:8], "big")
            base = {0: 0, 1: hd["pos"], 2: os.path.getsize(self.disc.disk(hd["path"]))}.get(whence)
            if base is None or base + off < 0:
                return b"\xff"
            hd["pos"] = base + off
            return b"\x00" + hd["pos"].to_bytes(4, "big")

        if key in WRITE_COMMANDS:
            if not self.a.allow_writes:
                print(f"  (refused write command {key[0]:02x} {key[1]:02x}: writes disabled)", file=sys.stderr)
                return b"\x03"
            if self.formatted and key != (0x02, 0x0D):
                return b"\xff"
            if key == (0x02, 0x03):
                return b"\x00" if self.disc.mkdir(self.path_arg(p)) else b"\xff"
            if key == (0x02, 0x04):
                return b"\x00" if self.disc.remove(self.path_arg(p), True) else b"\xff"
            if key == (0x02, 0x08):
                return b"\x00" if self.disc.remove(self.path_arg(p), False) else b"\xff"
            if key == (0x02, 0x09):
                return b"\x03"  # rename: semantics unknown (basenames after CHDIR); not emulated
            if key == (0x02, 0x0D):
                if len(p) < 6:
                    return b"\xff"
                hd = self.handle(int.from_bytes(p[:2], "big"))
                n = int.from_bytes(p[2:6], "big")
                data = bytes(p[6:6 + n])
                if hd is None or not hd["write"] or not hd["path"] or len(data) != n:
                    return b"\xff"
                with open(self.disc.disk(hd["path"]), "r+b") as f:
                    f.seek(hd["pos"])
                    f.write(data)
                hd["pos"] += n
                return b"\x00" + n.to_bytes(4, "big")
        return b"\x03"

    def new_handle(self, path, write):
        h = 0
        while h in self.handles:
            h += 1
        self.handles[h] = {"path": path, "pos": 0, "write": write}
        self.last_handle = h
        return h.to_bytes(2, "big")

    def handle(self, h):
        if h in self.handles:
            return self.handles[h]
        # The real camera also accepted handle 0 for the open file.
        return self.handles.get(self.last_handle) if self.handles else None

    def status_data(self):
        count = 0
        if not self.formatted:
            albums = sorted(k for k in self.disc.nodes if k.startswith("/PIC_MD/PIC") and k.count("/") == 2)
            for album in reversed(albums):
                inf = self.disc.disk(album + "/PIC_INF.PMF")
                if os.path.exists(inf):
                    data = open(inf, "rb").read()
                    if len(data) >= 0x106:
                        count = int.from_bytes(data[0x104:0x106], "big")
                    break
        now = datetime.datetime.now()

        def bcd(v):
            return ((v // 10) << 4) | (v % 10)
        clock = bytes([0x50, 0x01, 0x01, bcd(now.hour), bcd(now.minute)])  # clock unset: "50-01-01"
        d = bytes([0x01]) + count.to_bytes(2, "big") * 2 + bytes([self.a.power, 0x00]) + clock
        d += bytes.fromhex("07 00 01 00 01 00 ff ff ff ff") + bytes(8)
        assert len(d) == 30
        return d


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("disc", nargs="?", default=os.path.normpath(os.path.join(here, "..", "..", "downloads", "disc2", "disc")))
    ap.add_argument("--start-baud", type=int, default=9600, choices=sorted(SPEED_CODES.values()))
    ap.add_argument("--start-seq", type=int, default=3)
    ap.add_argument("--latency", type=float, default=0.01)
    ap.add_argument("--power", type=int, default=4)
    ap.add_argument("--allow-writes", action="store_true")
    ap.add_argument("--no-baud-check", action="store_true")
    ap.add_argument("--no-garbage", action="store_true")
    ap.add_argument("--log")
    ap.add_argument("--stats-file")
    a = ap.parse_args()

    src = os.path.abspath(a.disc)
    if not os.path.isdir(src):
        ap.error(f"{src} is not a folder")
    listing = os.path.join(os.path.dirname(src), "listing.txt")
    root = src
    if a.allow_writes:
        tmp = tempfile.mkdtemp(prefix="fake-md1-")
        root = os.path.join(tmp, "disc")
        shutil.copytree(src, root)
        print(f"  writes go to the copy {root}", flush=True)
    cam = FakeCamera(a, Disc(root, listing, writable=a.allow_writes))
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt))
    try:
        cam.run()
    except KeyboardInterrupt:
        pass
    finally:
        cam.save_stats()
        d = cam.stats["dangerous"]
        print(f"\nfake camera stopped: {cam.stats['frames']} frames, {cam.stats['naks']} NAKs, dangerous: {d}",
              file=sys.stderr)


if __name__ == "__main__":
    main()
