#!/usr/bin/env python3
"""Record a terminal demo shell script to an animated GIF.

Pipeline: asciinema records the script to a .cast file, then agg converts the
.cast to a GIF. This is tool-agnostic — it records whatever your demo script
runs. Write that script first (see ../references/demo-script-template.sh).

Usage:
    python3 record.py --script /tmp/my-demo.sh
    python3 record.py --script /tmp/my-demo.sh --out /tmp/my-demo.gif --idle-time-limit 3

All working files default to /tmp — nothing is written into the repo. The
final GIF path is printed to stdout (progress goes to stderr) so it can be
piped:
    python3 record.py --script /tmp/my-demo.sh | xargs -I{} python3 upload.py catbox {}

Pacing note: --idle-time-limit is a CAP on every pause in the recording. Set
it to the longest freeze you want to keep (default 3s) so a `sleep 3` after an
important result is preserved while accidental long idles are still clipped.
See ../references/pacing-and-framing.md.

Dependencies (run check_deps.py): asciinema, agg. Optional: gifsicle (--optimize).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULTS = {
    "cols": 200,
    "rows": 50,
    "font_size": 14,
    "idle_time_limit": 3,
    "last_frame_duration": 6,
}


def _die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def _check_deps() -> None:
    missing = [t for t in ("asciinema", "agg") if not shutil.which(t)]
    if not missing:
        return
    hints = {
        "asciinema": "pip install asciinema --break-system-packages",
        "agg": "https://github.com/asciinema/agg/releases",
    }
    lines = ["missing required tool(s):"]
    lines += [f"  {t} — {hints[t]}" for t in missing]
    _die("\n".join(lines))


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Record a demo shell script to a GIF (asciinema -> agg).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--script", required=True, type=Path, help="demo shell script to record")
    p.add_argument("--out", type=Path, help="output GIF path (default: /tmp/<script-stem>.gif)")
    p.add_argument("--cast", type=Path, help="intermediate .cast path (default: beside --out)")
    p.add_argument("--cols", type=int, default=DEFAULTS["cols"], help="terminal width in columns (drives GIF pixel width)")
    p.add_argument("--rows", type=int, default=DEFAULTS["rows"], help="terminal height in rows (drives GIF pixel height)")
    p.add_argument("--font-size", type=int, default=DEFAULTS["font_size"], help="font size in px (scales overall GIF resolution)")
    p.add_argument("--line-height", type=float, default=None, help="line height multiplier (default agg: 1.4); raises GIF pixel height")
    p.add_argument(
        "--idle-time-limit",
        type=float,
        default=DEFAULTS["idle_time_limit"],
        help="cap (seconds) on every pause; set to your longest intended freeze",
    )
    p.add_argument(
        "--last-frame-duration",
        type=float,
        default=DEFAULTS["last_frame_duration"],
        help="hold the final frame this many seconds",
    )
    p.add_argument("--theme", help="agg theme name (e.g. dracula, monokai); optional")
    p.add_argument(
        "--optimize",
        action="store_true",
        help="shrink the GIF with gifsicle -O3 if gifsicle is installed",
    )
    return p.parse_args()


def _optimize(gif: Path) -> None:
    if not shutil.which("gifsicle"):
        print("note: gifsicle not found — skipping --optimize", file=sys.stderr)
        return
    print("optimizing with gifsicle …", file=sys.stderr)
    subprocess.run(["gifsicle", "-O3", "--batch", str(gif)], check=True)


def record(args: argparse.Namespace) -> Path:
    script: Path = args.script
    if not script.exists():
        _die(f"demo script not found: {script}")

    gif = args.out or Path("/tmp") / f"{script.stem}.gif"
    cast = args.cast or gif.with_suffix(".cast")
    gif.parent.mkdir(parents=True, exist_ok=True)
    cast.parent.mkdir(parents=True, exist_ok=True)

    print(f"recording {script} → {cast} …", file=sys.stderr)
    subprocess.run(
        [
            "asciinema", "rec", "--overwrite",
            "--cols", str(args.cols),
            "--rows", str(args.rows),
            "-c", f"bash {script}",
            str(cast),
        ],
        check=True,
    )

    print(f"converting → {gif} …", file=sys.stderr)
    agg_cmd = [
        "agg",
        "--font-size", str(args.font_size),
        "--cols", str(args.cols),
        "--rows", str(args.rows),
        "--idle-time-limit", str(args.idle_time_limit),
        "--last-frame-duration", str(args.last_frame_duration),
    ]
    if args.line_height is not None:
        agg_cmd += ["--line-height", str(args.line_height)]
    if args.theme:
        agg_cmd += ["--theme", args.theme]
    agg_cmd += [str(cast), str(gif)]
    subprocess.run(agg_cmd, check=True)

    if args.optimize:
        _optimize(gif)

    size_kb = gif.stat().st_size // 1024
    print(f"done — {gif} ({size_kb}K)", file=sys.stderr)
    return gif


def main() -> int:
    args = _parse_args()
    _check_deps()
    gif = record(args)
    print(gif)  # stdout: path for piping
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
