# Paradox Foundry — a goaly showcase

**Paradox Foundry** is an innovative **time-loop automation puzzle game** that runs in the browser
with no build step and no dependencies. You control one worker for a fixed-length loop; when the
loop ends, your recorded actions are baked into a permanent **echo** that replays — forever, in
lock-step — beside the next you. You bootstrap an entire factory out of cooperating copies of your
past selves (`ore → forge → metal`, `2 metal → assembler → gear`, `gear → output → core`) while the
engine detects two classes of **paradox** when your echoes conflict:

- **collision paradox** — two actors enter the same cell on the same tick (resolved deterministically,
  older echoes win), and
- **starvation paradox** — an echo's recorded action expects a resource another actor already took.

This directory exists to **showcase [goaly](../../README.md)** — the harness-agnostic
goal-orchestration layer that runs a coding agent until a *frozen, two-key* success contract is met.

## What's here

| Path | What it is |
| --- | --- |
| `src/`, `test/`, `index.html` | The **hand-built reference** implementation (pure deterministic engine + `node --test` contract + canvas UI). |
| `goaly/GOAL.md`, `goaly/INTENT.md`, `goaly/RUBRIC.md` | The three goaly inputs — **goal**, **instructions (intent)**, and **rubric** — the human authors. |
| `goaly/built/` | A version of the game **built entirely by goaly** from those inputs, plus a `RUN-LOG.txt` proving each step reached two-key DONE. |
| `goaly/staged-build.sh` | A reusable orchestrator that builds the game with goaly **in small increments**. |

> The hand-built and goaly-built versions are deliberately separate: one is the polished reference,
> the other is the artifact of letting goaly drive the build from scratch.

## Playing it

Open `index.html` (or `goaly/built/index.html`) directly in a modern browser — no server, no build.
Move with the arrow keys / WASD, `Space`/`E` to act (mine, deposit, collect, ship), `Enter` to bake
an echo, `Z` to undo, `R` to restart the loop. Solve each level by recording cooperating echoes.

## Running the engine's frozen contract

The simulation core is pure and deterministic, so it is locked by a zero-dependency test suite:

```bash
cd examples/paradox-foundry            # the hand-built reference
node --test 'test/**/*.test.mjs'

cd goaly/built                         # the goaly-built version
node --test 'test/*.test.mjs'
```

## How goaly built it — all three features (goal · rubric · instructions)

With `--generate`, goaly's compiler feeds **all three** human inputs into the contract-authoring
step (`src/compile/agent-compiler.ts`):

```
goaly run --generate --autonomous \
  --goal-file   goaly/GOAL.md \
  --intent-file goaly/INTENT.md \      # "instructions" — steers the authored verification
  --rubric-file goaly/RUBRIC.md \
  --harness claude-code --model opus --llm-model sonnet
```

goaly then **freezes** the authored verification (an integrity guard pins the test files by content
hash so the worker can't rewrite the bar), runs the harness to satisfy it, and declares **DONE only
on two independent keys**: the frozen verifier ladder passes **and** the Gate B approver doesn't veto.

## The interesting part: building in small increments

A single from-scratch run of a *large* program asks goaly's judge and Gate B approver to ingest the
worker's **entire `git diff HEAD`** as untrusted data every iteration — which makes those prompts
huge (and, in token- or context-constrained environments, can overload the model).

**The fix is to keep every run's diff small.** goaly computes its diff against the workspace git
**HEAD** (`src/workspace/git-workspace.ts`), so if you **commit after each run reaches DONE**, the
next run only ever sees its own small change. Drive a *sequence of terse sub-goals*, commit between
them, and every compile/harness/judge/approver prompt stays small — while each increment still gets
goaly's full frozen-contract, two-key treatment.

`goaly/built/` was produced exactly this way, in six increments (see `RUN-LOG.txt`):

1. pure grid engine (`createWorld`/`parseLevel`/`step`, walls) 2. mining + inventory capacity
3. **time-loop echo replay** 4. collision-paradox detection 5. canvas renderer 6. playable `index.html`

Reproduce it:

```bash
GOALY="npm --prefix /path/to/goaly run dev --" \
WORKSPACE=/tmp/foundry-staged \
./goaly/staged-build.sh
```

Each increment runs `goaly run --generate` with a small goal/intent/rubric, and the script commits
only after goaly exits `0` (DONE) — resetting the diff baseline for the next increment.
