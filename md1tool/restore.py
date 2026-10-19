#!/usr/bin/env python3
"""Write a mirrored disc (from `md1.py mirror`) back onto a DSC-MD1 disc, byte for byte.

Uses the write path Sony's ALBUM.EXE uses for index edits (docs/reverse-engineering-notes.md §1):
  02 03 MKDIR, 02 0F stat, 02 08 DELETE FILE (only to replace a file we are about to rewrite),
  02 0A OPEN mode 0x0200 (create), 02 0D WRITE (≤1024-byte chunks), 02 0B CLOSE.
Order follows Sony's: payload files first, then PIC_INF.PMF, then OV_IDX.PMX / OV_INF.PMF.
Every written file is read back and compared with the mirror.

Files/folders on the camera that are NOT in the mirror are only removed when listed with --remove.
"""
import argparse
import datetime
import hashlib
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import md1  # noqa: E402

WRITE_CMDS = {
    (0x02, 0x03): "mkdir", (0x02, 0x04): "rmdir", (0x02, 0x08): "delete file",
    (0x02, 0x0D): "write", (0x01, 0x02): "disconnect",
}
CHUNK = 1024  # Sony's software always writes 1 KB; --chunk can try larger


class Writer:
    def __init__(self, cam):
        self.cam = cam

    def ok(self, payload, what, timeout=15.0):
        r = self.cam.transact(payload, timeout=timeout)
        if r[2] != 0:
            raise md1.ProtocolError(f"{what} failed: status {r[2]:02x} ({md1.hexs(r[:12])})")
        return r

    def exists(self, path):
        return self.cam.finfo(path)[0] is not None

    def mkdir(self, path):
        if self.exists(path):
            return False
        self.ok(b"\x02\x03" + path.encode() + b"\0", f"mkdir {path}")
        return True

    def rmdir(self, path):
        self.ok(b"\x02\x04" + path.encode() + b"\0", f"rmdir {path}")

    def delete(self, path):
        self.ok(b"\x02\x08" + path.encode() + b"\0", f"delete {path}")

    def write_file(self, path, data):
        if self.exists(path):
            self.delete(path)
        r = self.ok(b"\x02\x0A\x02\x00" + path.encode() + b"\0", f"create {path}")
        h = int.from_bytes(r[3:5], "big")
        try:
            t0 = time.monotonic()
            for off in range(0, len(data), CHUNK):
                chunk = data[off:off + CHUNK]  # CHUNK may be changed by --chunk
                r = self.ok(b"\x02\x0D" + h.to_bytes(2, "big") + len(chunk).to_bytes(4, "big") + chunk,
                            f"write {path}@{off}", timeout=20.0)
                n = int.from_bytes(r[3:7], "big")
                if n != len(chunk):
                    raise md1.ProtocolError(f"write {path}@{off}: camera wrote {n} of {len(chunk)}")
                rate = (off + len(chunk)) / max(0.001, time.monotonic() - t0)
                print(f"\r  wrote {off + len(chunk)}/{len(data)} ({rate:.0f} B/s)   ", end="", flush=True)
        finally:
            self.cam.fclose(h)
        print()


