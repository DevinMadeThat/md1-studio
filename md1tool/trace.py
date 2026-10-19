#!/usr/bin/env python3
"""Decode an md1.py serial trace log into readable frames.

Usage: trace.py LOGFILE [--head N] [--tail N]
Each line: time, direction, sequence address, payload (unescaped, checksum stripped), ASCII.
"""
import argparse

NAMES = {
    (0x01, 0x01): "hello", (0x01, 0x02): "reset", (0x01, 0x03): "set-speed", (0x01, 0x04): "get-speed",
    (0x03, 0x02): "status", (0x02, 0x01): "volume-info", (0x02, 0x05): "find-first", (0x02, 0x06): "find-next",
    (0x02, 0x0A): "open", (0x02, 0x0B): "close", (0x02, 0x0C): "read", (0x02, 0x0E): "seek",
    (0x02, 0x0F): "file-info", (0x02, 0x17): "block?", (0x02, 0x18): "object?",
}


def decode(raw):
    if len(raw) < 4 or raw[0] != 0xC0:
        return None, raw
    body = raw[1:raw.index(0xC1)] if 0xC1 in raw else raw[1:]
    out, i = bytearray(), 0
    while i < len(body):
        x = body[i]
        if x == 0x7D and i + 1 < len(body):
            i += 1
            x = body[i] ^ 0x20
        out.append(x)
        i += 1
    return out[0], bytes(out[1:-1])  # address, payload (checksum dropped)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("log")
    ap.add_argument("--head", type=int)
    ap.add_argument("--tail", type=int)
    a = ap.parse_args()
    lines = open(a.log).read().splitlines()
    if a.head is not None or a.tail is not None:
        lines = lines[:a.head or 0] + (["..."] if a.head and a.tail else []) + (lines[-a.tail:] if a.tail else [])
    for ln in lines:
        if ln == "...":
            print(ln)
            continue
        ts, direction, *hx = ln.split()
        try:
            raw = bytes(int(h, 16) for h in hx)
        except ValueError:
            print(ln)
            continue
        addr, p = decode(raw)
        if addr is None:
            print(f"{ts[11:23]} {direction:2} (raw) {raw[:24].hex(' ')}")
            continue
        name = NAMES.get(tuple(p[:2]), "") if len(p) >= 2 else ("NAK" if addr == 0x83 else "abort" if addr == 0x85 else "")
        txt = "".join(chr(c) if 32 <= c < 127 else "." for c in p[:48])
        print(f"{ts[11:23]} {direction:2} {addr:02x} {name:11} [{len(p):4}] {p[:16].hex(' ')} | {txt}")


if __name__ == "__main__":
    main()
