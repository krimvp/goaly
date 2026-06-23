---
name: record-demo-gif
description: >-
  Record an animated GIF that showcases goaly (or any CLI) running end-to-end — setup → run →
  output → verify — tuned for a reviewer to watch, not a full log dump. Use when asked to record,
  demo, or screencast goaly, a CLI command, or a workflow as a GIF, or to attach a terminal demo to
  a PR. For goaly demos it knows the loop-specific recipe: a throwaway git sandbox, running from
  inside it, --autonomous so the frozen contract still shows, and decoding the run log to reveal the
  verifier ladder + Sign-off approver (the two keys for DONE).
---

# record-demo-gif

Record an animated GIF that **showcases** terminal functionality — the kind you drop into a PR so a
reviewer sees the feature work without running it. Pipeline: a demo shell script → `asciinema`
records it → `agg` converts the recording to a GIF. Everything stays in `/tmp` by default;
**nothing is uploaded unless the user asks.**

> Recording **goaly** specifically? Read [`references/goaly-demo-recipe.md`](references/goaly-demo-recipe.md)
> first — it has the loop-specific recipe, the four gotchas that silently ruin a goaly recording, and
> two ready helpers (`make-goaly-sandbox.sh`, `reveal-runlog.py`). The rest of this file is the
> general recording machinery that recipe builds on.

## When to activate

- "Record / make a GIF / screencast of goaly (or this CLI / command / workflow)."
- "Demo this for the PR" / "attach a terminal demo."
- "Show this running end-to-end as a GIF."
- The user names something specific to record — then record exactly that.

**Skip when:** demoing a GUI/browser UI (use a screen recorder), editing existing video, or the user
just wants a static screenshot or text transcript.

## What a good showcase is

Show the **story** of the feature, not a terminal log. Give just enough context to make it
intelligible, then the salient result, then proof it worked. Default scope = the full lifecycle of
the *new* functionality:

1. **Setup** — the relevant config/starting state (only if part of the change)
2. **Run** — execute the tool/feature
3. **Output** — the part of the output that matters (trimmed)
4. **Verify** — end on a clear ✓ (a passing check, the produced artifact)
5. **Cleanup** — teardown (only if teardown is part of the change)

For goaly, that maps to: show the buggy repo + failing check → `goaly run …` → the **frozen success
contract** + `DONE` → the diff the agent made + the verifier passing. See the recipe.

> Give context, don't dump logs. The config and the command are good; every line of a 400-line log
> is not.

## Workflow

1. **Check deps.** Run `scripts/check_deps.py`. If `asciinema` or `agg` is missing, stop and relay
   the install hints — do not auto-install.
2. **Clarify what to demo** (or take the explicit instruction). Identify the 3–5 commands that tell
   the story. For goaly, pick a variant from the recipe (deterministic `--verify-cmd`, or
   `--generate` + rubric to show the LLM side).
3. **Dry-run the key commands first.** The demo must show success (✓), never a broken run — and real
   agents are nondeterministic, so confirm each harness reaches `DONE` before recording.
4. **Write the demo script** from `references/demo-script-template.sh` (and the recipe's skeletons).
   Save to `/tmp/<name>-demo.sh` — nothing committed.
5. **Record + convert:**
   ```bash
   python3 scripts/record.py --script /tmp/<name>-demo.sh --out /tmp/<name>-demo.gif
   ```
6. **Review the GIF.** Too noisy → trim output. Too fast → raise a `sleep`. Too big → cut a phase
   (see `references/pacing-and-framing.md`). Verify the recorded `.cast` actually shows `DONE`/✓.
7. **Upload only if asked** — `scripts/upload.py` + `references/uploading.md`.

## Writing the demo script

Each visible command follows one beat: echo the prompt → small pause → run → pause to read the
output. Hide setup noise. Trim long output. The `run`/`show`/`gap` helpers in
`references/demo-script-template.sh` encode this.

- **Hide setup noise** — silence `npm run build`, sandbox creation, etc.; the viewer sees only
  story-relevant commands.
- **Echo each visible command, then run it.**
- **Trim long output** to the salient lines (`grep`, `tail`, a `--summary`), never a full `cat`.
- **Suppress spinners/progress** (`NO_SPINNER=1`, `CI=1`, `--no-progress`): sub-second repaints
  defeat idle compression and bloat the GIF.

## Pacing & freezing frames

`agg --idle-time-limit N` is a **cap on every pause**, not a fixed speed. Set it to the **longest
freeze you want to keep** (`record.py` default: `3`), then use `sleep` to create freezes at or below
that cap: `sleep 1` (minor beat), `sleep 3` (hold a result). Accidental long idles — including
goaly's silent wait while an agent works — are clipped to the cap, so the GIF never stalls.
`--last-frame-duration` (default 6) holds the final frame. Deep dive: `references/pacing-and-framing.md`.

## Recording reference

```bash
python3 scripts/record.py --script /tmp/demo.sh [options]
```

| Flag | Default | Purpose |
|---|---|---|
| `--script` | (required) | demo shell script to record |
| `--out` | `/tmp/<stem>.gif` | output GIF path |
| `--cols` / `--rows` | 200 / 50 | terminal size (drives GIF pixel size) |
| `--font-size` | 14 | GIF font size |
| `--idle-time-limit` | 3 | cap (s) on every pause — set to longest freeze |
| `--last-frame-duration` | 6 | hold the final frame (s) |
| `--theme` | — | agg theme (e.g. `dracula`) |
| `--optimize` | off | `gifsicle -O3` if gifsicle is installed |

## Uploading (opt-in — default is local-only)

The skill uploads **nothing** by default. Only when asked to host/attach, use `scripts/upload.py`
(`catbox` anonymous host, `gitlab` uploads API, or `gist` for the cast/script) and embed per
`references/uploading.md`. For a GitHub PR: `URL=$(… upload.py catbox <gif>)` then put
`![demo]($URL)` in the `gh pr create`/`gh pr edit` body.

## Anti-patterns

- **Dumping full logs** (`cat huge.log`) — trim to salient lines.
- **Recording a failing/nondeterministic run** — dry-run and fix first; the demo proves success.
- **No pauses** — output flies by; add `sleep` beats.
- **Spinners left on** — bloats the GIF, defeats idle compression.
- **Uploading by default** — never host/attach without being asked.
- **Committing artifacts** — GIFs/casts live in `/tmp`, never in the repo. (The skill's own
  scripts/references ARE committed; the recordings are not.)
- **idle-time-limit too low** — your deliberate `sleep 3` freeze gets crushed.

## Checklist

- [ ] `check_deps.py` passed (asciinema + agg present)
- [ ] (goaly) read `references/goaly-demo-recipe.md`; sandbox is a git repo; running from inside it
- [ ] Key commands dry-run and succeed (showing ✓ / `DONE`, not ✗ / ABORT)
- [ ] Setup noise silenced; each visible command echoed before it runs
- [ ] Long output trimmed (grep/head/tail/summary), not full dumps
- [ ] A verify beat ends the demo (passing check / produced artifact / decoded run log)
- [ ] Spinners/progress suppressed; freezes readable (sleeps ≤ idle-time-limit cap)
- [ ] Recorded `.cast`/GIF reviewed for correctness, noise, speed, and size
- [ ] Nothing uploaded unless the user asked
