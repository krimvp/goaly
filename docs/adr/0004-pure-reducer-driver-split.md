# ADR 0004 — Pure reducer + Driver split

## Status
Accepted.

## Context
The design demands a control flow with **zero LLM calls** — pure, debuggable, replayable — even
though the things it coordinates (running an agent, judging, approving) are all stochastic.

## Decision
Split policy from effects:

- **Orchestrator** — a pure, synchronous reducer `step(state, event) -> [state, Command[]]`. It
  is handed only data, holds no adapters, and returns no `Promise`. It therefore **cannot** call
  an LLM, read a clock, or spawn a process. "Zero LLM in control flow" is a **type-level
  guarantee**, not a discipline.
- **Driver** — the imperative interpreter that performs the `Command`s the reducer requests and
  feeds resulting `Event`s back. All fuzziness happens here, *before* an Event is built.

`detectStuck` and `DECIDE` are pure functions over the histories stored in state.

## Consequences
- The whole policy is table-testable with hand-built events and proven end-to-end with fakes and
  zero IO — before any subprocess exists.
- Replay = fold the reducer over the event stream; resume = replay + continue.
- The deletion test: remove the Orchestrator and the loop logic, DECIDE table, and stuck
  bookkeeping smear across the Driver and every call site. It earns its keep.
