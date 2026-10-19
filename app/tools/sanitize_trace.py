#!/usr/bin/env python3
"""Remove photo, thumbnail and sound content from a DSC-MD1 serial trace so it can be shared.

Serial traces (md1tool/logs/*.log, MD1 Studio's serial-*.log) contain every byte read from the
disc, i.e. your pictures and recorded sound. This rewrites the replies to file reads (02 0C):
for photo (PSN*.PMP), sound (NRA*.PMA) and thumbnail (*.PMX) files everything after the first
0x103 bytes (the 256-byte header + JPEG start marker) becomes zeros. File sizes, the protocol
exchange, directory listings and index files are kept, so the trace still replays exactly.
Frames are re-encoded with correct escaping and checksums.

Usage: sanitize_trace.py IN.log OUT.log
"""
import sys

KEEP = 0x103
SECRET_PREFIXES = ("PSN", "NRA", "PIDX", "OV_IDX")


def unescape(raw):
    out, i = bytearray(), 0
    while i < len(raw):
        b = raw[i]
        if b == 0x7D and i + 1 < len(raw):
            i += 1
            b = raw[i] ^ 0x20
        out.append(b)
        i += 1
    return bytes(out)


def encode(addr, payload):
    chk = (0x100 - ((addr + sum(payload)) & 0xFF)) & 0xFF
    body = bytearray()
    for b in bytes(payload) + bytes([chk]):
        body += bytes([0x7D, b ^ 0x20]) if b in (0xC0, 0xC1, 0x7D) else bytes([b])
    return bytes([0xC0, addr]) + bytes(body) + bytes([0xC1])


def main(src, dst):
    current, offset = None, 0
    out = []
    for line in open(src):
        parts = line.rstrip("\n").split(" ", 2)
        if len(parts) < 3 or parts[1] not in (">", "<"):
            out.append(line)
            continue
        ts, direction, hexs = parts
        raw = bytes.fromhex(hexs.replace(" ", ""))
        if not (raw[:1] == b"\xC0" and raw.endswith(b"\xC1")):
            out.append(line)
            continue
        dec = unescape(raw[1:-1])
        addr, payload = dec[0], dec[1:-1]
        if direction == ">" and payload[:2] == b"\x02\x0A":
            current = payload[4:].split(b"\0")[0].decode("ascii", "replace")
            offset = 0
        elif direction == "<" and payload[:3] == b"\x02\x0C\x00" and len(payload) >= 7:
            n = int.from_bytes(payload[5:7], "big")
            data = bytearray(payload[7:7 + n])
            name = (current or "").rsplit("/", 1)[-1]
            if name.startswith(SECRET_PREFIXES):
                for i in range(len(data)):
                    if offset + i >= KEEP:
                        data[i] = 0
            offset += n
            payload = payload[:7] + bytes(data) + payload[7 + n:]
            raw = encode(addr, payload)
        out.append(f"{ts} {direction} {' '.join(f'{b:02x}' for b in raw)}\n")
    open(dst, "w").writelines(out)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
