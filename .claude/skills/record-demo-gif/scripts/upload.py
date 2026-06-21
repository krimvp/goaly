#!/usr/bin/env python3
"""Upload a demo GIF and print something you can embed in a PR/MR.

OPT-IN ONLY. The record-demo-gif skill produces a local GIF by default and
uploads nothing. Run this script only when the user explicitly asks to host or
attach the demo. See ../references/uploading.md for the full guide.

Providers:
    catbox <gif>                      anonymous public host; prints an https URL
    gitlab <gif> --project <id|path>  per-project upload; prints embeddable markdown
    gist   <files...> [--public]      gh gist for the cast/script (GIFs do NOT
                                      render inline in gists — host the image
                                      elsewhere for inline embeds)

Examples:
    python3 upload.py catbox /tmp/my-demo.gif
    GITLAB_TOKEN=glpat-... python3 upload.py gitlab /tmp/my-demo.gif --project mygroup/myrepo
    python3 upload.py gist /tmp/my-demo.cast /tmp/my-demo.sh

Running with no provider prints the local-only reminder and exits non-zero.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

CATBOX_API = "https://catbox.moe/user/api.php"


def _die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    raise SystemExit(1)


def _multipart_body(boundary: str, fields: dict[str, str], file_field: str,
                    filename: str, content_type: str, data: bytes) -> bytes:
    parts = bytearray()
    for name, value in fields.items():
        parts += (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
            f"{value}\r\n"
        ).encode()
    parts += (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n'
        f"Content-Type: {content_type}\r\n\r\n"
    ).encode()
    parts += data
    parts += f"\r\n--{boundary}--\r\n".encode()
    return bytes(parts)


# ── catbox.moe ───────────────────────────────────────────────────────────────
def upload_catbox(gif: Path) -> None:
    boundary = "----TerminalDemoGifBoundary"
    body = _multipart_body(
        boundary,
        {"reqtype": "fileupload"},
        "fileToUpload", gif.name, "image/gif", gif.read_bytes(),
    )
    req = urllib.request.Request(
        CATBOX_API,
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    print(f"uploading {gif.name} to catbox.moe …", file=sys.stderr)
    with urllib.request.urlopen(req) as resp:
        url = resp.read().decode().strip()
    if not url.startswith("https://"):
        _die(f"catbox upload failed: {url}")
    print(f"embed with: ![demo]({url})", file=sys.stderr)
    print(url)  # stdout


# ── GitLab uploads API ───────────────────────────────────────────────────────
def upload_gitlab(gif: Path, project: str, base_url: str) -> None:
    token = os.environ.get("GITLAB_TOKEN")
    if not token:
        _die("set GITLAB_TOKEN (a token with api scope) before uploading to GitLab")

    project_enc = urllib.parse.quote(project, safe="")
    api = f"{base_url.rstrip('/')}/api/v4/projects/{project_enc}/uploads"

    boundary = "----TerminalDemoGifBoundary"
    body = _multipart_body(
        boundary,
        {},
        "file", gif.name, "image/gif", gif.read_bytes(),
    )
    req = urllib.request.Request(
        api,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "PRIVATE-TOKEN": token,
        },
        method="POST",
    )
    print(f"uploading {gif.name} to {api} …", file=sys.stderr)
    with urllib.request.urlopen(req) as resp:
        payload = json.loads(resp.read().decode())
    markdown = payload.get("markdown")
    if not markdown:
        _die(f"unexpected GitLab response: {payload}")
    print(
        "note: GitLab upload URLs are relative to the project — paste the "
        "markdown below into an MR/issue description for that project.",
        file=sys.stderr,
    )
    print(markdown)  # stdout


# ── GitHub Gist ──────────────────────────────────────────────────────────────
def upload_gist(files: list[Path], public: bool) -> None:
    if not shutil.which("gh"):
        _die("gh (GitHub CLI) not found — see https://cli.github.com")
    for f in files:
        if not f.exists():
            _die(f"file not found: {f}")
    if any(f.suffix.lower() == ".gif" for f in files):
        print(
            "warning: GIFs do NOT render inline in gists. Use `catbox` (or "
            "another image host) for the inline image and embed that URL; use "
            "gist for the .cast / demo script text instead.",
            file=sys.stderr,
        )
    cmd = ["gh", "gist", "create"]
    if public:
        cmd.append("--public")
    cmd += [str(f) for f in files]
    print("creating gist …", file=sys.stderr)
    result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    print(result.stdout.strip())  # stdout: gist URL


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Upload a demo GIF (opt-in; default is local-only).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    sub = p.add_subparsers(dest="provider")

    c = sub.add_parser("catbox", help="anonymous public host; prints an https URL")
    c.add_argument("gif", type=Path)

    g = sub.add_parser("gitlab", help="per-project upload; prints embeddable markdown")
    g.add_argument("gif", type=Path)
    g.add_argument("--project", required=True, help="project id or url-path (e.g. group/repo)")
    g.add_argument("--base-url", default="https://gitlab.com", help="GitLab base URL")

    gi = sub.add_parser("gist", help="gh gist for cast/script text (not for inline GIFs)")
    gi.add_argument("files", nargs="+", type=Path)
    gi.add_argument("--public", action="store_true")

    return p.parse_args()


def main() -> int:
    args = _parse_args()
    if not args.provider:
        print(
            "no provider given. This skill is local-only by default and uploads "
            "nothing.\nIf you were asked to host/attach the demo, pick a provider:\n"
            "  catbox <gif>                      anonymous public host\n"
            "  gitlab <gif> --project <id|path>  embeddable MR markdown\n"
            "  gist   <files...>                 share the cast/script text\n"
            "See ../references/uploading.md.",
            file=sys.stderr,
        )
        return 2

    if args.provider == "catbox":
        if not args.gif.exists():
            _die(f"file not found: {args.gif}")
        upload_catbox(args.gif)
    elif args.provider == "gitlab":
        if not args.gif.exists():
            _die(f"file not found: {args.gif}")
        upload_gitlab(args.gif, args.project, args.base_url)
    elif args.provider == "gist":
        upload_gist(args.files, args.public)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
