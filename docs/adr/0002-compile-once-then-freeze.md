# ADR 0002 — Compile the contract once, then freeze it

## Status
Accepted.

## Context
The agent authors its own verification when none exists. If it can regenerate its success
criterion each iteration, "until the goal is achieved" collapses into "until the agent weakens
the test." This is the central reward-hacking risk of the whole design.

## Decision
The verifier + rubric are **compiled once** (Phase 1, agent-driven) and then **frozen**: the
contract is content-hashed (`contractHash`) and never rewritten mid-loop. The frozen contract
is carried by reference through `LoopCtx`; the reducer has no transition that mutates it. The
`contractHash` is logged on every iteration, so an auditor can prove the bar never moved.

`--autonomous` skips the human *pause* at Seal, never the *freeze*. Autonomous mode still
compiles-then-freezes and logs the full contract loudly.

## Consequences
- "Done" means the same thing on iteration 1 and iteration N.
- The agent is told (in the prompt) not to modify the checks, but the real guarantee is
  structural: the Driver re-runs the *frozen* verifier itself; the worker's edits to test files
  can't change which command the ladder runs.
- Hashing is canonical (stable key order, sorted file lists) so cosmetically-different contracts
  with identical content hash equal.
