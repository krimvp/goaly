# Goal-Orchestration Layer — Architecture Plan

> Companion to [`DESIGN.md`](DESIGN.md). DESIGN.md says *what* to build and *why*;
> this doc says *how* to structure it — deep modules, real seams, validation at every
> edge, and a TDD build order. Implementation target: **TypeScript/Node**, run under
> **WSL/Linux**. Start from a clean repo root.

## Context

DESIGN.md specifies a **harness-agnostic orchestration layer**: run a coding agent
repeatedly until a goal is *verifiably* achieved, with a deterministic thin layer in
control and a frozen success criterion the agent can't weaken mid-loop (the
anti-reward-hacking core). The design has converged conceptually but has **zero
implementation**.

This plan turns the spec into a **deep-module architecture** (Matt Pocock's
`codebase-design` vocabulary: Module / Interface / Implementation / Seam / Adapter /
Depth) with **runtime validation at every seam** (Zod), so that:

- the tool is **easy to use** — a `goalorch` CLI over a clean embeddable core;
- **adding a new harness is trivial** — implement one method (`run()`) and register the
  adapter; nothing else changes;
- the control flow is **pure, replayable, and table-testable** — no LLM call can sneak
  into the loop logic.

Confirmed decisions: **TypeScript/Node**, **CLI-first with a library core**, first
adapters **Claude Code + Codex** (plus a fake for tests), **Zod** for all validation,
executed under **WSL/Linux**.

## The shape in one breath

One deep module owns **all policy** — the **Orchestrator**, a *pure reducer*
(`step(state, event) -> [state', Command[]]`). A thin imperative **Driver** performs the
effects the reducer requests. Everything stochastic (running the agent, judging,
approving) hides behind boolean/value interfaces at **four real seams**. The reducer
never calls an LLM, never reads a clock, never spawns a process — which is exactly what
makes the whole run replayable from the log.

```
   Driver (effects: clock, budget, IO, persistence)
     │  performs Commands, feeds back Events
   Orchestrator  ── pure step(state,event) → [state, Command[]] ──  ZERO LLM, ZERO IO
     │ Commands ↓
   ┌──────────┬──────────┬──────────┬───────────┐
   Harness    Verifier   Approver   Compiler+GateA
   Adapter    Ladder     (Gate B)
   (seam#1)   (seam#2)   (seam#3)
   CC/Codex   det/judge  agent      + Clock/Budget (seam#4, injected into Driver)
   /Fake      /Fake      /Fake
```

## Module decomposition (deep modules + seam reality)

| Module | Small interface | Large implementation hidden | Seam? |
|---|---|---|---|
| **Orchestrator** | `step(state,event)->[state,Command[]]`, `initial(config)` — *pure, sync* | whole COMPILE→GateA→loop→DECIDE graph, iteration count, stuck bookkeeping | the spine |
| **Driver** | `drive(deps,config)->RunOutcome` | command interpreter, write-ahead persist, crash→Event, budget polling | — |
| **HarnessAdapter** | `run(prompt, sessionId?)->RunResult` | flag dialects, JSON parsing, session resume, CC's optional Stop-hook fast-path | **#1 REAL** (CC, Codex, Fake) |
| **Verifier / Ladder** | `verify(ws,goal,rubric)->Verdict` | shell/exit-code, test runs, LLM quorum judge; ladder *is* a Verifier (composite) | **#2 REAL** (det, judge, Fake) |
| **Approver (Gate B)** | `review(input)->ApprovalVerdict` (veto-only) | independent approval agent, reject-on-uncertainty bias, ideally different model | **#3 REAL** (agent, Fake) |
| **VerifierCompiler** | `compile(goal,intent)->CompiledContract` | finds/writes tests, authors rubric, emits runnable spec; **freezes once** | (agent, Fake) |
| **ContractGate (Gate A)** | `approveContract(c)->GateDecision` | human CLI prompt vs auto-accept + loud audit log | (Human/Auto/Fake) |
| **Clock / BudgetMeter** | `now()`, `spent()/remaining()` | system time/token metering | **#4 REAL** (System, Manual) |
| **Workspace** | `diffHash()`, `run(cmd)` | git tree hash, command exec — *harness-independent* | (Git, Fake) |
| **RunLog** | `append(entry)`, `replay()->state` | write-ahead persist + pure replay-fold | (File, InMemory) |

Every seam has **≥2 adapters** → all real, none mere indirection. **Deliberately not a
seam:** the LLM *provider* inside the judge/approver — it varies *inside* those modules,
not across the `Verifier` interface, so it stays an internal seam (don't leak internal
seams through the interface).

**Deletion test (the core):** delete the Orchestrator and the loop logic + DECIDE truth
table + stuck bookkeeping smear across the Driver and every call site. It earns its keep —
it *is* the product's intelligence.

