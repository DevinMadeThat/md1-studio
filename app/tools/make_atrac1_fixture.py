#!/usr/bin/env python3
"""Generate the synthetic ATRAC1 test fixture for crates/atrac1 (no real recordings needed).

Writes N valid mono ATRAC1 sound units with random block-size modes, bit allocations, scale
factors and mantissas (seeded, so reproducible), then decodes them with FFmpeg's atrac1
decoder through PyAV to produce the reference output the Rust port is compared against.

Usage (needs `pip install av numpy`):
    make_atrac1_fixture.py OUT_DIR [--units 64] [--seed 1]
Outputs OUT_DIR/synthetic_units.atrac1 and OUT_DIR/synthetic_units_ffmpeg.f32 (little-endian).
"""
import argparse
import os
import random
import tempfile

SU_SIZE = 212
BFU_AMOUNT_TAB1 = [20, 28, 32, 36, 40, 44, 48, 52]
SPECS_PER_BFU = [8, 8, 8, 8, 4, 4, 4, 4, 8, 8, 8, 8, 6, 6, 6, 6, 6, 6, 6, 6,
                 6, 6, 6, 6, 7, 7, 7, 7, 9, 9, 9, 9, 10, 10, 10, 10,
                 12, 12, 12, 12, 12, 12, 12, 12, 20, 20, 20, 20, 20, 20, 20, 20]
MAX_BITS = SU_SIZE * 8


class Bits:
    def __init__(self):
        self.bits = []

    def put(self, value, n):
        self.bits += [(value >> (n - 1 - i)) & 1 for i in range(n)]

    def bytes(self):
        b = self.bits + [0] * (MAX_BITS - len(self.bits))
        return bytes(int("".join(map(str, b[i:i + 8])), 2) for i in range(0, MAX_BITS, 8))


def unit(rng):
    w = Bits()
    w.put(rng.choice([0, 2]), 2)  # low band: 2 = long block, 0 = 4 short blocks
    w.put(rng.choice([0, 2]), 2)  # mid band
    w.put(rng.choice([0, 3]), 2)  # high band: 3 = long, 0 = 8 short
    w.put(0, 2)
    amount = rng.randrange(8)
    n = BFU_AMOUNT_TAB1[amount]
    w.put(amount, 3)
    w.put(0, 2)
    w.put(0, 3)
    budget = MAX_BITS - (n * 10 + 32)
    idwl = []
    for b in range(n):
        x = rng.choice([0, 1, 1, 2, 2, 3, 4, 5])
        while x and (x + 1) * SPECS_PER_BFU[b] > budget:
            x -= 1
        budget -= (x + 1) * SPECS_PER_BFU[b] if x else 0
        idwl.append(x)
    idsf = [rng.randrange(20, 46) for _ in range(n)]
    for x in idwl:
        w.put(x, 4)
    for x in idsf:
        w.put(x, 6)
    for b in range(n):
        if idwl[b]:
            wl = idwl[b] + 1
            lim = (1 << (wl - 1)) - 1
            for _ in range(SPECS_PER_BFU[b]):
                w.put(rng.randint(-lim, lim) & ((1 << wl) - 1), wl)
    data = bytearray(w.bytes())
    data[-1], data[-2] = data[0], data[1]  # mirrored mode bytes, as on real discs
    return bytes(data)


def ffmpeg_decode(units):
    import av
    import numpy as np

    hdr = bytearray(2048)
    hdr[0:4] = (0x800).to_bytes(4, "little")
    hdr[264] = 1
    with tempfile.NamedTemporaryFile(suffix=".aea", delete=False) as t:
        t.write(bytes(hdr) + units)
    try:
        with av.open(t.name, format="aea") as c:
            return np.concatenate([f.to_ndarray().reshape(-1) for f in c.decode(audio=0)]).astype("<f4")
    finally:
        os.unlink(t.name)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out_dir")
    ap.add_argument("--units", type=int, default=64)
    ap.add_argument("--seed", type=int, default=1)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    units = b"".join(unit(rng) for _ in range(a.units))
    ref = ffmpeg_decode(units)
    assert len(ref) == a.units * 512, len(ref)
    open(os.path.join(a.out_dir, "synthetic_units.atrac1"), "wb").write(units)
    open(os.path.join(a.out_dir, "synthetic_units_ffmpeg.f32"), "wb").write(ref.tobytes())
    print(f"{a.units} units, peak {abs(ref).max():.3f}")


if __name__ == "__main__":
    main()
