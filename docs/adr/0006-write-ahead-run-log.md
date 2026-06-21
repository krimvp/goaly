# ADR 0006 — Write-ahead run log as the source of truth for resume

## Status
Accepted.

## Context
A crash mid-loop must not restart from iteration 0, and an auditor must be able to reconstruct
exactly what bar a run held itself to — especially in `--autonomous` mode where no human paused.

## Decision
Persist each Event **write-ahead**: the Driver appends the log entry before committing to the
next state. An entry is `{ runId, seq, ts (from the injected Clock), contractHash, event,
stateTagAfter }`; a one-time header stores the full `RunConfig`. The frozen contract is captured
in the `CONTRACT_COMPILED` event (logged loudly), so it is durable without a separate field.

Because the reducer is pure:
- **replay** = fold `step` over the event stream (apply `step` only, never `perform`);
- **resume** = parse header + entries, replay-fold to reconstruct state (sessionId, iteration,
  stuck histories), then continue — no completed iteration repeated.

## Consequences
- `ts` comes from the injected Clock, so replay is reproducible.
- The log is the single source of truth; in-memory state is always a fold of it.
- The `contractHash` repeated across loop entries is the audit proof that the bar never moved.
- Trade-off: a crash *after* an effect but *before* its append re-runs that one effect on resume
  (idempotent via session resume). We accept one repeated effect over a lost one.
