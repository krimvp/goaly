# ADR 0015 — UI-owned runs: start, gate, stop, resume from the browser

## Status
Accepted.

## Context

ADR 0014 made runs observable in the browser; this decision makes them *drivable*: start a run,
answer its Seal, stop it cooperatively, resume/steer it — without a terminal. Three constraints
dominated:

1. **The trust model must be byte-identical.** The Seal is the human's say over the bar
   (invariant #5); any UI affordance that weakened it — or let the UI path drift from the CLI's
   guards — would be a regression in the product's core property, not a UI bug.
2. **The gates are interactive.** `HumanSealGate` prompts on stdin; a server has no operator
   stdin. Starting runs with `--autonomous` would sidestep the problem by *removing* the human
   from the loop — backwards for a UI whose point is putting the Seal in front of the human.
3. **Runs outlive servers.** A UI that couples run survival to its own process lifetime would be
   strictly worse than the terminal.

## Decision

### Runs execute in-process, through the ONE shared run entrypoint

The CLI's run path is extracted into `executeRun(parsed, io)` (`src/cli/run-cmd.ts`): cost table,
baseline/follow-up/resume guards, preflight, run lock, egress proxy, `composeDeps`, `drive()`,
outcome report — behind injectable IO. `main()` calls it with real stdout/stderr and signal
handlers; the UI server calls it with browser gates, a per-run stop probe, and quiet sinks. One
code path, so the UI **cannot** drift from the CLI: every guard, the lock, and the write-ahead log
are identical. Crash-safety needs nothing new — a dead server leaves each run exactly as a killed
CLI would: resumable from its log (stale run locks self-heal by pid).

In-process (not a subprocess) because the gates and the stop probe are then just function calls:
`SealGate.approveContract` is an async function, `DriverDeps.interrupted` a boolean probe. A
subprocess would need a bidirectional control protocol re-implementing both, for no gain the log
doesn't already provide.

### The browser Seal is a gate IMPLEMENTATION — `UiGates`

`composeDeps` gains injectable `sealGate`/`planGate` (the same precedent as `llm`/`observer`).
`UiGates` parks the contract/plan in server memory under a one-time `gateId` and awaits the HTTP
decision (`approve` / `revise` + required feedback / `reject` — `HumanSealGate`'s exact
semantics). The freeze, the loud `SEAL_DECIDED` log entry, and the two-key DONE are untouched.
Fail-closed edges: a stale `gateId` is refused with 409 (a double-submit can never answer a
*later* gate — after a revise, the re-presented contract parks under a fresh id); `stop()` while
parked resolves the gate to reject so the run unwinds instead of hanging on an unanswerable modal;
**an autonomous UI run keeps the classic `AutoSealGate`** — the browser gate is injected only when
the operator asked to hold the Seal.

### Stop and resume reuse the operator-control mechanics verbatim

Stop flips the run's injected `interrupted` probe — the same cooperative between-steps ABORTED as
Ctrl-C (ADR 0011), applicable only to UI-owned runs (another process's probe is unreachable; the
UI shows the `goaly --resume` hint for those). Resume builds a `--resume` invocation (note +
operational caps) and runs it through `executeRun` — the ADR 0012 extension overlay, `RUN_EXTENDED`
audit marker and all; it works for any non-live run in any root, terminal-started included. The
resume request schema **structurally has no field for the goal/verifier/rubric** — the bar is
unreachable through the UI exactly as through the CLI.

### One live run per root

Per-run locks prevent two drivers on one run directory; nothing prevented two agents editing one
working tree. The server refuses (409) to start a run in a root — the main workspace or one
worktree — where any live run holds a lock (UI-owned or terminal-driven), pointing at worktrees
(ADR 0013) as the parallelism idiom. The session registry is server memory only; everything
rendered about a run still comes from its log.

### Requests parse fail-closed, and writes need `X-Goaly-Ui: 1`

Every body is a `.strict()` Zod parse (an unknown field is a 400, never ignored — invariant #6).
On top of ADR 0014's Host/Origin guards, state-changing requests require a custom header a
cross-site form can never attach (and attaching it via fetch forces a CORS preflight the Origin
guard rejects) — defense in depth for routes that execute code.

### The UI runs force a stream transcript

UI-started runs compose with `streamTranscript: true` so their per-turn story survives a server
restart and re-renders from disk — consistent with "the disk is the source of truth". Disk-only
cost; the run log remains the state backbone.

## Alternatives considered

- **Subprocess-per-run** (`spawn('goaly', ...)`) — survives the server by default, but gates would
  need stdin puppeting or a new IPC protocol, stop would be signals, and the CLI/UI paths would be
  two codebases. Rejected: the write-ahead log already gives survival-equivalence, in-process gives
  the seams for free.
- **`--autonomous` for all UI runs** — sidesteps the gate problem by removing the human pause; the
  opposite of the feature's purpose.
- **Allowing N live runs per root** — nothing enforces tree-level safety today either, but the UI
  making it one click away demanded the explicit refusal + worktree pointer.

## Consequences

- `main()` shrank to routing + the worktree rewrite; `main.test.ts` pins `executeRun` parity.
- Embedders get `executeRun`/`makeUiActions`/`UiGates` for their own frontends.
- A UI-owned run's `run.lock` carries the server's pid (correct for liveness probes; `ps` can't
  attribute runs to it — the log is authoritative).
- The gate lives in server memory: if the server dies while a run is parked at the Seal, the gate
  dies with it and the run unwinds on shutdown (stop-all) — resumable, and the Seal re-parks on
  the resumed run.
