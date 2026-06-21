# AGENTS.md — working on goaly

Conventions and guardrails for AI agents (and humans) contributing to this repo. Read this
first. It overrides generic habits where they conflict.

`goaly` runs a coding agent in a loop until a goal is **verifiably** met, with a frozen
success criterion the agent can't weaken. The whole point is correctness under adversarial
self-interest — so the bar for changes here is high. Start with [`DESIGN.md`](DESIGN.md) (what &
why), [`ARCHITECTURE.md`](ARCHITECTURE.md) (how), [`CONTEXT.md`](CONTEXT.md) (glossary), and the
[`docs/adr/`](docs/adr) decisions.

## Commands

```bash
npm install
npm run typecheck     # tsc --noEmit (strict) — MUST be clean
npm test              # vitest run — MUST be green
npm run coverage      # 80% line/branch/function thresholds
npm run dev -- run --goal "..." --verify-cmd "true" --harness fake --autonomous   # local run
npx vitest run src/path/to/file.test.ts   # one file while iterating
```

**Definition of done for any change:** `npm run typecheck` clean, `npm test` green, new behavior
covered by a test, none of the invariants below weakened, and — if the change touches the
architecture, the public/embeddable API, or user-facing functionality — `README.md` **and** the
landing page (`docs/index.html`) updated to match (see [Keep the docs in sync](#keep-the-docs-in-sync-explicit-check)).
No exceptions for "small" changes.

## The eight invariants (do not break these)

These are the product. A change that violates one is wrong even if tests pass — add a test instead.

1. **Zero-LLM reducer.** `src/orchestrator/{step,decide,stuck}.ts` are pure & synchronous: no
   `Promise`, no clock/IO/process, no adapter imports. If you need an effect, emit a `Command` and
   let the Driver perform it. This is enforced structurally — keep it that way.
2. **Compile once, then freeze.** The contract is authored once and frozen (`contractHash`); no
   transition rewrites it. It must be identical on every loop iteration (it's logged each time).
3. **Two keys for DONE.** A run is DONE only when the frozen verifier ladder passes **and** the
   approver does not veto. Gate B runs **only** when the ladder passes. The approver is veto-only.
4. **Fail-closed everywhere.** Any verifier/rung/approver/adapter/workspace that errors or returns
   unparseable output becomes a FAIL / VETO / crashed-run — never a green, never an unhandled
   throw. Adapters and `drive()` must never reject.
5. **`--autonomous` moves Gate A only.** It auto-accepts the contract but still freezes it and logs
   it loudly. It never skips verification or the freeze.
6. **Parse at every seam (Zod).** CLI args, config, harness stdout (tolerant), judge/approver output
   (drop/fail-closed), and the run log on read (reject corrupt) all parse with Zod. Ids are branded.
   Nothing reaches the reducer without a `parse`.
7. **Write-ahead + resume.** Events are appended before the state advances; resume is a replay-fold
   over the log; no completed iteration is repeated. Durability is at-least-once by design.
8. **Stuck detection stays pure** over `LoopCtx` histories: no-diff, repeat-failure, oscillation,
   budget.

## The mental model: one deep module, four seams

```
Driver (effects: clock, budget, IO, persistence, processes)
  │ performs Commands, feeds Events back, persists write-ahead
Orchestrator  ──  pure step(state,event) → [state, Command[]]  ──  ZERO LLM, ZERO IO
  │ Commands ↓
HarnessAdapter(#1)   Verifier/Ladder(#2)   Approver/Gate B(#3)   Clock+Budget(#4)
```

Each seam has ≥2 implementations (real + fake), so the orchestrator can't tell which it called.
That is why a new harness is one file and why the whole policy is testable with zero IO.

## Code conventions

- **TypeScript strict**, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `verbatimModuleSyntax`. `moduleResolution: Bundler`.
- **No `.js` extensions** in imports. Use `import type { … }` for type-only imports. Prefix node
  builtins: `import { spawn } from 'node:child_process'`.
- **`exactOptionalPropertyTypes`:** never assign `undefined` to an optional property — omit the key
  (conditional spread) or type the field `X | undefined`.
- **Immutability:** construct new objects; never mutate `LoopCtx`/state in place.
- **Validate external data with Zod**; fail-closed where the spec says.
- **No `console.log`** in library code. The CLI/gates write to `process.stdout`/`stderr` (that's the
  output channel) via injectable functions so they stay testable.
- **Small files** (≤ 800 lines), **small functions** (≤ 50 lines), early returns over deep nesting.
- **Make subprocess/LLM calls injectable** (an optional `exec`/`llm` constructor dependency) so
  tests never spawn real processes or call real models.

## Directory map

```
src/
  domain/      ids, config, contract, verdict, events   — types + Zod schemas (the language)
  orchestrator/ state, step, decide, stuck              — PURE reducer (the spine)
  driver/      driver, clock, budget                    — effects + seam #4
  verify/      verifier, ladder, deterministic, judge, approver, agent-approver   — seam #2/#3
  compile/     compiler, agent-compiler, gateA, gates   — Phase 1 + freeze + Gate A
  agent-cli/   codec, <tool>-codec, output, stream, estimate — one deep codec per CLI (seam-shared)
  harness/     adapter, agent-cli-harness, claude-code, codex, droid — seam #1
  workspace/   workspace, git-workspace                 — harness-independent diff/run
  runlog/      runlog, file-runlog                      — write-ahead persistence + replay
  llm/         provider, cli-provider                   — INTERNAL seam (judge/approver/compiler)
  cli/         args, compose, main                      — composition root + CLI
  testing/     fakes                                    — fakes for every seam
```

## TDD build order (how the skeleton was grown; follow it for new vertical slices)

1. Domain + Zod schemas. 2. Pure reducer + DECIDE + stuck (table-tested). 3. Fakes. 4. Driver +
full loop with **zero IO**. 5. RunLog persistence + replay/resume. 6+. Real adapters/verifiers as
leaves behind frozen interfaces. Prove policy with fakes before spawning a subprocess.

## Adding a new harness

A new harness is **one module** — an `AgentCliCodec` (`src/agent-cli/codec.ts`) holding all of one
CLI's quirks in one place: its two argv dialects (`harnessArgs` write-mode + `readonlyArgs`
read-only), its `fieldExtractor`/`streamExtractor`, and its `classify` status policy. It composes the
shared agent-CLI core (`output.ts`: `parseAgentOutput` + a per-tool `FieldExtractor`; `flatExtractor`
covers a flat envelope) and, for the standard status policy, the shared `classifyFlatRun`
(`src/agent-cli/codec.ts`) — don't re-implement tolerant JSON/JSONL parsing or the subprocess dance
(`runProcess` owns it). Register the codec by wiring the generic `AgentCliHarness` into `makeHarness`.
See [`docs/adding-a-harness.md`](docs/adding-a-harness.md) for the full guide, and use the
**`investigate-harness`** skill (`.claude/skills/investigate-harness/`) to probe an unfamiliar CLI
and produce the field/flag/status mapping before you write the codec.

A harness CLI can **optionally** also back the LLM workflow steps (compiler / judge / approver) via
the separate, **read-only** `LlmProvider` seam — `AgentCliLlmProvider` consumes the **same codec**
(its `readonlyArgs` + `fieldExtractor`/`streamExtractor`); register an `LlmProviderChoice` +
`makeLlmProvider()` case, and select it with `--llm-provider`. A judge/approver must never edit the
tree, so this is read-only only. See the "Optional: also use the tool for the LLM steps" section of
the harness guide.

## Keep the docs in sync (explicit check)

The README and the docs are part of the public contract, not optional decoration. **Any change that
alters the architecture, the public/embeddable API (`src/index.ts` exports, the CLI flags/usage, the
`HarnessAdapter`/`LlmProvider`/seam interfaces), the harness-authoring pattern, or user-facing
functionality MUST update the affected docs below in the same change:**

- [`README.md`](README.md) — install, usage, flags, supported harnesses, the how-it-works summary.
- [`docs/index.html`](docs/index.html) — the GitHub Pages landing page (the interactive overview):
  its pipeline / state-machine / DECIDE / verifier-ladder / seam diagrams, the support matrix, the
  "adding a harness" guide, and the harness-comparison tabs.
- [`docs/adding-a-harness.md`](docs/adding-a-harness.md) — the harness-authoring guide. It contains
  **real interface signatures, a copy-paste skeleton, and field/status-mapping recipes**, so it
  rots silently when you change *how* a harness is written. Update it whenever you touch the
  `HarnessAdapter` shape, the shared parsing core (`parseAgentOutput` / `FieldExtractor` /
  `flatExtractor` / `classifyHarnessRun`), the adapter constructor options (e.g. `model`), the
  `LlmProvider` seam or `AgentCliLlmProvider`, or the `args.ts`/`compose.ts` registration edits.
  (Also re-check the `investigate-harness` skill if the discovery worksheet it emits no longer
  matches the mapping the guide asks for.)

Treat it as a definition-of-done gate. A change that adds or renames a harness, changes a CLI flag,
alters the state machine / DECIDE table / verifier ladder / stuck detectors, moves or renames a
seam, **changes how harness output is parsed or how an adapter is authored**, changes a default
(e.g. judge quorum, confidence floor, `maxIterations`), or adds/removes an exported symbol is **not
done** until every doc above that describes it reflects it. The docs cite real states, commands,
events, statuses, signatures, and defaults — if you change those in `src/`, change the docs so they
stay accurate. When in doubt whether a change is "meaningful", assume it is.

## Anti-patterns (rejected on sight)

- Importing an adapter/LLM/clock into the reducer, or making `step` async.
- Letting the compiled contract change after Gate A.
- Declaring DONE on a single key (verifier OR approver), or running Gate B on a red ladder.
- An adapter or `verify`/`review` that throws instead of failing closed.
- A seam that reads external data without a Zod `parse`.
- Swallowing an error silently (log it, fail closed, or propagate as a typed result).
- Shipping an architecture / public-API / functionality change without updating `README.md` and the
  landing page (`docs/index.html`) in the same change.

## Reporting & working on issues

Issue templates live in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE) — one per type: **bug**,
**feature** (new capability), **enhancement** (improve existing), **harness adapter**, and
**discussion/decision**. A [PR template](.github/PULL_REQUEST_TEMPLATE.md) carries the
definition-of-done checklist. Two skills automate the workflow and enforce the rules below:

- **`log-issue`** — file a high-quality, *verified* issue. Bugs follow **reported → replicated →
  logged**: a bug is reproduced (prefer the `fake` harness + `--verify-cmd` for orchestration bugs,
  zero network) *before* it's filed, and the report carries verified reproduction steps plus a
  preliminary cause; if it can't be reproduced it isn't filed as a bug. Features/enhancements use the
  comprehensive, invariant-aware templates.
- **`work-on-issue`** — pick up an issue. **Verify the claim first**: replicate the bug, or confirm a
  feature/enhancement is actually wanted *and pointed in the intended direction* — a valid outcome is
  "not planned"/discarded, so we don't build for the sake of building. Then implement **test-first**:
  a bug fix ships with a regression test that reproduces it; a feature/enhancement ships with tests
  that pin the new behavior so it can't silently regress. The definition of done above still applies.

## Commits / PRs

Conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`). Keep diffs
focused. A PR that touches the reducer must explain how purity and the two-key invariant are
preserved.

When a change alters user-facing CLI output or behavior, consider attaching a short terminal-demo
GIF to the PR. The **`record-demo-gif`** skill (`.claude/skills/record-demo-gif/`) records one;
`references/goaly-demo-recipe.md` has the loop-specific recipe (throwaway git sandbox, run from
inside it, `--autonomous`, and decoding the run log to reveal the verifier ladder + Gate-B approver).
GIFs are demo artifacts — host them (e.g. catbox) and embed the URL in the PR body; never commit the
GIF/cast into the repo.