## Why adding a harness is trivial (the "thin adapter" requirement)

A new harness = **one file** implementing one method:

```ts
interface HarnessAdapter {
  run(prompt: string, sessionId?: SessionId): Promise<RunResult>;
}
type RunResult = {
  output: string;
  sessionId: SessionId;
  status: 'completed' | 'crashed' | 'truncated' | 'timeout';
  diffHash: DiffHash;            // computed by the shared Workspace, NOT the harness
};
```

Implement `run` (spawn the headless command, parse its JSON tolerantly, thread the session
id), register it. The orchestrator can't tell which harness it called — so nothing else in
the system changes. `diffHash` and verifier execution live *outside* the adapter, identical
everywhere, so stuck-detection works on any harness for free. Claude Code's in-process
`Stop`-hook optimization lives **inside its adapter only**, behind the same `run()` — hooks
never leak to the orchestrator (DESIGN's "wrapper-first, hooks as an optimization").

## The Verifier unification

`verify(workspace, goal, rubric) -> {pass, confidence, detail}` is satisfied by three
behaviours the state machine can't distinguish:

1. **DeterministicVerifier** — runs a command; `pass = exitCode===0`, `confidence=1`.
   Ungameable.
2. **JudgeVerifier** — temp-0 LLM, best-of-N quorum + confidence floor, Zod-parsed
   structured output. Only adjudicates the fuzzy residual.
3. **The Ladder** — itself a `Verifier` (composite); runs rungs cheapest-first and
   **short-circuits** on the first deterministic fail (no judge call wasted). A rung that
   errors is **fail-closed** (`pass:false`) — a malformed grader is never a green.

The **Approver (Gate B)** is verdict-shaped but a *separate seam*: veto-only, fed
independent inputs (goal + frozen rubric + diff + verdicts, **not** the worker's
self-justification). DONE requires **two keys**: the frozen verifier passes *and* the
independent approver doesn't veto.

## State machine (pure, zero-LLM-by-construction)

Discriminated-union state, pure synchronous reducer, effects requested as data `Command`s:

```ts
type OrchestratorState =
  | { tag: 'COMPILING'; config } | { tag: 'AWAIT_GATE_A'; contract }
  | { tag: 'RUNNING_AGENT'; ctx } | { tag: 'VERIFYING'; ctx; lastRun }
  | { tag: 'AWAIT_GATE_B'; ctx; ladder } | { tag: 'DECIDING'; ctx; signals }
  | { tag: 'DONE' } | { tag: 'FAILED'; reason } | { tag: 'ABORTED'; reason };

// LoopCtx carries the FROZEN contract by reference + diffHash/failure histories
// for stuck-detection.
```

**DECIDE** is the DESIGN truth table, pure:

```
if !ladderPass                      → continue (feed verifier detail back)
if ladderPass && gateB.veto         → continue (feed veto reason back)
if ladderPass && gateB.approve      → DONE          (two keys turned)
if iteration >= maxIterations       → FAILED
if detectStuck(ctx) !== null        → ABORTED (no-diff | repeat-failure | oscillation | budget)
else                                → continue
```

**Zero-LLM is structural, not disciplinary:** `step` returns no `Promise` and is handed no
adapters — only data. It *cannot* call an LLM. All fuzziness already happened in the Driver
before the `Event` was built. `detectStuck` is pure over the histories stored in state.

## Validation strategy (Zod, parse-don't-validate at every edge)

No path from the outside world into the reducer skips a `parse`. Branded ids are nominal:

```ts
const SessionId = z.string().min(1).brand<'SessionId'>();
const DiffHash  = z.string().regex(/^[0-9a-f]{7,64}$/).brand<'DiffHash'>();
// RunId, ContractHash similar
```

| Edge | Schema | On failure |
|---|---|---|
| CLI args | `CliInput` (coerce/enums) → `RunConfig` | reject with usage error |
| Run config file | `RunConfigSchema` (verifier discriminated union, budget, stuckPolicy) | reject |
| **Harness stdout JSON** (hostile) | `HarnessOutputSchema.safeParse` | **don't throw** → `status:'truncated'/'crashed'` so the reducer treats it as a failed run |
| LLM judge / approver output | `JudgeOutputSchema` / `ApprovalVerdictSchema` per quorum sample | drop unparseable (judge) / fail-closed (approver) |
| Run log on **resume** | `RunLogEntrySchema.parse` (log is untrusted-on-read) | reject corrupt entry |

`JudgeOutputSchema` is `{pass, confidence∈[0,1], failing_criteria[]}` with a `.refine` that
`failing_criteria` is empty iff `pass` — schema-enforced consistency.

## Run log / replay / resume

Write-ahead: persist each event **before** feeding it to `step`. Entry =
`{runId, seq, ts(from injected Clock), contractHash, event, stateTagAfter}`; a one-time
header stores the full `RunConfig` + frozen `CompiledContract` (logged **loudly** in
`autonomous:true` — "log the skipped gate loudly"). Because the reducer is pure,
**replay = fold over the event stream**; **resume = parse header + entries, replay-fold to
reconstruct state (incl. sessionId, iteration, stuck histories), continue** — no work from
iteration 0 repeated.

## Directory layout & build order

```
packages/core/src/
  domain/    ids.ts config.ts contract.ts verdict.ts events.ts   (types + Zod schemas)
  orchestrator/  state.ts step.ts decide.ts stuck.ts             (PURE — the spine)
  driver/    driver.ts clock.ts budget.ts                        (effects, seam #4)
  verify/    verifier.ts deterministic.ts judge.ts approver.ts   (seam #2, #3)
  compile/   compiler.ts gateA.ts                                (Phase 1 + freeze)
  harness/   adapter.ts claude-code.ts codex.ts fake.ts          (seam #1)
  workspace/ workspace.ts        runlog/ runlog.ts
packages/cli/src/main.ts         CONTEXT.md  docs/adr/
```

> A single-package start (core under `src/`, CLI isolated in `src/cli/` importing only
> core) is an acceptable simplification for the walking skeleton; split into workspaces
> once the core stabilizes. Suggested toolchain: `tsx` for dev, `vitest` for tests,
> strict `tsconfig` (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
> `verbatimModuleSyntax`).

**TDD walking-skeleton order (red→green, one vertical slice at a time — not
all-tests-first):**

1. Domain + Zod schemas (ids, config, verdict, events) — establishes the ubiquitous language.
2. **Pure reducer + DECIDE + stuck** — table-tested with hand-built events, no adapters.
3. Fakes (FakeHarness/Verifier/Approver/Gate, ManualClock, InMemoryRunLog, FakeWorkspace).
4. **Driver** wiring fakes → first full end-to-end loop test with **zero IO** ("scripted
   pass on iter 3, one veto → DONE on iter 4"). **Walking skeleton complete — whole policy
   proven before any subprocess.**
5. RunLog file persistence + replay/resume (crash → reconstruct → continue).
6. DeterministicVerifier + GitWorkspace (first real IO: exit codes, real diffHash).
7. **ClaudeCodeAdapter** (reference adapter; internal Stop-hook path behind the same interface).
8. JudgeVerifier + AgentApprover (quorum, temp 0, Zod-parsed output).
9. VerifierCompiler + Gate A (authoring + freeze + loud logging).
10. **CodexAdapter** — proves the seam is real, flushes out any leaked Claude-isms.
11. `goalorch` CLI — thin caller; the library already works headless.

Building the fake-driven loop (steps 1–4) before any real adapter means the entire control
policy is proven correct before a single subprocess is spawned — the deterministic core
DESIGN's "Suggested first build" calls for.

## Domain language & ADRs to record

Create `CONTEXT.md` (glossary only) with the ubiquitous terms: **Goal, Contract, Verifier,
Rubric, Verdict, Ladder, Gate A / Gate B, Two Keys, Harness, Adapter, Driver, Orchestrator,
DECIDE, diffHash, Stuck, Autonomous** (each with an "avoid:" list, e.g. Harness ≠
model/agent).

Record these ADRs (each hard-to-reverse, surprising, a real trade-off):

- **0001** Wrapper over hooks (portable headless `run()`; hooks are an in-adapter optimization).
- **0002** Compile-once-then-freeze the Contract (the anti-reward-hacking core).
- **0003** Two-key approval (frozen verifier + independent veto-only approver).
- **0004** Pure reducer + Driver split → zero-LLM-in-control-flow as a *type-level* guarantee.
- **0005** Zod parse-don't-validate at every seam, branded ids.
- **0006** Write-ahead run log as the source of truth for resume.

## Verification (how we'll know it works)

- **Unit/table tests** (`vitest`): DECIDE truth table and each stuck detector (no-diff,
  repeat-failure, oscillation, budget) over hand-built `LoopCtx` — pure, instant.
- **End-to-end loop tests with fakes, zero IO**: scripted harness/verifier/approver drive
  the Driver through full runs — assert DONE/FAILED/ABORTED, iteration counts, and that the
  run log shows the `contractHash` unchanged every iteration (proves the bar never moved).
- **Resume test**: kill a run mid-loop, reconstruct from the log, assert it continues
  without repeating completed iterations.
- **Adapter contract tests**: run the *same* scenario suite against ClaudeCode, Codex, and
  Fake adapters — identical orchestrator behaviour proves the seam is genuinely
  harness-agnostic.
- **Real smoke run**: `goalorch run --goal "..." --autonomous --max-iterations 5` against a
  tiny real repo with a trivial deterministic verifier (e.g. `npm test`), confirming a real
  Claude Code session compiles a contract, loops, and exits DONE with a complete run log.
