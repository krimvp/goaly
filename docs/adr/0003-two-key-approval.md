# ADR 0003 — Two-key approval

## Status
Accepted.

## Context
A single success signal is gameable. A worker can write an empty test, a tautology, or a
partial solution that technically makes a command exit 0.

## Decision
DONE requires **two independent keys** to turn:

1. The **frozen verifier ladder** passes (deterministic checks first, then any LLM judge).
2. The independent **Approver** (Gate B) does **not** veto.

The Approver is a separate seam, not another verifier. It runs **only when the ladder passes**,
can **only veto** (never promote), and is fed independent inputs — goal, frozen rubric, full
diff, all verifier verdicts — **not** the worker's self-justification. It **defaults to reject on
uncertainty**: a false green ends the run wrongly; a false red costs one more iteration. On
veto it emits a reason that becomes the next iteration's feedback (not a silent retry).

## Consequences
- Gaming one key is plausible; gaming both — a frozen ungameable check *and* an independent
  skeptic — is much harder.
- The Approver should ideally use a different model/context from the worker.
- Fail-closed: an approver that errors is treated as a veto, enforced at the Driver seam.
