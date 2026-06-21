#!/usr/bin/env python3
"""Check the tools the record-demo-gif skill needs, and print install hints.

Usage:
    python3 check_deps.py

Required tools (recording fails without these):
    asciinema  — records the terminal session to a .cast file
    agg        — converts the .cast file to an animated GIF

Optional tools (used only if present; never installed automatically):
    gifsicle   — shrinks the final GIF (record.py --optimize)
    ffmpeg     — alternative post-processing (e.g. GIF -> mp4)
    gh         — GitHub CLI, for `upload.py gist` and embedding in a PR
    curl       — used by some upload paths

Exits non-zero if any REQUIRED tool is missing. Optional tools never fail
the check; they are just reported as absent.
"""

from __future__ import annotations

import shutil
import sys

# tool name -> install hint shown when missing
REQUIRED = {
    "asciinema": "pip install asciinema --break-system-packages",
    "agg": "download a binary from https://github.com/asciinema/agg/releases",
}

OPTIONAL = {
    "gifsicle": "apt install gifsicle  (GIF size optimization)",
    "ffmpeg": "apt install ffmpeg  (optional post-processing)",
    "gh": "https://cli.github.com  (gist upload / PR embedding)",
    "curl": "apt install curl  (used by some upload paths)",
}


def _row(name: str, path: str | None, hint: str) -> str:
    mark = "✓" if path else "✗"
    where = path if path else f"missing — {hint}"
    return f"  {mark} {name:<10} {where}"


def main() -> int:
    print("record-demo-gif — dependency check\n")

    print("required:")
    missing_required: list[str] = []
    for name, hint in REQUIRED.items():
        path = shutil.which(name)
        if not path:
            missing_required.append(name)
        print(_row(name, path, hint))

    print("\noptional:")
    for name, hint in OPTIONAL.items():
        print(_row(name, shutil.which(name), hint))

    if missing_required:
        print(
            "\nerror: missing required tool(s): "
            + ", ".join(missing_required)
            + "\ninstall them (see hints above) before recording.",
            file=sys.stderr,
        )
        return 1

    print("\nall required tools present — ready to record.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
