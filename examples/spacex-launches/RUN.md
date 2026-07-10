# SpaceX Launch Board — built end-to-end by a chain of goaly runs

A demo of goaly's `--adversarial` mode with a **cheap worker and an expensive set of validators**:
the coding agent ran on Haiku 4.5 while the compiler, judge quorum, adversarial critics/refuters,
and the Sign-off approver panel all ran on Opus 4.8. Each restyle was a `--from-run` follow-up of
the previous run: (1) build the board, (2) neon crystal restyle, (3) mission-control command
center, (4) the integrated line-art rocket-in-tower centerpiece with clamped scroll parallax —
the current look.

![screenshot](screenshot.png)

## What was built

A self-contained single-page site (`index.html`, no build step, no external dependencies) showing
upcoming SpaceX launches as a mission-control command center: a telemetry ticker bar, a hero with a
featured next-launch countdown in LED-segment digits, instrument-panel launch cards with mission
designations (mission, vehicle, pad, orbit/payload, status, UTC time), live per-card T-minus
countdowns ticking every second, a Launch Library 2 live fetch with a bundled offline sample
fallback and a data-source indicator — plus the centerpiece: a single-SVG stroke-only line-art
scene of a Falcon-style rocket standing in its launch tower (service arms, beacon, engine glow,
flame trench) with a stroke-dashoffset draw-in reveal and scroll parallax whose per-layer speeds
are clamped so the scene never leaves its section, all disabled under `prefers-reduced-motion`.
`DESIGN.md` documents the phosphor-green/amber command-center palette, type + spacing scales,
panel/bracket treatments, the line-art rules, and the parallax clamp policy.

`verify.mjs` is the frozen verification the final run's compiler authored (jsdom, fetch stubbed to
reject, `Date` frozen, `window.scrollY` driven programmatically to prove differentiated-and-clamped
parallax). Run it with `npm install --no-save jsdom` then `node --test --test-force-exit verify.mjs`
from a directory where `index.html` and `DESIGN.md` sit at the root.

## The invocations

```bash
# Run 1 — build the board from scratch
goaly run \
  --goal-file goal.txt --intent-file intent.txt \
  --autonomous --adversarial \
  --model claude-haiku-4-5-20251001 \
  --llm-model claude-opus-4-8 \
  --max-iterations 6 --budget-tokens 8000000

# Runs 2-4 — follow-ups: each restyle aware of the previous run via --from-run
goaly run --from-run <prior-run-id> \
  --goal-file goalN.txt --intent-file intent.txt \
  --autonomous --adversarial \
  --model claude-haiku-4-5-20251001 \
  --llm-model claude-opus-4-8 \
  --max-iterations 6 --budget-tokens 8000000
```

- `--model` (the harness/worker) → Haiku 4.5 — the cheap executor.
- `--llm-model` (compiler / judge / approver, and via the critic-model cascade also the
  adversarial contract critics and refuters) → Opus 4.8.
- `--adversarial` red-teamed each compiled contract before Seal, appended a 3-vote refuter rung
  after the frozen ladder, and widened Sign-off to a 3-reviewer panel.

## How the runs went

| | Run 1 (build) | Run 2 (neon crystal) | Run 3 (command center) | Run 4 (rocket centerpiece) |
| --- | --- | --- | --- | --- |
| run id | `run-f74f57aa…` | `run-b085cc35…` | `run-40bad9a4…` | `run-91b9a1f4…` |
| red-team pre-Seal | 1 finding → re-author | 3 findings → re-author | (3a aborted `CONTRACT_UNSOUND`; 3b clean) | clean |
| outcome | **DONE** | **DONE** | **DONE** | **DONE** (after a `--resume` revive) |
| iterations | 3 | 1 | 2 | 6 |
| ladder confidence | 0.855 | 0.81 | 0.67 | 0.82 |
| total spend | ~3.19M tokens | ~3.76M | ~5.48M | ~10.35M |

Highlights of what the adversarial critics bought, per run:

- **Run 2**: instead of grepping the stylesheet for neon keywords (trivially gameable), the frozen
  test walks the parsed CSSOM and asserts the `clip-path` facets, `backdrop-filter` glass, and glow
  shadows are **bound to the actual launch-card elements** (pseudo-classes stripped, media blocks
  flattened, with a decoy unused-selector rule that must NOT count), and that the pre-redesign tree
  fails the bar.
- **Run 3 (first attempt)**: the pre-flight caught the authored verification hanging forever — the
  page's mandated per-second `setInterval` keeps jsdom's event loop alive — and aborted as
  `CONTRACT_UNSOUND` **before any worker token was spent**, correctly blaming the verification, not
  the tree. The retry's intent made test termination an explicit authoring requirement
  (`window.close()` + `--test-force-exit`).
- **Run 4**: the contract demanded an *integrated* single-SVG rocket-in-tower (explicitly failing
  the previous two-separate-SVGs tree), a stroke-only ratio, a declared ≥480px scene height, and a
  parallax clamp tested at scroll positions up to 200,000px. The worker burned the first budget
  failing the parallax assertion (jsdom has no layout, so geometry-derived offsets compute to
  zero); a `--resume` with `--stuck-no-diff false`, a raised budget, and an operator `--note`
  explaining the jsdom-safe recipe (pure-`scrollY` offsets, constant per-layer speeds, constant
  clamp) let iteration 6 clear the unchanged frozen bar.

Operational notes from run 1 (the interesting part of the demo):

- Iterations 1–2 ended with the judge **unevaluable** — the sandbox's `.gitignore` didn't exclude
  `node_modules/` (created by the contract's own one-time `npm install --no-save jsdom` setup), so
  goaly's diff — which deliberately includes untracked files *with content* so the judge can review
  a from-scratch build — ballooned to megabytes and the judge CLI choked on it. goaly stayed
  fail-closed the whole way: the broken judge was never a green, and the run aborted as
  `CONTRACT_UNEVALUABLE` ("your tree may be correct but is UNVERIFIED") rather than fabricating a
  verdict.
- After adding `node_modules/` to the sandbox `.gitignore`, `--resume` re-entered the loop from the
  write-ahead log and finished: same frozen contract, same hash, no work repeated.
- Resumes must re-pass the wiring flags (`--model` / `--llm-model` / `--adversarial`) — model
  selection is per-invocation, only the contract is frozen.
- The oversized-prompt child dying mid-stdin-write also surfaced a real crash bug in goaly
  (unhandled `EPIPE` in `src/util/spawn.ts`), filed as
  [#101](https://github.com/krimvp/goaly/issues/101).