def plan(mirror):
    """(dirs, files) from the mirror tree, files ordered payload → album index → disc index."""
    dirs, files = [], []
    for root, dnames, fnames in os.walk(mirror):
        rel = "/" + os.path.relpath(root, mirror).replace(os.sep, "/").lstrip("./")
        rel = "/" if rel == "/" else rel.rstrip("/")
        for d in sorted(dnames):
            dirs.append((rel.rstrip("/") + "/" + d))
        for f in sorted(fnames):
            files.append((rel.rstrip("/") + "/" + f, os.path.join(root, f)))

    listing = os.path.join(os.path.dirname(os.path.abspath(mirror)), "listing.txt")
    if os.path.exists(listing):  # empty folders are not in the mirror tree
        for line in open(listing):
            path, kind = line.split("\t")[:2]
            if kind == "DIR" and path not in dirs:
                dirs.append(path)

    def rank(item):
        name = os.path.basename(item[0])
        if item[0].startswith("/PDF_MD"):
            return (3, item[0])
        if name == "PIC_INF.PMF":
            return (1, item[0])
        if name in ("OV_IDX.PMX", "OV_INF.PMF"):
            return (2, item[0])
        return (0, item[0])
    dirs.sort(key=lambda d: (d.count("/"), d.startswith("/PDF_MD"), d))
    files.sort(key=rank)
    return dirs, files


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mirror", help="e.g. downloads/disc2/disc")
    ap.add_argument("--port", default=md1.DEFAULT_PORT)
    ap.add_argument("--baud", type=int, default=9600)
    ap.add_argument("--speed", type=int, default=115200, help="switch the link to this speed after connecting")
    ap.add_argument("--id", default="f1", choices=sorted(md1.HOST_IDS))
    ap.add_argument("--remove", action="append", default=[],
                    help="camera file or folder (not in the mirror) to delete first; repeatable")
    ap.add_argument("--only", help="restore only paths starting with this prefix")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--chunk", type=int, default=1024, help="write chunk size (Sony uses 1024)")
    ap.add_argument("--yes-write-to-the-disc", dest="ok", action="store_true")
    a = ap.parse_args()

    dirs, files = plan(a.mirror)
    if a.only:
        dirs = [d for d in dirs if d.startswith(a.only) or a.only.startswith(d)]
        files = [f for f in files if f[0].startswith(a.only)]
    print(f"Plan: {len(dirs)} folders, {len(files)} files, {sum(os.path.getsize(p) for _, p in files):,} bytes")
    for d in dirs:
        print(f"  mkdir {d}")
    for p, _ in files:
        print(f"  write {p}")
    if a.dry_run:
        return 0
    if not a.ok:
        ap.error("add --yes-write-to-the-disc to actually write")

    logdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
    log = open(os.path.join(logdir, datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-restore.log"), "w")
    md1.ALLOWED_COMMANDS.update(WRITE_CMDS)
    global CHUNK
    CHUNK = a.chunk
    md1.MAX_PAYLOAD = 2 + 2 + 4 + CHUNK  # write frames carry data; paths are still checked below
    cam = md1.connect(argparse.Namespace(port=a.port, baud=a.baud, id=a.id, verbose=False, speed=a.speed), log)
    if not cam:
        return 1
    st = cam.status()
    if st["raw"][8] < 3:
        print("Battery too low for writing (status power byte < 3). Use the AC adapter.")
        return 1
    w = Writer(cam)
    for p in [*dirs, *(f for f, _ in files), *a.remove]:
        assert len(p) < 64, p

    for target in a.remove:  # e.g. the album created after the accidental format
        if target.endswith("/"):
            continue
        e, _ = cam.find_first(target)
        if e and e["is_dir"]:
            entries, _ = cam.list_dir(target)
            for en in entries:
                if en["name"] and not en["is_dir"]:
                    print(f"delete {target}/{en['name']}")
                    w.delete(f"{target}/{en['name']}")
            print(f"rmdir {target}")
            w.rmdir(target)
        elif w.exists(target):
            print(f"delete {target}")
            w.delete(target)

    for d in dirs:
        print(("mkdir " if w.mkdir(d) else "exists ") + d)
    failures = []
    for p, src in files:
        data = open(src, "rb").read()
        print(f"write {p} ({len(data):,} bytes)")
        try:
            size, _ = cam.finfo(p)
            if size == len(data) and hashlib.sha256(cam.read_file(p, progress=False)).digest() == \
                    hashlib.sha256(data).digest():
                print("  already on the disc, identical — skipped")
                continue
            w.write_file(p, data)
            back = cam.read_file(p, progress=False)
            same = hashlib.sha256(back).digest() == hashlib.sha256(data).digest()
            print("  verify: " + ("OK, identical" if same else f"MISMATCH ({len(back)} bytes read back)"))
            if not same:
                failures.append(p)
        except md1.ProtocolError as e:
            print(f"  ERROR: {e}")
            failures.append(p)
            cam.abort()
    try:
        cam.transact(b"\x01\x02", timeout=3)  # disconnect, as Sony's software does
    except md1.ProtocolError:
        pass
    cam.close()
    print("\nDone. " + ("All files written and verified." if not failures else f"Problems: {failures}"))
    print("Power-cycle the camera so it re-reads the disc.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
