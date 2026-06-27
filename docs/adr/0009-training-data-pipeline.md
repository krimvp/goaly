# ADR 0009 — Training-data pipeline: labeled trajectories, rejection-sampling SFT, eval bench

## Status
Accepted (data pipeline shipped; the fine-tune / RL execution is infra-gated, see Consequences).

## Context
ADR 0008 added `goaly-code` so goaly owns the inference path. The reason to own it is the training arc
(`WORKSPEC-sdk-harness.md`, Slices 2–5): specialize a small model to the goaly loop, cheaply and ours
to keep. The expensive part of coding-agent training is *labeling*; goaly labels every run for free,
because the frozen verifier ladder is a literal pass/fail oracle and the Sign-off approver is an
independent graded key. Two assets are needed before any training: a way to **export** each run as a
labeled trajectory, and a held-out **bench** to measure/gate models.

## Decision
Ship the Slice 2–3 **data pipeline** as a small, pure, embeddable `src/training/` module set; do NOT
ship model training itself (it needs GPU / a fine-tune endpoint).

- **`trajectory.ts`** — `exportRunTrajectory` JOINs the write-ahead run log (per-iteration ladder
  verdicts + the Sign-off decision, reconstructed by the shared `runDetail`) with the goaly-code
  session store (the actual tool-use messages) into one `TrajectoryRecord`: the conversation in our
  exact tool schema, plus the label. `passed` is `status === 'DONE'` — true only when the frozen
  ladder passed AND the approver did not veto (invariant #3).
- **`dataset.ts`** — `selectPassing` is the rejection-sampling filter (keep PASSED trajectories with a
  trajectory to learn from, optionally minimal-diff/few-iteration); `toSftJsonl` serializes them as
  OpenAI-shaped SFT examples (`{messages, tools}`) in goaly-code's tool schema.
- **`bench.ts`** — `BENCH_TASKS` is a fixed, deterministic, ladder-checkable task set; `runBench`
  (injected per-task runner) + `summarizeBench` produce pass@1 / iterations-to-converge / token cost.
  The bench is held out from any training/synthetic generation.

All three are pure functions over data (the run reader and the per-task runner are injected), so the
selection criteria and metrics are fully unit-testable with zero IO, and the live runner wires real
`composeDeps` + `drive`.

### Reward-hacking resistance is the headline property
Because the label is the frozen oracle and the approver is an independent key, a trajectory **cannot**
be labeled "good" by weakening the success criterion — the classic RL failure mode is excluded by
construction. This is what makes goaly an unusually safe RL/eval environment and is the reason the data
pipeline is trustworthy as a training signal.

### Provenance guard
Prefer trajectories generated through **our own goaly-code harness / open models** for the trainable
dataset (distilling a frontier CLI may carry ToS issues). Real-user-repo trajectories carry
privacy/licensing concerns → opt-in capture + secret scrubbing (`scrub-env` exists) before any dataset
leaves the box. The bench must stay strictly held out from all training/synthetic generation.

## Consequences
- **Positive:** every goaly-code run is now free, automatically-labeled, reward-hacking-resistant
  training data in our exact tool schema; the bench gives baseline numbers and a no-regression gate.
  Verified end-to-end live: the bench ran to pass@1, exported labeled trajectories, and produced an
  SFT JSONL — the whole generate → label → filter → dataset loop works against a real endpoint.
- **Infra-gated (NOT done here):** **Slice 3 training** — feeding the SFT JSONL to a provider FT API
  or a local LoRA (needs GPU / an FT endpoint); **Slice 4** — expert iteration / online RL with the
  ordered ladder as dense reward; **Slice 5** — a productionized, bench-gated versioned model
  (`--harness goaly-code --model goaly-coder-vN`; the harness code does not change, only the
  endpoint/model). These are deliberately separable — the harness is useful on a frontier model today,
  and the pipeline can pause/resume without blocking it.

## Alternatives considered
- **Bolt trajectory capture into the harness loop.** Rejected: the run log + session store already
  persist everything write-ahead; a pure post-hoc exporter keeps the loop lean and avoids a second
  source of truth.
- **A heavyweight experiment-tracking dependency.** Rejected: goaly ships only `zod`; JSONL + pure
  projections keep the dataset portable and the modules trivially testable.
