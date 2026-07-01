# ADR 0011 — reliability hardening: fail closed, but don't fail eagerly

## Status
Accepted.

## Context

A full reliability & usability review of the runtime path (subprocess spawns, HTTP/LLM calls,
the run log, resume, signals, and the first-run experience) found a consistent shape: goaly's
**soundness** was excellent — nothing anywhere could fabricate a green, every seam parsed with Zod
and failed closed — but the system converted **transient** failures into **terminal** outcomes too
eagerly, and the most common **first-run mistakes** surfaced late as cryptic internals. Concretely:

1. **Retry asymmetry.** The OpenAI-compatible transport was the only place with retries. The
   CLI-backed `LlmProvider` (which backs the compiler / judge / approver on the DEFAULT
   `--llm-provider claude` path) threw on the first non-zero exit; a judge-quorum sample that threw
   discarded its already-successful siblings; a crashed harness turn went straight to the stuck
   streak. With `stuckCrashThreshold`/`stuckUnevaluableThreshold` defaulting to 2 and **no backoff
   anywhere in the loop**, a ~2-second provider blip could abort an hours-long run.
2. **The one unguarded hang.** `--verify-timeout-ms` defaulted to *unbounded*: a verify command
   that hung (test awaiting the network, spawned server that never exits) hung the run forever.
   Relatedly, agent-CLI subprocesses were killed alone on timeout — a spawned tool holding the
   inherited stdio pipes could keep `close` from firing and hang the run past its own cap.
3. **The write-ahead log rejected its own crash.** `FileRunLog.read()` threw on any unparseable
   line. But the one failure the WAL exists for — a crash/power-loss **mid-append** — leaves
   exactly that: a torn, unterminated final line. The result: the run became unreadable
   (`runs show`) *and* unresumable (`--resume`), i.e. the durability feature rejected the scenario
   it was built for.
4. **No concurrency guard.** Two goaly processes on one run dir (double `--resume`, resuming a
   live run) interleaved appends with duplicate `seq` values — logical corruption with no error
   until much later.
5. **Budget amnesia on resume.** The live `SystemBudgetMeter` started from zero every process;
   `--budget-tokens` capped each *process*, not the *run* — repeated resumes could overshoot the
   cap arbitrarily.
6. **Ctrl-C was a cliff.** No signal handling: the process died with no breadcrumb (the run id
   lived only in a log line), group-spawned children could outlive goaly, and nothing told the
   user `--resume` existed.
7. **First-run failures were late and cryptic.** A missing harness CLI = three identical
   `spawn ENOENT` compile retries then `COMPILE_FAILED`; a non-git workspace = a full compile +
   agent turn, then `driver error: git add -A failed (code 128)`; a stdin-fed goal without
   `--autonomous` = a deadlocked Seal prompt (documented only in a note).
8. **Silent data loss in goaly-code sessions.** The session store rewrote the whole message log in
   place, unfsync'd, every turn; a crash mid-write truncated it and the fail-closed `load()`
   silently degraded the WHOLE conversation to a fresh session.

## Decision

Adopt one policy across the runtime: **fail closed on judgment, absorb blips on transport, and
front-load user-fixable errors.** A wrong green stays impossible (nothing in this ADR touches the
two-key DONE, the frozen contract, or fail-closed classification); what changes is *when* a failure
is allowed to end a run and *how* it is reported.

### 1. Bounded retries at every transport, never at a judgment
- `OpenAiClient`: exponential backoff (500 ms · 2ⁿ) and `Retry-After` honored on 429/5xx, capped at
  60 s (a hostile/buggy header must not stall the run).
- `AgentCliLlmProvider`: 2 retries with linear backoff on a non-zero exit or unparseable output.
  After the last attempt it still **throws** — the caller's fail-closed handling (veto /
  unevaluable red / typed failure) is unchanged.
- `JudgeVerifier`: each quorum sample individually guarded; a thrown sample drops that sample only.
  Zero surviving samples remain a fail-closed unevaluable red.
- Driver `RUN_AGENT`: ONE retry of a `crashed` harness turn after a 2 s backoff, **before** the
  event reaches the reducer. Retrying is an *effect policy*, so it lives in the Driver; the
  reducer, the stuck detectors, and the run-log semantics are untouched — a crash that survives the
  retry counts toward `stuckCrashThreshold` exactly as before.
- **Timeouts are never retried**, anywhere. A wall-clock cap is the run's own guard; silently
  doubling it would defeat it. (This is the deliberate line between "blip" and "wall".)

### 2. No unbounded hangs
- `--verify-timeout-ms` defaults to 10 minutes (`DEFAULT_VERIFY_TIMEOUT_MS`), matching the harness
  and LLM steps. A hit is a fail-closed could-not-evaluate (`evaluable: false`), so the
  `CONTRACT_UNEVALUABLE` machinery — not a fake red — governs a persistent hang.
- All agent-CLI execs (harness, read-only LLM, sandboxed) spawn detached and **group-kill** on
  timeout, so no descendant can hold the stdio pipes open. `runProcess` tracks live children;
  `killActiveChildren()` reaps them on a forced shutdown.

