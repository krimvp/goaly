# SpaceX Launch Board — built end-to-end by a goaly run

A demo of goaly's `--adversarial` mode with a **cheap worker and an expensive set of validators**:
the coding agent ran on Haiku 4.5 while the compiler, judge quorum, adversarial critics/refuters,
and the Sign-off approver panel all ran on Opus 4.8.

![screenshot](screenshot.png)

## What was built

A self-contained single-page site (`index.html`, no build step, no external dependencies) showing
upcoming SpaceX launches: a hero with a featured next-launch countdown, a launch board of 8 cards
(mission, vehicle, pad, orbit/payload, status, UTC time), live per-card T-minus countdowns ticking
every second, a Launch Library 2 live fetch with a bundled offline sample fallback and a data-source
indicator, plus a documented design system (`DESIGN.md`: palette, type scale, spacing scale, grid).
`verify.mjs` is the frozen verification the compiler authored (jsdom, fetch stubbed to reject,
`Date` frozen — kept here as durable verification; run it with `npm install --no-save jsdom` then
`node --test verify.mjs` from a directory where `index.html` and `DESIGN.md` sit at the root).

## The invocation

```bash
goaly run \
  --goal-file goal.txt --intent-file intent.txt \
  --autonomous --adversarial \
  --model claude-haiku-4-5-20251001 \
  --llm-model claude-opus-4-8 \
  --max-iterations 6 --budget-tokens 8000000 \
  --stream-transcript
```

- `--model` (the harness/worker) → Haiku 4.5 — the cheap executor.
- `--llm-model` (compiler / judge / approver, and via the critic-model cascade also the
  adversarial contract critics and refuters) → Opus 4.8.
- `--adversarial` red-teamed the compiled contract before Seal (1 critical finding triggered a
  re-author round), appended a 3-vote refuter rung after the frozen ladder, and widened Sign-off
  to a 3-reviewer panel.

## How the run went

| | |
| --- | --- |
| run id | `run-f74f57aa-831e-404c-8edb-61391c9f8115` |
| contract hash | `fbac0a0f8e20b9f53d7508508e3b25c47566ccc757df10d6b6d824cfe0f5cb1f` (frozen at Seal, never changed) |
| outcome | **DONE** — both keys turned |
| iterations | 3 |
| total spend | ~3.19M tokens (harness 1.89M · compiler 208k · judge/verifier rungs · approver 90k) |

The contract compiled to a two-rung ladder — a deterministic jsdom test (`node --test verify.mjs`)
that stubs `fetch` to reject and freezes `Date`, asserting ≥6 distinct real launches render offline
with countdowns mathematically derived from `data-launch-time` — plus an Opus judge quorum
(3 votes, 0.66 confidence floor). Iteration 3 passed all checks (judge confidence 0.855), the
3 adversarial refuters failed to refute the green, and the Sign-off panel approved.

Operational notes from the run (the interesting part of the demo):

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
