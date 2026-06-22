#!/usr/bin/env bash
#
# staged-build.sh — build a game with goaly in SMALL INCREMENTS.
#
# Why this exists: goaly's judge and Gate B approver ingest the worker's `git diff HEAD` as
# untrusted data on every iteration. If a single run produces a huge diff, those prompts get huge —
# which overloads (or, in constrained/nested environments, stalls) the model. The fix is to keep
# every run's diff small: drive a SEQUENCE of tiny sub-goals, and COMMIT after each one reaches
# two-key DONE. Because `git diff HEAD` resets at each commit, the next run only ever sees its own
# small change, so every compile/harness/judge/approver prompt stays small.
#
# Each increment still uses goaly's full power: --generate authors a frozen contract from the
# goal/intent/rubric, the harness builds until the frozen verifier passes, and DONE needs both keys.
#
# Usage:
#   GOALY="npm --prefix /path/to/goaly run dev --" \
#   WORKSPACE=/tmp/foundry-staged \
#   ./staged-build.sh
#
# Env knobs (with defaults):
#   GOALY        how to invoke goaly         (default: "goaly")
#   WORKSPACE    target git repo to build in (default: ./build)
#   HARNESS      coding-agent CLI            (default: claude-code)
#   MODEL        harness model              (default: opus)
#   LLM_MODEL    compiler/judge/approver    (default: sonnet)
#   MAX_ITERS    per-increment iteration cap (default: 5)

set -euo pipefail

GOALY="${GOALY:-goaly}"
WORKSPACE="${WORKSPACE:-./build}"
HARNESS="${HARNESS:-claude-code}"
MODEL="${MODEL:-opus}"
LLM_MODEL="${LLM_MODEL:-sonnet}"
MAX_ITERS="${MAX_ITERS:-5}"

# Each increment is three TERSE strings: goal · intent (verification to author) · rubric.
# Terseness is not cosmetic — it keeps the compile prompt small. Keep new code per step to a few KB
# so the resulting diff stays under the model's comfortable prompt size.
increments=(
"Create src/engine.js (pure ES module: no DOM, no Math.random, no Date) for a tile game. Export parseLevel(ascii) building {width,height,tiles,worker:{x,y,inv:[]},tick:0} from a map where '@'=worker start, '.'=empty, '#'=wall, 'O'=ore. Export step(world,action) for action up/down/left/right moving the worker (walls and edges block). step returns a NEW world and never mutates its input.|Author a zero-dep node --test suite under test/ covering parsing, movement, wall/edge blocking, and no-mutation. Verify command: node --test test/*.test.mjs|engine.js is pure and non-mutating; tests genuinely exercise movement and bounds; reject if impure or vacuous."

"Extend src/engine.js: give the worker an inventory with a capacity (default 3). When action is 'act' on an ore tile, push 'ore' into inv if there is room. Add an 'X' output tile glyph to parseLevel; 'act' on output while holding nothing is a no-op. Keep everything pure.|Extend the node --test suite to cover mining, the capacity limit, and that previous movement tests still pass. Verify command: node --test test/*.test.mjs|pure/deterministic; capacity respected; old tests still green; reject if impure or vacuous."

"Add the TIME-LOOP mechanic to src/engine.js. step() appends each live action to world.recording. Export endLoop(world) which bakes world.recording into a new ENTRY of world.echoes (each {actions,x,y,inv}), then resets tick to 0, the worker to its start, and increments world.loopCount. On each step, every echo replays its recorded action for the current tick BEFORE the live worker acts, as an independent actor. Keep it pure.|Extend the node --test suite: a baked loop replays next loop as an independent actor (it moves/mines on its own while the live worker waits). Verify command: node --test test/*.test.mjs|the echo replay is real and independent; pure/deterministic; old tests green; reject if fake or impure."

"Add COLLISION PARADOX detection to src/engine.js. When two actors (echoes and/or the worker) try to enter the same cell on the same tick, resolve deterministically (older echoes win) and increment world.paradoxes.collision; the loser stays put. Keep it pure.|Extend the node --test suite: two actors contesting one cell -> older wins, loser stays, collision count increments. Verify command: node --test test/*.test.mjs|deterministic priority resolution; counter increments; old tests green; reject if non-deterministic."

"Add export hashState(world) to src/engine.js: a stable string fingerprint of the dynamic state (tick, loopCount, worker, echoes, score, paradoxes) using a pure FNV-1a hash (no crypto). Also export serialize(world)/deserialize(data) that round-trip the world exactly. Keep it pure.|Extend the node --test suite: identical inputs -> identical hashState; serialize/deserialize round-trips to the same hashState. Verify command: node --test test/*.test.mjs|deterministic fingerprint; exact round-trip; old tests green; reject if vacuous."

"Create src/render.js exporting drawWorld(ctx, world, cell): a Canvas 2D renderer drawing tiles (walls, ore, output), the worker, and each echo as a translucent ghost. No game logic in here; import nothing from the DOM at module top-level. Keep engine.js unchanged.|Author a small deterministic check (a node script or grep) asserting render.js exists, exports drawWorld, and engine.js has NO DOM references. Verify command: node --test test/*.test.mjs (add a structural test).|renderer is separate from the pure engine; engine stays DOM-free; reject if engine imports the DOM."

"Create index.html that loads src/engine.js and src/render.js as ES modules, draws a starting level on a <canvas>, and maps arrow keys to step() + a button to endLoop(), redrawing after each. No build step, no dependencies, no network. Keep engine.js and render.js unchanged.|Author a deterministic structural check that index.html exists, references engine.js and render.js as type=module, and contains a <canvas>. Verify command: node --test test/*.test.mjs (add a structural test).|playable by opening index.html directly; vanilla modules; no deps/network; reject otherwise."
)

