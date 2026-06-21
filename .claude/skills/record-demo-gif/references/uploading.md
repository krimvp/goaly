# Uploading & embedding (opt-in)

**Default behavior: nothing is uploaded.** The skill produces a local GIF
(`/tmp/<name>.gif`) and stops. Upload **only** when the user explicitly asks to
host the GIF or attach it to a PR/MR. All uploads go through
`../scripts/upload.py`.

Pick a provider based on where the demo is going:

| Destination | Provider | Auth needed |
|---|---|---|
| Any PR/MR, quickest | `catbox` | none |
| GitLab MR/issue (self-hosted or .com) | `gitlab` | `GITLAB_TOKEN` (api scope) |
| Share the cast/script text | `gist` | `gh` authenticated |

---

## catbox.moe (anonymous, works anywhere)

No account or credentials. Returns a public `https://files.catbox.moe/...` URL
you can embed in any GitHub PR or GitLab MR.

```bash
python3 ../scripts/upload.py catbox /tmp/my-demo.gif
# -> https://files.catbox.moe/abc123.gif
```

Embed it (Markdown):

```markdown
## Demo

![demo](https://files.catbox.moe/abc123.gif)
```

### Attach to a GitHub PR

`gh` is the GitHub CLI (already authenticated in this environment). Put the
embed in the PR body:

```bash
URL=$(python3 ../scripts/upload.py catbox /tmp/my-demo.gif)
gh pr create --draft \
  --title "Short description of the feature shown" \
  --body "$(printf '## Summary\n\n- what changed\n\n## Demo\n\n![demo](%s)\n' "$URL")"

# or add it to an existing PR:
gh pr edit <number> --body "...existing body...

## Demo

![demo]($URL)"
```

---

## GitLab uploads API (per-project, embeddable markdown)

GitLab hosts the file under the project and returns ready-to-paste markdown.
Needs a token with `api` scope in `GITLAB_TOKEN`.

```bash
GITLAB_TOKEN=glpat-xxxxx \
python3 ../scripts/upload.py gitlab /tmp/my-demo.gif --project mygroup/myrepo
# -> ![my-demo](/uploads/<hash>/my-demo.gif)

# self-hosted instance:
GITLAB_TOKEN=glpat-xxxxx \
python3 ../scripts/upload.py gitlab /tmp/my-demo.gif \
  --project mygroup/myrepo --base-url https://gitlab.example.com
```

The returned URL is **relative to that project**, so paste the markdown into an
MR/issue description **of the same project**. The `glab` CLI is not required.

---

## GitHub Gist (for the cast / script, not the image)

GIFs do **not** render inline in gists, so use this to share the recording
*source* (the `.cast` file or the demo script) — host the image itself via
`catbox` for the inline embed.

```bash
python3 ../scripts/upload.py gist /tmp/my-demo.cast /tmp/my-demo.sh
# -> https://gist.github.com/<user>/<id>
```

Anyone can replay a `.cast` with `asciinema play` or `agg`.

---

## Never

- Never upload by default — the user must ask.
- Never commit GIFs/casts into the repo (`/tmp` artifacts stay in `/tmp`).
- Never put a token on the command line in a way that lands in shell history;
  prefer `GITLAB_TOKEN=... python3 ...` (a leading env assignment) or export it
  in the current shell.
