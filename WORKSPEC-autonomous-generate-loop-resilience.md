# Work spec — agent-loop & self-judge resilience for autonomous `--generate` runs (follow-ons E–H)

> **Status:** scoped / ready to implement. Companion to
> [`WORKSPEC-autonomous-generate-prepare.md`](WORKSPEC-autonomous-generate-prepare.md) (items A–B,
> the *prepare-phase* fixes). This doc covers the **later** failure modes a 9-model autonomous
> `--generate` bake-off surfaced *after* the prepare phase — they are not addressed by A/B.
> **Self-contained:** a fresh session can implement from this doc alone.
> **Together with A/B these close most of the A↔B gap** (see §0).

---

## 0. Context (read first)

A 9-model bake-off ran the **same hard from-scratch goal** (a Go stdlib-only MCP server for a co-op
Minesweeper game + live UI) two ways:
- **Round A** — hand-written deterministic `--verify-cmd` gate (build + run + probe). **7/9 DONE.**
- **Round B** — `--generate --autonomous` (model self-authors + self-judges its bar). **1/9 DONE** (opus).

Round B breakdown: **5/9 died before writing code** in the prepare/compile phase (→ items A–B in the
companion doc), and the rest revealed **new** modes this doc addresses:

| model | Round B outcome | new mode (this doc) |
|---|---|---|
| glm-5.2 | ABORTED `no-diff` | agent `truncated` (hit turn cap) + wrote nothing → no-diff abort → **E, F** |
| kimi-k2.7-code | ABORTED `no-diff` | built 1050 LOC, then last turn `truncated` + no-diff → **E, F** |
| gpt-oss:120b | ABORTED `no-diff` | built 484 LOC, then `completed` no-diff vs its **own** judge → **H** |
| sonnet | FAILED | **3× `COMPILE_FAILED` = LLM timeouts** (then `CONTRACT_UNSOUND` → covered by B) → **G** |

Verbatim evidence (for the implementer):
- glm: `agent ran ... status=truncated changed=false tokensSpent=582645` (then `verified pass=false` →
  `no-diff: working tree unchanged after an iteration`).
- kimi: `agent ran ... status=truncated changed=false tokensSpent=1093467` → `no-diff`.
- gpt-oss: `agent ran ... status=completed changed=false tokensSpent=1653293` → `no-diff` (ladder red on
  its self-authored judge rung).
- sonnet: `compile failed ... reason=LLM CLI cli:claude timed out` **×3**, at exactly 10-min intervals
  (= the default `--llm-timeout-ms` of 600000).

**Synergy:** A+B let the 5 prepare/compile deaths reach the loop (they built fine in Round A); **E+F**
give the truncated runs room to finish; **H** breaks the self-judge stall. Implementing all of them
should convert most of the 9 to DONE.

---

## Item E — expose the goaly-code agent turn cap as a CLI flag *(implement)*

**Problem.** glm and kimi ended `truncated` — they hit the goaly-code loop's per-run turn cap
(`DEFAULT_GOALY_CODE_MAX_TURNS = 50`, `src/goaly-code/harness.ts`). For a hard task with a long
self-authored contract in context, 50 turns is too few (glm spent 582k tokens / 50 turns and never
produced a usable diff; kimi built a server then ran out mid-iteration). The cap is settable **only**
by an embedder today: `ComposeOptions.goalyCodeMaxTurns` (`src/cli/compose.ts:157`, threaded to
`SdkHarness({ maxTurns })` at `compose.ts:585`). There is **no CLI flag**, so a user running `goalyd`
cannot raise it.

**Fix.** Add a CLI flag — proposed `--max-agent-turns N` — wired:
`args.ts` (parse + `ParsedArgs.maxAgentTurns?: number` + usage text) → `main.ts` (pass through) →
`composeDeps({ goalyCodeMaxTurns })`. Validate as a positive integer at the Zod/arg seam (invariant
#6). Default unchanged (50). Only the **goaly-code** harness consumes it (codec harnesses manage their
own turn budgets — note this in the flag help). Document that hard from-scratch tasks may want
100–200.

**Files.** `src/cli/args.ts`, `src/cli/main.ts`, `src/cli/compose.ts` (already accepts the option),
README (usage table) + `docs/index.html` if it lists harness flags.