echo ">> staged goaly build into: $WORKSPACE"
mkdir -p "$WORKSPACE"
if [ ! -d "$WORKSPACE/.git" ]; then
  git -C "$WORKSPACE" init -q
  git -C "$WORKSPACE" config user.email staged@goaly.local
  git -C "$WORKSPACE" config user.name "goaly staged build"
  git -C "$WORKSPACE" commit -q --allow-empty -m "empty workspace"
fi

n=0
for spec in "${increments[@]}"; do
  n=$((n + 1))
  goal="${spec%%|*}"; rest="${spec#*|}"
  intent="${rest%%|*}"; rubric="${rest#*|}"
  echo
  echo "==================== INCREMENT $n / ${#increments[@]} ===================="
  echo ">> $goal" | cut -c1-100

  # Authored files must live UNDER the workspace — goaly fail-closes on an absolute/outside path,
  # so we steer the compiler to relative paths explicitly.
  intent="$intent Author any files at RELATIVE paths under the workspace only (never absolute paths)."

  # goaly exits 0 only on DONE (1 on FAILED/ABORTED). `set -e` already aborts the whole script on a
  # non-zero exit, so if we reach the next line the increment reached two-key DONE.
  if $GOALY run \
      --goal "$goal" \
      --intent "$intent" \
      --rubric "$rubric" \
      --generate --autonomous \
      --harness "$HARNESS" --model "$MODEL" --llm-model "$LLM_MODEL" \
      --workspace "$WORKSPACE" --max-iterations "$MAX_ITERS" \
      --harness-timeout-ms 900000 --llm-timeout-ms 900000; then
    git -C "$WORKSPACE" add -A
    git -C "$WORKSPACE" commit -q -m "increment $n (goaly): ${goal:0:60}"
    echo ">> increment $n committed — diff baseline reset for the next run"
  else
    echo "!! increment $n did not reach DONE; stopping so the diff stays small. Inspect and re-run."
    exit 1
  fi
done

echo
echo ">> staged build complete. Open $WORKSPACE/index.html to play."
