#!/usr/bin/env python3
"""Per-photo metadata from DSC-MD1 PMP headers (+ sound flag and DOS time from a mirror listing).

PMP header = TLV records: [tag8][len8][len bytes]. Tags (reverse-engineering-notes.md §4.2):
  0x10 file header, 0x20 image (dims, quality), 0x21 dates, 0x24 exposure/flash, 0x11/0x12 text.
Usage: photo_info.py DISCDIR [DISCDIR ...]   (DISCDIR = downloads/<disc>, containing disc/ or raw/)
"""
import csv
import glob
import os
import sys

SHUTTER_BUCKETS = [(3.32, "1/7.5"), (4.32, "1/15"), (5.32, "1/30"), (6.23, "1/60"),
                   (7.16, "1/100"), (8.55, "1/250"), (9.55, "1/500")]


def tlv(header):
    out, i = {}, 0
    while i + 2 <= len(header):
        tag, n = header[i], header[i + 1]
        if tag in (0x00, 0xFF) or n == 0:
            break
        out.setdefault(tag, header[i:i + 2 + n])
        i += 2 + n
    return out


def shutter(tv100):
    if tv100 in (0x8000, 0xFFFF):
        return "n/a"
    tv = tv100 / 100
    for limit, label in SHUTTER_BUCKETS:
        if tv < limit:
            return label
    return "1/1000"


def dos_time(v):
    d, t = v >> 16, v & 0xFFFF
    return f"{(d >> 9) + 1980:04d}-{(d >> 5) & 15:02d}-{d & 31:02d} {t >> 11:02d}:{(t >> 5) & 63:02d}:{(t & 31) * 2:02d}"


def main():
    rows = []
    for disc in sys.argv[1:]:
        times = {}
        listing = os.path.join(disc, "listing.txt")
        if os.path.exists(listing):
            for line in open(listing):
                parts = line.rstrip("\n").split("\t")
                rest = bytes.fromhex(parts[3].replace(" ", "")) if len(parts) > 3 else b""
                if len(rest) >= 4:
                    times[os.path.basename(parts[0])] = dos_time(int.from_bytes(rest[0:4], "big"))
        pics = sorted(glob.glob(os.path.join(disc, "disc", "PIC_MD", "PIC*", "PSN*.PMP")) or
                      glob.glob(os.path.join(disc, "raw", "PIC*", "PSN*.PMP")))
        for p in pics:
            h = open(p, "rb").read(0x100)
            t = tlv(h)
            img, exp = t.get(0x20, b""), t.get(0x24, b"")
            q = img[9] if len(img) > 9 else None
            sound = os.path.exists(p.replace("PSN", "NRA").replace(".PMP", ".PMA"))
            rows.append({
                "disc": os.path.basename(disc.rstrip("/")),
                "album": os.path.basename(os.path.dirname(p)),
                "file": os.path.basename(p),
                "quality": {0x17: "STD", 0x33: "FINE"}.get(q, f"0x{q:02x}" if q is not None else "?"),
                "width_height": f"{int.from_bytes(img[2:4], 'big')}x{int.from_bytes(img[4:6], 'big')}" if len(img) > 5 else "?",
                "shutter_tv100": int.from_bytes(exp[2:4], "big") if len(exp) > 3 else "",
                "shutter": shutter(int.from_bytes(exp[2:4], "big")) if len(exp) > 3 else "?",
                "flash": ("on" if exp[0x12] else "off") if len(exp) > 0x12 else "?",
                "sound": "yes" if sound else "",
                "created": times.get(os.path.basename(p), ""),
                "jpeg_bytes": int.from_bytes(h[0x0C:0x10], "big"),
            })
    w = csv.DictWriter(sys.stdout, fieldnames=list(rows[0].keys()) if rows else ["file"])
    w.writeheader()
    w.writerows(rows)


if __name__ == "__main__":
    main()
