# Generic Goal-Orchestration Layer — Design

> Status: design converged, not yet implemented. This doc is a handoff for a fresh
> session to start scaffolding from.

## Goal

Build a **harness-agnostic orchestration layer** that replicates the "/goal" pattern
(run an agent repeatedly until a goal is actually achieved) on top of *any* coding
harness — Claude Code, Codex, and the author's own harnesses later.

The user wants to:
- Define a goal and indicate **how it should be verified**.
- Have the agent **author the verification** (tests/checks) when none exist — or
  **reference existing tests** when they do.
- Keep a **deterministic thin layer** in control (loop, budgets, stuck detection).
- Cap iterations to prevent runaway budget; detect when the agent is stuck.
- Support **both deterministic and LLM-judge** verification.

## Core decision: wrapper-first, hooks as an optimization

Two ways to build the outer loop:

1. **Hooks** — integrate into a harness's native event system (e.g. a `Stop` hook
   that checks the goal and injects "keep going"). Integrates best, keeps full
   context in-process, cheap. **But not portable** — every harness has a different
   hook model, or none. Hooks are *not* a common denominator.
2. **Thin orchestrator over headless mode** — an outer process spawns the harness in
   headless/print mode, reads output, evaluates the goal, re-invokes to continue.
   **Portable**: the harness becomes "a call internally."

**Decision: #2 is the architecture. Hooks are an implementation detail of a specific
adapter, not an alternative.**

The lowest common denominator across serious harnesses is stable:
- headless / print invocation (`claude -p`, `codex exec`, …)
- session resume (`--resume <id>` / `--continue`)
- structured output (`--output-format json` or similar)

Build the loop around those three. For Claude Code specifically, the adapter *may*
internally use a `Stop` hook to keep the loop in-process (preserving context, avoiding
cold restarts) — but it exposes the same interface to the orchestrator as every other
adapter. You don't choose hooks *or* wrapper; hooks live inside one adapter.

## Architecture overview

```
COMPILE_VERIFIER → [Seal: contract approval] → loop {
    RUN_AGENT → verifier ladder → [Sign-off: result approval] → DECIDE
} → DONE | FAILED | ABORTED
```

- All LLM/fuzzy work lives inside `COMPILE_VERIFIER` and `RUN_AGENT`.
- The **control flow has zero LLM calls** — pure, debuggable, replayable.
- A verifier's *internals* may be stochastic (LLM judge); the *control flow* stays
  deterministic because every verifier hides behind a boolean interface.

### Phase 1 — Compile the verifier (fuzzy, agent-driven)

Given the goal + the user's verification intent, the agent either:
- (a) **finds existing tests/commands** the user pointed at, or
- (b) **writes new ones**.

Output is a concrete, runnable **verifier** (command that exits 0/non-0, test file,
script) plus a **rubric** for any LLM-judge portion.

**Critical rule: compile once, then freeze.** The verifier + rubric are locked before
the loop starts and are *not* rewritten mid-loop. If the agent can regenerate its own
success criterion each iteration, "until the goal is achieved" collapses into "until
the agent weakens the test." This is the central anti-reward-hacking principle of the
whole design.

### Phase 2 — Execution loop (deterministic, thin layer)

`run agent → run frozen verifier → decide → repeat`.

`DECIDE` is pure (no LLM):

```
if !verifierLadder.pass        → continue (feed verifier detail back as next prompt)
if verifierLadder.pass:
    if approvalAgent.veto      → continue (feed veto reason back)
    else                       → DONE
if iterations >= maxIterations → FAILED
if stuck                       → ABORTED
```

## Verification: a ladder, cheapest-and-hardest-to-game first

```
1. deterministic checks  (tests, exit codes, lint)   → ungameable, fast
2. LLM judge             (only the fuzzy residual)    → e.g. "is the doc clearer?"
3. final approval agent  (independent, veto-only)     → last line before DONE
```

Run in order. If deterministic checks exist and fail, no judge call is spent. The LLM
judge only adjudicates what can't be reduced to an exit code.

Unified interface — the state machine doesn't know which kind it called:

```
verify(workspace, goal, rubric) -> { pass: bool, confidence, detail }
```

### Making the LLM judge "deterministic enough"

Can't be bit-for-bit deterministic, but its *standard* can be fixed and its verdict
stabilized:

- **Freeze the rubric in the compile phase** — judging criteria authored once,
  approved, frozen. The bar can't drift to meet the work.
- **Structured output** — force a schema `{pass, confidence, failing_criteria[]}`,
  no free-form "looks good."