**Tests.** `args` parses `--max-agent-turns 120` → `maxAgentTurns: 120`; rejects non-positive/non-int;
`compose.goaly-code.test.ts` asserts it threads to the harness (behavioral; `src/cli/**` is
coverage-excluded so test behaviorally).

**Invariants.** Pure wiring; never enters the contract; harness-quality only. Safe.

**Acceptance.** `goalyd run … --harness goaly-code --max-agent-turns 150 …` runs the agent with a
150-turn cap; a hard task that previously `truncated` at 50 gets the extra runway.

---

## Item F — excuse a no-diff iteration after a `truncated` agent run *(implement)*

**Problem.** `noDiffExcusedByRun` (`src/orchestrator/stuck.ts:63`) excuses a no-diff iteration only when
`ctx.lastRunStatus === 'timeout' || 'crashed'` — a run that was killed "never got a fair chance to
edit." But a **`truncated`** run (the agent hit its turn/wall-clock cap mid-work) is the same spirit
and is **not** excused, so glm/kimi aborted with `no-diff` immediately after being capped, instead of
getting another iteration.

**Fix.** Add `'truncated'` to the excused set in `noDiffExcusedByRun`:
```ts
return ctx.lastRunStatus === 'timeout' || ctx.lastRunStatus === 'crashed' || ctx.lastRunStatus === 'truncated';
```
Update the comment to explain: a truncated turn was cut off by the turn cap, like a timeout, so a
no-diff on that iteration must not be read as "stuck." The loop is still bounded by `--max-iterations`
and the budget (unchanged), so a model that is *perpetually* truncated-with-no-diff (e.g. glm wrote
nothing across 50 turns) still terminates — at `maxIterations`/budget, the correct backstop, rather
than a premature no-diff abort at iteration 1.

**Files.** `src/orchestrator/stuck.ts` (one line + comment); `src/orchestrator/stuck.test.ts` (table
case: `lastRunStatus: 'truncated'` + no diff ⇒ NOT `no-diff` stuck; regression: a `completed` run +
no diff ⇒ still `no-diff` stuck).