### 3. The write-ahead log tolerates exactly its own crash
- An **unterminated** final line is a torn append whose fsync never returned — the corresponding
  state transition never became durable. `read()` drops it (write-ahead semantics: resume simply
  re-performs that one effect, at-least-once as designed); `append()` truncates it first so it can
  never fuse with the next entry. A **terminated** line that fails to parse is real corruption and
  still throws (invariant #6). Only the writer repairs; `read()` stays read-only so a concurrent
  `runs show` never mutates a live log.
- A per-run `run.lock` (pid-stamped, `wx`-created) makes concurrent drivers impossible. A live
  holder fails closed with a clear message; a dead holder's lock self-heals — a crashed run never
  needs manual cleanup.
- goaly-code session saves are atomic (`tmp → fsync → rename`): the previous complete log survives
  any crash mid-save.
- `drive()`'s pre-loop IO (resume read, header write) resolves to a typed `ABORTED` — the last
  rejection path out of the Driver is gone (invariant #4, now without exceptions).

### 4. Interrupts are first-class, budgets are per-run
- First SIGINT/SIGTERM: cooperative stop *between steps* — the in-flight step completes and
  persists, the outcome is a typed `ABORTED` naming `--resume <runId>`, exit code `130`. Second
  signal: immediate exit after `killActiveChildren()`. The startup banner prints the run id and
  resume command up front, so the breadcrumb exists even for a hard kill.
- On `--resume`, prior token spend is folded from the log and re-armed into the live meter:
  `--budget-tokens` caps the run. **Wall-clock deliberately restarts per process** — the
  crash-to-resume gap is idle time, not spend, and instantly aborting an old-but-healthy resumed
  run would be the worse failure mode.

### 5. Fail fast on what only the user can fix
- A millisecond preflight before any spend: workspace is a git work tree; the `--harness` and
  `--llm-provider` CLIs exist on PATH (skipped for `fake` — its purpose is zero-external-tool
  runs). Each failure names the exact fix. `--resume` of a missing/corrupt run and a stdin-fed goal
  without `--autonomous` fail closed up front with the same spirit.
- Terminal outcomes carry an always-on one-line `next:` hint mapping the typed reasons
  (`STUCK_*`, `CONTRACT_UNEVALUABLE`, `TOOLS_MISSING`, budget, `maxIterations`, …) to the exact
  next command — the zero-cost, non-LLM complement to `--explain`.

## Consequences

- A short provider/network outage now costs seconds of backoff instead of an aborted run; a
  persistent failure terminates through the same typed paths as before (retries absorb blips,
  stuck detection governs walls). Worst-case added latency per iteration is bounded (one 2 s
  crash-retry + the provider's own bounded backoff).
- A kill/power-loss at ANY byte offset of the run log leaves a readable, resumable run. The
  corrupt-log tests distinguish torn-tail (tolerated) from terminated-corrupt (rejected).
- `--budget-tokens` is a real whole-run invariant. Wall-clock stays per-process by decision.
- New-user failure modes produce instructions, not stack traces; interrupting a run teaches the
  resume feature instead of hiding it.
- The reducer is untouched: every change here is Driver/adapter/transport/CLI wiring, so purity,
  the frozen contract, and the two-key DONE are preserved by construction.

## Reviewed and deferred (with reasons)

Recorded so future work starts from the audit, not from scratch:

- **Planner retry under `--phased`** (a transient `PLAN_FAILED` is terminal, unlike compile's
  retry ladder). Deferred: the provider-level retries added here already absorb the transient
  causes; a `maxPlanRetries` mirror of `maxCompileRetries` is the natural follow-up.
- **Best-of-N candidate crash-retry.** The tournament tolerates individual candidate failures by
  scoring the survivors; a per-candidate retry adds cost for little gain.
- **Retry for `workspace.checkpoint()` / phase-boundary git blips** (index-lock contention).
  Deferred: `--resume` already recovers cleanly; a bounded git retry helper is a small follow-up.
- **Orphaned worktree / temp-index pruning on startup** after a hard kill mid-tournament
  (`git worktree prune`-style sweep). Cruft, not corruption.
- **Workspace dirty-tree restore on resume** (re-running an interrupted `RUN_AGENT` happens on top
  of the crashed turn's partial edits). Accepted as the documented at-least-once model — the
  harness session-resume keeps it idempotent in practice; a pre-turn checkpoint/restore would
  change user-visible semantics and needs its own design.
- **Auto-excluding `.goaly/` via `.git/info/exclude`** (the manual README step, inconsistent with
  authored-file handling). Pure convenience; small follow-up.
- **Prominent stderr banner for the autonomous single-model self-judge collapse** (today a
  `logger.warn`). Worth doing alongside a broader look at model-independence defaults.
- **`Retry-After` HTTP-date form** (only delta-seconds is parsed; date form falls back to the
  client's own backoff — fail-open by design).
