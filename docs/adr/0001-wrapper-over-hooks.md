# ADR 0001 — Wrapper over hooks

## Status
Accepted.

## Context
Two ways to build the outer loop: integrate a harness's native event system (e.g. a Claude
Code `Stop` hook) or spawn the harness headlessly from a thin outer process. Hooks integrate
best and keep context in-process, but every harness has a different hook model — or none. They
are not a common denominator.

## Decision
The architecture is a **thin orchestrator over headless mode**. The lowest common denominator
is stable across serious harnesses: headless/print invocation, session resume, structured
output. A harness becomes "a call internally" behind `run(prompt, sessionId?) -> RunResult`.

Hooks are an **implementation detail of a single adapter**, not an alternative architecture.
Claude Code's adapter *may* internally use a `Stop` hook to keep the loop in-process, but it
exposes the same `run()` interface as every other adapter. Hooks never leak to the orchestrator.

## Consequences
- A new harness is one file implementing one method; nothing else changes.
- `diffHash` and verifier execution live in the shared Workspace, identical on every harness.
- We give up some in-process efficiency on harnesses without a hook fast-path — acceptable for
  portability, and recoverable per-adapter.
