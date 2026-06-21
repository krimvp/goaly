#!/usr/bin/env bash
#
# Demo script template for record-demo-gif.
#
# Copy this to /tmp/<name>-demo.sh, fill in the phases, then record it:
#     python3 ../scripts/record.py --script /tmp/<name>-demo.sh
#
# The viewer should see a STORY, not a log dump. Each visible command follows
# the same beat: echo the prompt → small pause → run it → pause to read the
# salient output. Hide noisy setup. Trim long output. End sections on a clear ✓.
#
# Pauses are how you control the GIF (see ../references/pacing-and-framing.md):
#   sleep 1   minor beat (let the prompt register)
#   sleep 3   hold an important result long enough to read
# record.py defaults --idle-time-limit to 3, so any pause up to 3s is kept and
# longer accidental idles are clipped. Keep your sleeps <= that cap.

set -e

# ── helpers ──────────────────────────────────────────────────────────────────
# Echo a command as a shell prompt, pause briefly, then run it.
run() { echo "\$ $*"; sleep 1; "$@"; }
# Echo + run, then hold the result for review.
show() { echo "\$ $*"; sleep 1; "$@"; sleep 3; }
# A blank line between sections gives the GIF breathing room.
gap()  { echo ""; sleep 1; }

# ── 0. silent setup (HIDDEN from the viewer) ──────────────────────────────────
# Put everything that isn't part of the story here, and silence it. The viewer
# should not see venv activation, dependency installs, cache warming, etc.
cd "$(git rev-parse --show-toplevel)"
# Suppress spinners / progress bars — sub-second repaints defeat idle
# compression and bloat the GIF. Use whatever your tool understands:
export NO_SPINNER=1 CI=1   # examples; adjust per tool
# source .venv/bin/activate >/dev/null 2>&1
# npm ci >/dev/null 2>&1

# ── 1. set the scene: show relevant CONFIG / ENV STATE (just enough) ──────────
# Give the viewer the context that makes the demo make sense — the config file,
# the starting state — but only the relevant slice, not the whole thing.
echo "# Starting state — the config that drives this feature:"
show sed -n '1,12p' path/to/config.yaml          # a SLICE, not the whole file
gap

# ── 2. run the tool / new functionality ───────────────────────────────────────
echo "# Run the new feature:"
show ./bin/my-tool --do-the-thing
gap

# ── 3. showcase the OUTPUT (trimmed to what matters) ──────────────────────────
# For long output, show a summary, a grep, or a head/tail — never the full dump.
echo "# Result (the part that matters):"
show grep -E 'PASS|FAIL|created|updated' /tmp/my-tool-output.txt   # GOOD: salient lines
# BAD:  cat /tmp/my-tool-output.txt   # don't dump hundreds of log lines
gap

# ── 4. VERIFY it worked (end on a clear ✓) ────────────────────────────────────
echo "# Verify the effect:"
show ls -la path/to/produced/artifact
echo "✓ feature works as expected"
sleep 3
gap

# ── 5. cleanup (ONLY if teardown is part of the new functionality) ────────────
# If the change introduces setup/teardown, show the teardown so the demo proves
# it leaves the environment clean. Otherwise omit this phase entirely.
echo "# Clean up:"
show ./bin/my-tool --teardown
echo "✓ environment restored"
sleep 3