- **Quorum, not a single call** — best-of-N (e.g. 3) majority vote + a confidence
  floor. A multi-sample quorum samples at a small **diversity temperature** (not 0) so
  best-of-N actually reduces variance instead of re-rolling the same near-deterministic
  answer N times; a single-sample (`quorum = 1`) judge stays at temperature 0 for maximal
  stability.
- **Independent from the worker** — different context (ideally different model), fed
  only goal + frozen rubric + diff + deterministic-check output, *not* the worker's
  self-justification. The grader must not be the one who did the work.

## The two approval gates

The system has **two gates**; a flag moves only one of them.

- **Seal — the contract** (frozen verifier + rubric):
  - default (`autonomous: false`): **human approves once** before the loop starts.
  - with flag (`autonomous: true`): **auto-accepted**.
- **Sign-off — the result** (per iteration): **always the independent approval agent**,
  in both modes.

### Sign-off — the final approval agent

Runs **only when the verifier ladder says pass**, and can **only veto, never promote**.

- Sees: goal, frozen rubric, full diff, all verifier verdicts.
- Job: "Is this *actually* done, or did the verifier get gamed/short-circuited?"
  Catches empty tests, tautologies, partial solutions that technically pass.
- **Defaults to reject on uncertainty** — asymmetric: a false green ends the run
  wrongly; a false red just costs one more iteration.
- On veto: emits a reason → becomes feedback for the next iteration (not a silent
  retry).

**Two independent keys must turn — the frozen verifier *and* the independent approver —
before the loop declares success.** A worker can game one; getting both is much harder.

### The `--autonomous` flag

Moves Seal only. Everything else identical.

```
false → COMPILE_VERIFIER → [human approves contract] → loop
true  → COMPILE_VERIFIER → [auto-accept contract]    → loop
```

Two rules that keep the flag honest:

1. **Autonomous still freezes the contract.** The flag skips the human *pause*, not
   the *freeze*. Otherwise autonomous mode becomes "agent rewrites its own test
   forever."
2. **Log the skipped gate loudly.** When auto-accepted, persist the full
   verifier+rubric to the run log so a human can audit after the fact what bar the run
   held itself to.

Human/agent division of labor (default mode): human confirms the **contract** once
(what "done" means — irreplaceable judgment); the agent confirms each **result**
against that frozen contract (the repetitive "did we hit it this time").

## Stuck detection

`maxIterations` is the blunt backstop. Bail *before* it when:

- **No-diff** — working-tree hash unchanged after an iteration → spinning.
- **Repeat-failure** — normalized verifier output identical N times → same wall.
- **Oscillation** — diff hash cycles between two states → flip-flopping.
- **Budget** — token/time cap independent of iteration count.

Each fires `ABORTED` with a reason (so an outer wrapper or human can decide whether to
escalate).

## The adapter contract (harness-agnostic)

Each harness gets a thin adapter implementing one method:

```
run(prompt, sessionId?) -> { output, sessionId, status, diffHash }
```

- `diffHash` — working-tree/tree hash (e.g. `git stash create` or a tree hash),
  trivial and harness-independent; the loop needs it for stuck detection.
- **Verifier execution is outside the adapter** — it's just "run this command in the
  workspace," identical on every harness.

The orchestrator (goal eval, iteration cap, stuck detection) never knows which harness
it's talking to.

## Run config

```
{
  goal,
  verifier: { kind: existing | generate, ref? },
  rubric,                  // frozen after compile (for LLM-judge portion)
  autonomous: false,       // flag; gates contract approval (Seal) only
  maxIterations,
  budget,                  // tokens / time
  stuckPolicy              // thresholds for no-diff / repeat / oscillation / harness-crash
}
```

## Perks worth building in early (cheap now, painful to retrofit)

- **Run log / replay** — persist each iteration's prompt, output, verifier result,
  diffHash, approval verdicts. Debugging + audit + resume.
- **Resumable** — keep `sessionId` + iteration count so a crash doesn't restart from
  zero.
- **Structured config** per run (above).

## Open / future considerations

- Output parsing robustness: headless output isn't always clean JSON. Treat partial
  output, crashes, parse failures as normal cases.
- Session-resume quality varies by harness — measure per adapter (this is where the
  Claude Code in-process hook path wins).
- Independent verifier authoring (different prompt/model from the executor) to further
  reduce reward-hacking risk.

## Suggested first build

Scaffold the deterministic core:
1. State machine (`COMPILE_VERIFIER → gate → loop → DECIDE`).
2. Config schema.
3. Adapter interface (`run()` contract).
4. One reference adapter: **Claude Code headless**.

Then layer in the verifier ladder and the two gates.
