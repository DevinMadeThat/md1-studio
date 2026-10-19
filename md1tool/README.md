# md1tool: Python research tools

The command-line tools used to reverse-engineer the DSC-MD1 against a real camera. The desktop
app (`../app`) reimplements the read side of `md1.py` in Rust, and its tests replay a session
these tools recorded.

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

| Script | Purpose | Writes to the disc? |
|---|---|---|
| `md1.py` | `probe`, `ls`, `get`, `pull`, `mirror` (copy every file + convert JPEG/WAV/thumbnails), `raw` (send allowlisted commands) | No. Allowlist of read commands only |
| `restore.py` | Write a mirror back onto a disc, verifying every file | **Yes** (needs `--yes-write-to-the-disc`) |
| `add_photo.py` | Append a camera-format photo + thumbnail to an album | **Yes** |
| `photo_info.py` | Per-photo metadata (quality, shutter, flash, sound, time) as CSV | No (works on a mirror) |
| `trace.py` | Decode a serial trace into readable commands | No |
| `sweep.py` | Probe unknown command codes. **Dangerous**: this is how a disc got formatted. Gated behind `--i-understand-this-can-erase-the-disc` | Possibly |

The port defaults to the first USB-serial adapter found (`--port` to override). The camera may
be at 9600 or 115200 baud. `probe` tries both, and `--baud 9600 --speed 115200` switches up.
Every run writes a serial trace to `logs/`. Traces contain your photos, so that folder is
git-ignored; scrub a trace with `../app/tools/sanitize_trace.py` before sharing it.

Background, protocol and formats: [`../docs/`](../docs/README.md).
