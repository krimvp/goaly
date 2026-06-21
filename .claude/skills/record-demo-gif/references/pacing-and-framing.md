# Pacing & framing

How to make a recording that reads like a demo instead of a wall of scrolling
logs. Two levers: **what you show** (framing) and **how long each beat lasts**
(pacing).

## Framing: give context, not the full log

The goal is to *showcase functionality*, not to reproduce a terminal session.
Show enough to make the demo intelligible, then stop.

- **Set the scene.** Show the relevant config / env state — but a *slice*
  (`sed -n '1,12p' config.yaml`), not the whole file.
- **Show the command.** Echo it as a prompt (`echo "$ my-tool run"`) so the
  viewer reads the command before the output appears.
- **Trim the output.** For anything long, show a summary instead of the dump:
  - `grep -E 'PASS|FAIL' results.txt`
  - `... | tail -n 5`
  - `... | head -n 20`
  - a tool's own `--summary` / `--quiet` mode
- **End on a verify beat.** A passing check, a `✓`, the produced artifact —
  something that proves it worked.

| | |
|---|---|
| ❌ BAD | `cat huge.log` — hundreds of lines scroll past, nothing is readable |
| ✅ GOOD | `grep -E 'PASS\|FAIL' huge.log` then `echo "✓ all green"` |

## Pacing: idle-time-limit is a *cap*, not a fixed speed

`agg --idle-time-limit N` clamps **every** pause in the recording to at most
`N` seconds. This is the key knob and it is easy to get backwards:

- Set `--idle-time-limit` to the **longest freeze you want to keep**.
  `record.py` defaults it to **3**.
- Then create freezes with `sleep` in the demo script, keeping them **at or
  below** that cap:
  - `sleep 1` — minor beat (let the prompt register before output)
  - `sleep 3` — hold an important result long enough to read
- A long *accidental* idle (e.g. a 30s build that produces no output) is still
  clipped down to the cap, so the GIF never stalls.

If you set the cap too low (e.g. `1`), your deliberate `sleep 3` freeze gets
compressed to 1s and the viewer can't read the result. If you set it very high,
dead time during slow commands drags the GIF out. Match the cap to your longest
intended freeze.

`--last-frame-duration` (default 6) holds the **final** frame so the GIF ends on
the result rather than snapping back to the start.

## Suppress spinners and progress bars

Spinners, progress bars, and live-updating status lines repaint many times per
second. That sub-second stream of output:

1. **defeats idle compression** — agg sees constant activity, so your `sleep`
   freezes and any dead time never get clipped, and
2. **bloats the GIF** — every repaint becomes frames.

Turn them off for the recording. Common switches (use whatever the tool honors):

- `NO_SPINNER=1`
- `CI=1` (many tools drop animations in CI)
- `--no-progress`, `--quiet`, `--no-color` is usually *not* needed (color is fine)
- `TERM=dumb` as a last resort

## Keeping the GIF small

- Trim output and pauses (above) — fewer frames is the biggest win.
- Keep `--cols`/`--rows` only as large as the content needs.
- Run `record.py --optimize` to post-process with `gifsicle -O3` (if installed).
- If a GIF is still huge, the demo is probably trying to show too much — cut a
  phase rather than cranking compression.
