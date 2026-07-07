# ADR 0017 — cooperative parallel waves (`--parallel-phases`, experimental)

## Status
Accepted (experimental, opt-in).

## Context

goaly had exactly one parallelism: best-of-N (`--candidates`, issue #85) — K **competing** attempts
at the SAME sub-goal, keep one, discard the rest. What it lacked was **cooperation**: running
*different, independent* sub-goals concurrently and **combining** their work. Phased decomposition
(issue #48) already produces exactly the right unit — a frozen plan of sub-goals, each executed as
its own frozen, two-key contract, finished by a cumulative acceptance contract on the original goal
— but executes strictly sequentially, leaving wall-clock on the table whenever phases touch
disjoint parts of the tree. The plan schema explicitly deferred this ("no DAG/parallelism in v1").

The tension: combining trees is where fail-closed guarantees usually die. A merge can conflict
(textually) or lie (two clean merges that break each other semantically), and any "merge agent"
that resolves conflicts with an LLM would put unverified writes on the DONE path.

## Decision

**Waves of child runs + merge-and-reverify, fail-closed to sequential.**

1. **The plan carries the grouping, frozen.** `SubGoal` gains an optional `group`; CONSECUTIVE
   phases sharing a group form a wave. The grouping is canonicalized into `planHash` (groupless
   plans keep their legacy hash byte-for-byte), so no transition can re-shuffle it. v1 sources
   groups from `--plan-file` only.
2. **The reducer sees one command, one event.** When the current phase heads a not-yet-attempted
   group and `config.parallelPhases` is on, `startPhaseCompile` emits ONE `RUN_WAVE` (per-phase
   configs derived exactly as for sequential phases) and folds ONE `WAVE_RAN` — still exactly one
   command per state, still pure. `PhaseCtx` gains `skip` (indices completed by a wave) and `waved`
   (indices already attempted — a group can never re-fan-out), both optional so classic runs are
   untouched.
3. **Every wave member is a full goaly run.** The Driver-side `WaveRunner` gives each phase an
   ephemeral worktree off the wave-start checkpoint and an embedded `drive()` — its own compiled +
   frozen contract, iterations, ladder, veto-only Sign-off, and write-ahead log inside the
   worktree — all children on the PARENT's budget meter and interrupt probe. Worktree creation is
   sequential (git lock contention); only the runs are concurrent.
4. **Merge is plumbing; the merged tree is re-verified.** DONE children merge in phase order via
   `git merge-tree --write-tree --merge-base=<fork point>` (objects only; a conflicted merge
   applies nothing). After promotion, each merged child's frozen DETERMINISTIC rungs re-run on the
   combined tree. Judge rungs are not re-run here: each child already turned both keys in
   isolation, and the final acceptance contract still gates the whole run — the merged-tree guard
   is the ungameable deterministic bar in between.
5. **Every failure downgrades, nothing greens.** A merge conflict, a red re-verify, a child that
   never reaches DONE, a thrown wave runner, or a missing wave seam all resolve to `unmerged`,
   which the reducer turns into the CLASSIC sequential phase on the merged-so-far tree — a fresh
   frozen contract for the same sub-goal. The worst case of the feature is exactly today's
   `--phased`.

## Consequences

- **Invariants hold.** #1: the fan-out is Driver-side data flow (`RUN_WAVE`/`WAVE_RAN`); children
  are separate pure folds over separate logs. #2: grouping frozen in `planHash`; child contracts
  frozen at their own Seals. #3: two keys per child AND at acceptance. #4: a merge is never
  trusted; every failure shape is a typed downgrade. #7: `WAVE_RAN` carries the post-merge
  checkpoint tree (replay re-points the baseline like `PHASE_ADVANCED`).
- **Cost profile.** ~1× the sequential token cost (+ deterministic re-verification + any conflict
  re-runs) for wall-clock ≈ slowest child + merge — the complement of best-of-N, which buys
  quality at ~N× cost for one phase's work.
- **Experimental limits (v1), by design:** requires `--autonomous` (children seal concurrently;
  an interactive gate cannot pause K children at once); a crash mid-wave re-runs the whole wave on
  `--resume` (children live in ephemeral worktrees; their logs die with them); wave-child spend is
  bucketed under the parent's `harness` usage layer (totals and the budget cap stay exact);
  compiler-authored (git-excluded) verification files are copied from each merged child's worktree
  so their frozen commands keep their inputs — colliding authored paths across children surface as
  a red re-verify, never a silent overwrite that greens.
- **Deferred:** planner-authored groups (and the natural-language "split this across N subagents"
  directive mapping onto them), durable child logs for fine-grained wave resume, LLM-judge re-runs
  on the merged tree.
