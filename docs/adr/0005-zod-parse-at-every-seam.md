# ADR 0005 — Zod parse-don't-validate at every seam, branded ids

## Status
Accepted.

## Context
Data entering the system is hostile or untrusted: CLI argv, config files, harness stdout
(partial/crashed/non-JSON), LLM judge output, and the run log on resume.

## Decision
No path from the outside world into the reducer skips a `parse`. Every edge has a schema:

| Edge | Schema | On failure |
|---|---|---|
| CLI args | `CliInput` → `RunConfig` | reject with usage error |
| Run config | `RunConfig` | reject |
| Harness stdout | `HarnessRunResult` (tolerant) | `status: crashed/truncated` — never throw |
| Judge / approver output | `JudgeOutput` / `ApprovalVerdict` | drop unparseable (judge) / fail-closed (approver) |
| Run log on resume | `RunLogEntry` | reject corrupt entry |

Ids are **branded** (`SessionId`, `DiffHash`, `RunId`, `ContractHash`) so a bare string can never
be passed where one is expected. `JudgeOutput` carries a `.refine` enforcing
`failing_criteria` is empty iff `pass` — the schema, not the prompt, guarantees consistency.
The Driver re-parses every Event with `OrchestratorEvent` before it reaches the reducer.

## Consequences
- Hostile harness output is a normal case, not a crash.
- The log is untrusted-on-read; a corrupt resume fails loudly instead of silently mis-replaying.