**Invariants.** Pure, synchronous reducer change (invariant #1); stuck detection stays pure over
`LoopCtx` (#8). It only *delays* an early exit; no wrong-green possible (the two keys still gate DONE).
Pairs with E (more turns) so the extra iterations are actually productive.

**Acceptance.** A goaly-code run whose agent `truncated` without a net diff on an iteration is **not**
aborted as no-diff; it gets another iteration (until `--max-iterations`/budget). glm/kimi-style early
aborts disappear.

> Note: this supersedes the "out-of-scope §6 no-diff" note in the companion doc — that note worried
> about a *first-iteration* no-diff; the real, observed trigger is a **`truncated`** prior run, which F
> handles precisely and minimally.

---

## Item G — surface LLM-timeout cause on `COMPILE_FAILED` *(optional / mostly config)*

**Problem.** sonnet's three `COMPILE_FAILED`s were **LLM timeouts** (`reason=LLM CLI cli:claude timed
out`), 10 min apart = the default `--llm-timeout-ms` (600000). The contract-authoring (compiler) call
exceeded the LLM-step timeout under parallel load, and the compile-retry loop re-issued the same heavy
call which timed out again — burning retries on a transient infra limit, not a model mistake.

**Fix (small + config).**
1. **Surface the cause + remedy.** When a `COMPILE_FAILED` reason indicates a timeout, append an
   actionable hint: "the verification-authoring LLM call timed out — raise `--llm-timeout-ms` (current
   default 600000) for large/parallel authoring." (Mirrors the existing setup exit-127 hint in
   `prepare.ts:133`.) The compiler error flows through `AgentCompiler.compile` → the `COMPILE_FAILED`
   event reason (`src/compile/agent-compiler.ts`, `src/domain/events.ts`).
2. **(Optional)** Consider not counting a *timeout* the same as a *parse-failure* against
   `--max-compile-retries`, or escalating the per-attempt timeout on retry — re-issuing an identical
   timing-out call rarely helps. Keep simple; the config bump is the primary remedy.

**Files.** `src/compile/agent-compiler.ts` and/or wherever the `COMPILE_FAILED` reason string is built;
`README.md` note that heavy/parallel `--generate` authoring may need a larger `--llm-timeout-ms`.

**Tests.** Unit: a compiler whose injected LLM throws a timeout-shaped error → `COMPILE_FAILED` reason
contains the raise-`--llm-timeout-ms` hint.

**Invariants.** Fail-closed unchanged (a timed-out authoring is still a `COMPILE_FAILED`); this only
improves the message/retry economics. Safe.

---

## Item H — avoid the self-judge deadlock in `--generate --autonomous` *(recommendation)*

**Problem.** gpt-oss built a compiling 484-LOC server but `completed` with no diff against its **own**
self-authored **judge** rung (and the approver is the same model) — a self-judge deadlock: the model
authors a bar it then cannot satisfy and cannot recognize as satisfied, so it stalls. glm/kimi were
also judged by themselves. The model-independence warning already fires
(`src/cli/independence.ts`, emitted at compose) but is advisory and easy to miss in autonomous runs.

**Fix (policy nudge, not a core change).**
1. In `--generate --autonomous` specifically, **escalate** the model-independence warning when the
   harness, judge, and approver all resolve to the same model (the self-author + self-judge case is the
   most deadlock-prone).
2. **(Optional, more intrusive)** When no per-step model is overridden and an alternative is available
   (e.g. a different `--llm-provider`/model, or `claude` installed), default the **approver** to a
   different model so the second key is a genuine independent skeptic. Gate behind a clear default or a
   flag; do **not** silently change behavior without surfacing it.
3. Document the recommendation: for autonomous `--generate`, pass `--approver-model` (and/or
   `--judge-model`) on a different model/provider — it both improves the two-key guarantee (invariant
   #3 in spirit) and avoids the self-judge stall.

**Files.** `src/cli/independence.ts` (escalation message), `src/cli/compose.ts`/`main.ts` (only if
adding the optional auto-separation), README/ADR (the recommendation).

**Invariants.** #3 (two keys) is *strengthened*, not weakened. No wrong-green risk.

---

## Cross-cutting test (proves the synergy)

Add an integration test (fake harness + fake LLM, compose + drive) for a from-scratch `--generate
--autonomous` config where: the authored contract has a setup + a build/test deterministic rung + a
judge rung; the fake harness returns `truncated`/no-diff on iteration 1 then writes a passing
implementation on iteration 2. Assert the run is **not** killed in prepare (A/B), **not** aborted at
the iteration-1 truncated no-diff (F), and reaches DONE within `--max-iterations`. This locks in that
A+B+E+F together let an autonomous from-scratch run actually converge.

---

## Priority & summary

| Item | What | Type | Fixes |
|---|---|---|---|
| **E** | `--max-agent-turns` CLI flag for the goaly-code loop | implement | glm/kimi truncation |
| **F** | excuse no-diff after a `truncated` run (stuck.ts) | implement (1-line + test) | glm/kimi premature abort |
| **G** | hint to raise `--llm-timeout-ms` on a timeout-`COMPILE_FAILED` | optional/config | sonnet authoring timeouts |
| **H** | escalate/auto-separate judge+approver in `--generate --autonomous` | recommendation | gpt-oss (+glm/kimi) self-judge stall |

Definition of done (per `AGENTS.md`): `npm run typecheck` clean, `npm test` green, new behavior
tested, coverage ≥ 80%, invariants intact, and `README.md` + `docs/index.html` updated for the new
flag/behavior (E definitely; F/G/H as they touch user-facing behavior). Add/extend an ADR if F's
stuck-policy change or H's default warrants it (the companion doc already added ADR 0010 for A/B).

## Code references
- Turn cap: `DEFAULT_GOALY_CODE_MAX_TURNS` (`src/goaly-code/harness.ts`); `goalyCodeMaxTurns`
  (`src/cli/compose.ts:157`, threaded `:585`). No flag in `src/cli/args.ts` today.
- No-diff excuse: `noDiffExcusedByRun` (`src/orchestrator/stuck.ts:63`) + the no-diff check (`:85-90`);
  `ctx.lastRunStatus` is the prior `HarnessRunResult.status` (`'completed'|'crashed'|'truncated'|'timeout'`).
- LLM-step timeout default 600000: `--llm-timeout-ms` (`src/cli/args.ts:291`); compile authoring +
  `COMPILE_FAILED`: `src/compile/agent-compiler.ts`, `src/domain/events.ts`.
- Model independence: `independenceWarnings` (`src/cli/independence.ts`).
