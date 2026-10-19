#!/usr/bin/env python3
"""Probe which command codes the DSC-MD1 firmware answers to.

For every (cmd0, cmd1) in the requested ranges that is not on the denylist, send the bare
two command bytes, record the reply status, and confirm the camera is still alive with a
status query. Stops at the first hang so it can be investigated (battery pull needed).

DANGER: on 2026-10-18 the bare command 02 10 FORMATTED the disc (quick format, ~50 s).
Run only with the disc fully mirrored and write-protected; unknown commands may do unknown things.
Results are appended to md1tool/logs/sweep-results.tsv.
"""
import argparse
import datetime
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import md1  # noqa: E402

# Known or suspected to modify the disc / link, never swept.
DENY = {
    (0x01, 0x02),  # link reset
    (0x01, 0x03),  # set speed (would desync the sweep)
    (0x02, 0x02), (0x02, 0x03), (0x02, 0x04), (0x02, 0x08),  # single-path file ops (mkdir/rmdir/chdir/delete?)
    (0x02, 0x09),  # rename
    (0x02, 0x0D),  # write to handle
    (0x02, 0x14),  # upload
    (0x02, 0x15),  # delete picture
    (0x02, 0x10),  # FORMAT — erased disc 2 on 2026-10-18 (bare command, no arguments, ~50 s busy)
}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", default=md1.DEFAULT_PORT)
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--id", default="f1", choices=sorted(md1.HOST_IDS))
    ap.add_argument("--groups", default="01,03,02,04,05,06,07", help="cmd0 values (hex), in order")
    ap.add_argument("--max", type=lambda s: int(s, 16), default=0x40, help="cmd1 upper bound (hex, exclusive)")
    ap.add_argument("--timeout", type=float, default=3.0)
    ap.add_argument("--i-understand-this-can-erase-the-disc", dest="ok", action="store_true",
                    help="required: unknown commands can be destructive (02 10 formatted a disc)")
    a = ap.parse_args()
    if not a.ok:
        ap.error("refusing to sweep without --i-understand-this-can-erase-the-disc (and a full mirror)")

    logdir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logs")
    log = open(os.path.join(logdir, datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + "-sweep.log"), "w")
    out = open(os.path.join(logdir, "sweep-results.tsv"), "a")
    args = argparse.Namespace(port=a.port, baud=a.baud, id=a.id, verbose=False, speed=None)
    cam = md1.connect(args, log)
    if not cam:
        return 1
    cam.status()
    # Allow everything for this session except the denylist.
    md1.ALLOWED_COMMANDS.clear()
    for c0 in range(0x100):
        for c1 in range(0x100):
            if (c0, c1) not in DENY:
                md1.ALLOWED_COMMANDS[(c0, c1)] = "sweep"

    for g in a.groups.split(","):
        c0 = int(g, 16)
        for c1 in range(a.max):
            if (c0, c1) in DENY:
                continue
            payload = bytes([c0, c1])
            try:
                reply = cam.transact(payload, timeout=a.timeout)
                status = f"{reply[2]:02x}" if len(reply) > 2 else "--"
                result = f"{status}\t{len(reply)}\t{reply[:48].hex(' ')}"
            except md1.ProtocolError as e:
                result = f"ERR\t0\t{e}"
                cam.abort()
            # Is the camera still with us?
            try:
                cam.status()
                alive = "alive"
            except md1.ProtocolError:
                time.sleep(1)
                try:
                    cam.status()
                    alive = "alive(late)"
                except md1.ProtocolError:
                    alive = "DEAD"
            line = f"{c0:02x} {c1:02x}\t{result}\t{alive}"
            print(line, flush=True)
            out.write(line + "\n")
            out.flush()
            if alive == "DEAD":
                print("Camera stopped responding — stopping sweep.")
                return 2
    cam.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
