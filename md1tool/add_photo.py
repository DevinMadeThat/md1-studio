#!/usr/bin/env python3
"""Add a photo to a DSC-MD1 album by writing the files the camera itself would write.

The MD1 rejects Sony's "add picture" command (02 14 → status 03), so this does it by hand:
  1. PSNnnnnn.PMP  — a camera-format photo file (256-byte TLV header + JPEG); e.g. one from a mirror
  2. PIDXnnn.PMX   — append a 4096-byte thumbnail block (0x100 header + 80x60 JPEG padded to 80x64)
  3. PIC_INF.PMF   — append a 16-byte picture record, bump the three picture counts and body length
  4. OV_INF.PMF    — bump the album's picture count (two copies)
Writes go through restore.Writer (delete + create + 2 KB writes + read-back check).

Usage: add_photo.py SOURCE.PMP [--album PIC00001]
"""
import argparse
import datetime
import io
import os
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import md1  # noqa: E402
import restore  # noqa: E402


def thumbnail_block(pmp, template_header):
    jpg = md1.extract_jpeg(pmp)
    im = Image.open(io.BytesIO(jpg)).convert("RGB").resize((80, 60), Image.LANCZOS)
    canvas = Image.new("RGB", (80, 64), (0, 0, 0))
    canvas.paste(im, (0, 0))
    buf = io.BytesIO()
    canvas.save(buf, "JPEG", quality=80, subsampling=2)
    t = buf.getvalue()
    hdr = bytearray(template_header)
    hdr[0x0C:0x10] = len(t).to_bytes(4, "big")
    block = bytes(hdr) + t
    assert len(block) <= 4096, len(block)
    return block + bytes(4096 - len(block))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="camera-format .PMP file")
    ap.add_argument("--album", default="PIC00001")
    ap.add_argument("--port", default=md1.DEFAULT_PORT)
    ap.add_argument("--baud", type=int, default=115200)
    a = ap.parse_args()

    pmp = open(a.source, "rb").read()
    assert pmp[:4] == b"\x10\x12\x01\x00" and pmp[0x100:0x102] == b"\xff\xd8", "not a camera PMP file"

    log = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs",
                            datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-addphoto.log"), "w")
    md1.ALLOWED_COMMANDS.update(restore.WRITE_CMDS)
    md1.MAX_PAYLOAD = 2 + 2 + 4 + 2048
    restore.CHUNK = 2048
    cam = md1.connect(argparse.Namespace(port=a.port, baud=a.baud, id="f1", verbose=False, speed=None), log)
    if not cam:
        return 1
    cam.status()
    w = restore.Writer(cam)
    base = f"/PIC_MD/{a.album}"

    pic_inf = bytearray(cam.read_file(f"{base}/PIC_INF.PMF", progress=False))
    pidx = cam.read_file(f"{base}/PIDX000.PMX", progress=False)
    ov_inf = bytearray(cam.read_file("/PIC_MD/OV_INF.PMF", progress=False))

    count = int.from_bytes(pic_inf[0x104:0x106], "big")
    last = pic_inf[-16:]
    album_no = int.from_bytes(last[0:2], "big")
    psn = int.from_bytes(last[2:4], "big") + 1
    name = f"PSN{psn:05d}.PMP"
    print(f"Album {a.album}: {count} pictures; adding {name}")
    assert len(pidx) == 4096 * count, "thumbnail file does not have one block per picture"

    record = bytearray(last)
    record[2:4] = psn.to_bytes(2, "big")
    record[7] = 0  # no sound
    new_pic_inf = pic_inf + record
    for off in (0x104, 0x106, 0x10E):
        new_pic_inf[off:off + 2] = (count + 1).to_bytes(2, "big")
    new_pic_inf[0x0C:0x10] = (len(new_pic_inf) - 0x100).to_bytes(4, "big")

    for off in (0x100, 0x124):
        assert int.from_bytes(ov_inf[off:off + 2], "big") == count, f"OV_INF count at {off:#x} unexpected"
        ov_inf[off:off + 2] = (count + 1).to_bytes(2, "big")

    new_pidx = pidx + thumbnail_block(pmp, pidx[:0x100])

    for path, data in [(f"{base}/{name}", pmp), (f"{base}/PIDX000.PMX", new_pidx),
                       (f"{base}/PIC_INF.PMF", bytes(new_pic_inf)), ("/PIC_MD/OV_INF.PMF", bytes(ov_inf))]:
        print(f"write {path} ({len(data):,} bytes)")
        w.write_file(path, data)
        ok = cam.read_file(path, progress=False) == data
        print("  verify: " + ("OK" if ok else "MISMATCH"))
    cam.close()
    print("Done. Power-cycle the camera, then look for the new photo at the end of the album.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
