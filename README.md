# goaly

[![CI](https://github.com/krimvp/goaly/actions/workflows/ci.yml/badge.svg)](https://github.com/krimvp/goaly/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/goaly.svg)](https://www.npmjs.com/package/goaly)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**🌐 [Interactive overview &amp; architecture →](https://krimvp.github.io/goaly/)** — the landing
page (`docs/`) explains what this is, how the loop works, the internal architecture, and how to add
a harness, with interactive diagrams.

A **harness-agnostic goal-orchestration layer**: run a coding agent repeatedly until a goal is
*verifiably* achieved, with a deterministic thin layer in control and a **frozen** success
criterion the agent can't weaken mid-loop.

> The anti-reward-hacking core: "until the goal is achieved" must not collapse into "until the
> agent weakens its own test." goaly compiles the success contract **once**, freezes it, and
> requires **two independent keys** — a frozen verifier *and* an independent approver — before
> declaring a run DONE.

See [`DESIGN.md`](DESIGN.md) (what & why), [`ARCHITECTURE.md`](ARCHITECTURE.md) (how),
[`CONTEXT.md`](CONTEXT.md) (glossary), and [`docs/adr/`](docs/adr) (decisions).

## How it works

```
COMPILE_VERIFIER → [Gate A: approve / revise / reject] → loop {
    RUN_AGENT → verifier ladder → [Gate B: result approval] → DECIDE
} → DONE | FAILED | ABORTED
```

- The **control flow has zero LLM calls.** A pure reducer `step(state, event) -> [state, Command[]]`
  owns all policy; an imperative Driver performs the effects it requests. Everything stochastic
  (running the agent, judging, approving) hides behind boolean/value interfaces at four real seams.
- The **verifier ladder** runs cheapest-and-hardest-to-game first: deterministic checks (exit codes,
  tests) before any LLM judge, short-circuiting on the first deterministic fail. A rung that errors is
  **fail-closed** — a malformed grader is never a green. When goaly **authored** the verification
  (`--generate`), an integrity **guard rung runs first** and fails closed if any generated test file
  was changed since the contract froze — the worker can't quietly rewrite the bar the frozen command
  measures.
- **Gate A is the human's say over the bar.** Before the loop you can approve the frozen contract,
  **reject** it (abort), or give **free-text feedback to revise** it — goaly re-authors the contract
  and re-presents it, bounded by `--max-gate-a-revisions` (default 10; `0` disables revision).
  `--autonomous` skips this pause entirely, never the freeze.
- **Two keys for DONE:** the frozen verifier passes *and* the independent approver (Gate B, veto-only)
  doesn't veto.
- **Stuck detection** bails before `maxIterations` with a reason: no-diff, repeat-failure, oscillation,
  budget.
- **Write-ahead run log** under `.goaly/<runId>/` makes every run replayable, **resumable**, and
  **inspectable** after the fact (`goaly runs list` / `goaly runs show`).
- **Per-run spend report:** every run ends with a token breakdown by layer — the **harness** vs. the
  **LLM steps** (compiler / judge / approver) — and against any `--budget-tokens` cap. It's folded
  from the run log, so `--resume` and `goaly runs show` rebuild the same numbers; missing token data
  degrades to "unknown", never a crash. Optional USD cost via `--cost-table`; **tokens-only by default**.

## Hardening against reward-hacking

The point of goaly is correctness under adversarial self-interest, so the loop is hardened against
the obvious ways a worker (or a gamed contract) could reach DONE without meeting the goal:

- **The frozen bar can't be edited out from under the command.** Files goaly authors for `--generate`
  are pinned by content hash inside the frozen contract; a guard rung re-checks them every iteration
  and fails closed on any change or deletion (so `vitest run authored.test.ts` can't stay "frozen"
  while `authored.test.ts` is rewritten to pass).
- **The two keys ingest the diff as untrusted data.** The judge and the approver receive the
  worker-controlled diff inside a clearly-delimited, nonce-fenced envelope, and are instructed to
  never act on instructions, verdicts, or claims hidden inside it (prompt-injection defense).
- **Vacuous authored bars are refused.** A `--generate` command that trivially passes without
  measuring anything (`true`, `:`, `exit 0`, …) is rejected at compile (`COMPILE_FAILED`) rather than
  frozen as a hollow contract.
- **Independence is checked, not assumed.** goaly warns loudly when the "two independent keys" collapse
  onto one model (e.g. a bare `--model X`, which would make the approver share the worker's/judge's
  blind spots); pass `--approver-model` (or a different `--llm-provider`) to separate them.
- **The verify command runs with a credential-scrubbed environment.** The verifier executes
  worker/model-authored code on your host every iteration; goaly strips credential-looking variables
  (`*_TOKEN`, `*_KEY`, `*SECRET*`, `AWS_*`, `GITHUB_*`, …) from its environment so they can't be
  exfiltrated through a check. PATH/HOME and the rest of the toolchain environment are kept, so
  ordinary test commands are unaffected. (This narrows, but does not eliminate, the host trust
  boundary — only run `--autonomous` against repositories you trust.)

## Install

Install it as a standalone CLI (builds `dist/`, then puts `goaly` on your PATH):

```bash
make install        # == npm install -g .  (the `prepare` hook bundles dist/ first)
goaly help
```

Or build a redistributable tarball, or install from source by hand:

```bash
npm install         # install deps (also bundles dist/ via the `prepare` hook)
npm run build       # bundle the standalone CLI + type declarations into dist/
npm install -g .    # put `goaly` on your PATH
make pack           # -> goaly-<version>.tgz, installable with `npm i -g ./goaly-*.tgz`
```

Requires Node ≥ 20 and `git`. The default adapters shell out to the `claude` / `codex` / `droid`
CLIs; the LLM compile/judge/approve steps use a CLI-backed provider (`claude` by default, switchable
with `--llm-provider`). Pick the model per layer with `--model` / `--llm-model` (see Usage).

> Add `.goaly/` to your target repo's `.gitignore`. (goaly also excludes it from its own
> tree-hash, so its run logs never pollute stuck-detection regardless.)

## Usage

```bash
# Point at an existing test command; a human approves the frozen contract once:
goaly run --goal "make the parser handle empty input" --verify-cmd "npm test"

# Let the agent author the verification, and run unattended (contract still frozen + logged loudly):
goaly run --goal "add a /health endpoint returning 200" --generate --autonomous

# Provide a longer, well-specified goal from a file (or stdin), and revise the contract
# interactively at Gate A up to 3 times before it sticks:
goaly run --goal-file ./GOAL.md --generate --max-gate-a-revisions 3
cat ./GOAL.md | goaly run --goal - --generate

# Choose a harness, cap iterations, set a budget, resume a crashed run:
goaly run --goal "..." --verify-cmd "pytest -q" --harness codex --max-iterations 8 \
             --budget-tokens 500000 --workspace ./myrepo
goaly run --goal "..." --resume run-<id> --workspace ./myrepo

# Pick a model for the harness, and a different model for the LLM steps (judge/approver/compiler):
goaly run --goal "..." --verify-cmd "npm test" --harness claude-code \
             --model claude-opus-4-8 --llm-model claude-sonnet-4-6

# Run the LLM steps on a different CLI entirely (kept read-only so they never touch the tree):
goaly run --goal "..." --generate --autonomous --harness codex \
             --model gpt-5-codex --llm-provider codex --judge-model o3

# Follow the loop step-by-step, and keep a structured diagnostics file (rotated):
goaly run --goal "..." --verify-cmd "npm test" --log-level debug
goaly run --goal "..." --verify-cmd "npm test" --log-file ./run.log   # or --no-log-file

# Watch the agent's turns live — tool calls, messages, token counts — for the run AND the LLM steps:
goaly run --goal "..." --verify-cmd "npm test" --stream

# Cap how long each step may run (subprocess kill-timeouts, in ms):
goaly run --goal "..." --verify-cmd "npm test" \
             --harness-timeout-ms 900000 --llm-timeout-ms 120000 --verify-timeout-ms 60000

# Add an approximate USD cost to the end-of-run spend report (tokens-only without it):
goaly run --goal "..." --verify-cmd "npm test" --cost-table ./prices.json

# With a .goalyrc in the repo, the repeated wiring lives in the file — just pass the goal:
goaly run --goal "make the parser handle empty input"

# Inspect past runs (read-only — replays the run log, re-runs nothing):
goaly runs list
goaly runs show run-<id>
```

### Config file

So you don't repeat the same wiring on every invocation, `goaly run` reads **default flags from a
JSON config file** in two layers (later overrides earlier):

1. an **implicit `.goalyrc`** discovered in `--workspace` (or the current directory) — optional,
2. an **explicit `--config <path>`** JSON file — when given it **must exist** (fails closed).

Keys mirror the CLI flag names in **kebab-case** (`verify-cmd`, `max-iterations`,
`harness-timeout-ms`). **Any flag passed on the command line overrides the file**, so the full
precedence is: **CLI flag > `--config` file > `.goalyrc` > tool default**.

```jsonc
// .goalyrc — committed once, applies to every `goaly run` in this repo
{
  "harness": "codex",
  "verify-cmd": "npm test",
  "autonomous": true,
  "max-iterations": 8,
  "budget-tokens": 500000,
  "model": "claude-opus-4-8",
  "verify-timeout-ms": 60000
}
```

```bash
# now the same run is just:
goaly run --goal "add a /health endpoint returning 200"
# …a one-off override still wins over the file:
goaly run --goal "..." --max-iterations 3
# …and a named profile can be pointed at explicitly (overrides .goalyrc on conflicts):
goaly run --goal "..." --config ./ci/goaly.ci.json
```

Booleans (`autonomous`, `generate`, `no-log-file`) take `true`/`false`, where `false` means "not
set" (the flag's absence is its default). Per-invocation flags — `--workspace`, `--resume`, and
`--config` itself — are intentionally not read from a file. An unknown key, a non-primitive value,
or invalid JSON is a usage error (the config seam parses with Zod and fails closed).

### Per-step timeouts

Each subprocess goaly spawns has a wall-clock kill-timeout, configurable as **pure wiring** (it
never enters the frozen contract):

| Flag / config key | Step | Default |
| --- | --- | --- |
| `--harness-timeout-ms` | the harness (coding-agent) subprocess | `600000` (10 min) |
| `--llm-timeout-ms` | each LLM step — judge / approver / compiler | `600000` (10 min) |
| `--verify-timeout-ms` | the verify command | unbounded |

A verify command that exceeds its timeout is SIGKILL'd and reported as a **non-zero exit — i.e. a
verifier FAIL, never a green** (fail-closed, invariant #4). Each value must be a positive integer
number of milliseconds.

### Per-run spend report

Every run prints a **spend summary** and stores the data in the run log. Token usage is aggregated
**at the Driver** (never the pure reducer) and broken down by layer — the **harness** vs. the **LLM
steps** (compiler, the judge rung, the Gate-B approver) — plus consumption against any
`--budget-tokens` cap. Because it's folded from the write-ahead event log, `--resume` and
`goaly runs show <id>` reconstruct the identical report from the log alone. The `--budget-tokens`
cap governs **total** spend (harness + LLM steps), not just the harness.

```
spend:
  harness      482,113 tokens
  compiler       3,901 tokens
  verifier      11,204 tokens
  approver       4,556 tokens
  llm subtotal  19,661 tokens
  total        501,774 tokens
budget:      501,774 / 500,000 tokens (100%) — budget exceeded
```

**Fail-closed:** a harness or provider that doesn't surface usage degrades that layer to `unknown`
(never a silent zero, never a crash). The default `claude` provider runs `--output-format json` so
its usage is captured; `codex` / `droid` providers report usage too.

**Estimated when unreported.** When a run or LLM step is **streaming** its turns (`--stream`, debug
logging, or an embedder subscription — see **Live streaming** below) but the CLI still reports **no**
`usage`, goaly counts the spend **locally** from the streamed turns (assistant text, tool
inputs/outputs) via a ~4-characters-per-token heuristic — a real number beats counting a quiet run
as zero. Estimated tokens still count against the `--budget-tokens` cap (so a fuller count can trip
it sooner) and are marked in the report so an approximate figure reads approximate:

```
spend:
  harness      3,000 tokens (3,000 estimated)
  ...
```

**Cost is opt-in.** Pricing is volatile, so the log stays **tokens-only** and cost is a print-time
overlay: pass `--cost-table <path>` to a JSON file mapping **model → USD per 1,000,000 tokens** (a
`"default"` key prices any unlisted model). Each layer is priced by *its* resolved model; a layer
whose model isn't priced is left out and the total is marked approximate.

```jsonc
// prices.json — USD per 1M tokens; "default" covers anything unlisted
{ "claude-opus-4-8": 15, "claude-sonnet-4-6": 3, "default": 5 }
```

Goal, intent, and rubric each accept one source: inline (`--goal "…"`), a file (`--goal-file <path>`),
or stdin (`--goal -`). Giving a field more than one source is a usage error.

**Model selection** is optional and never enters the frozen contract — it's pure wiring. `--model`
is the global default (the harness *and* the LLM steps); `--llm-model` overrides all LLM steps; and
`--judge-model` / `--approver-model` / `--compiler-model` override a single step. Precedence per LLM
step: per-step flag → `--llm-model` → `--model` → the tool's own default. `--llm-provider`
(`claude` default, or `codex` / `droid`) picks which CLI runs those steps — handy when the harness
and the LLM steps should share a model namespace. Omit them all and every tool uses its own default.

At **Gate A** (unless `--autonomous`), goaly prints the frozen contract and prompts:

```
Approve, revise with feedback, or reject? [a]pprove / [f]eedback / [r]eject:
```

- `a` / `approve` (or `y`/`yes`) — accept the contract and start the loop.
- `f` / `feedback` — type a free-text note; goaly re-authors the contract from it and re-prompts,
  up to `--max-gate-a-revisions` times. Empty feedback is treated as a reject.
- `r` / `reject` (anything else) — abort; the loop never starts.

> Piping the goal via stdin (`--goal -`) consumes stdin, so there's nothing left for the interactive
> prompt — use `--autonomous` or `--goal-file` in that case.

`goaly help` lists every flag. Exit codes: `0` DONE, `1` FAILED/ABORTED, `2` usage error.

**Diagnostics / logging** is leveled, structured observability for the Driver and the seams — and,
like model selection, it's pure wiring that never enters the frozen contract. It is **separate from
the write-ahead run log** (`.goaly/<runId>/` event stream), which stays the single source of truth
for replay/resume; this logger is human-facing diagnostics, not durability. A human-readable line
goes to **stderr** (so stdout stays clean for the outcome) and a structured **JSON-lines file** is
written to `.goaly/<runId>/goaly.log`, **size-rotated** (5 MiB × 3 archives) so it can't grow
unbounded. `--log-level debug|info|warn|error` (default `info`) sets verbosity — `debug` is the
step-by-step firehose, and prompts / harness output / diff / verifier detail stay at `debug`, never
`info` (secrets discipline). `--log-file <path>` overrides the file location; `--no-log-file` writes
console only. A logging failure never crashes a run (fail-closed). The pure reducer never logs
(invariant #1).

**Live streaming** (`--stream`) is opt-in observability for the "what is happening right now?" gap.
A `harness.run()` call — **and** each LLM step (compile / judge / approve) — is otherwise a black
box: goaly fires a prompt, waits minutes, then sees only the final buffered result. With `--stream`,
the agent's **intermediate turns** — tool/command invocations and their output, assistant messages,
reasoning, per-turn token usage — are rendered to **stderr** as they happen, each tagged by phase
(`[agent]` / `[compile]` / `[judge]` / `[approve]`). Every tool maps its native stream onto one
**canonical, tool-neutral event taxonomy** (`AgentStreamEvent`: `session` / `message` / `reasoning`
/ `tool_use` / `tool_result` / `usage` / `done`), Zod-validated at the seam, so the live view is
uniform across claude-code, codex, and droid (codex via its `--json` JSONL; claude-code and droid
via `--output-format stream-json`). It's **independent of `--log-level`** (which separately routes
the same events into the diagnostics file at `debug`), and embedders can subscribe programmatically
via `composeDeps({ onStreamEvent })` / `DriverDeps.onStreamEvent`. It is **pure observability**: the
stream never touches the frozen contract, the verifier ladder, or the two-key decision; events are
**not** written to the run log (resume stays a fold over `OrchestratorEvent` only); and a streaming
failure degrades to "no live output", never a changed outcome (fail-closed).

### Inspecting past runs

The write-ahead run log is also queryable after the fact, with two **read-only** subcommands that
**re-run nothing** — they replay the persisted event stream with the *same* fold `--resume` uses, so
what they render is exactly the state the Driver computed:

```bash
goaly runs list                  # a table of past runs under ./.goaly
goaly runs show run-<id>         # full detail for one run
goaly runs list --workspace ./myrepo   # look elsewhere for the .goaly directory
```

- **`goaly runs list`** — one row per run: id, status (`DONE` / `FAILED` / `ABORTED`, or
  `INCOMPLETE` for a run that never finished), iterations, tokens, started/ended, and the goal.
  Most-recent first.
- **`goaly runs show <runId>`** — the **frozen contract** (and its hash), the **Gate A** outcome,
  every iteration's **verifier-ladder verdict** and **Gate B** approver decision, the
  stuck/failure **reason**, and the totals.

Both parse the log with **Zod on read** and **fail closed**: a corrupt run is *flagged* (`CORRUPT`
in the table; a non-zero exit for `show`), never silently treated as green or dropped (invariants
#6/#7). `runs show` exits `1` for an unknown or corrupt run, `0` otherwise.

### Adding a harness

A new harness is **one module** — an `AgentCliCodec` that holds everything goaly needs to know to
speak to one coding-agent CLI in one place:

```ts
interface AgentCliCodec {
  readonly name: string;
  readonly command: string;                                       // the binary to spawn
  readonly unknownSession: string;                                // safe sentinel session id
  readonly promptOnStdin: boolean;                                // prompt on stdin vs argv-only
  readonly fieldExtractor: FieldExtractor;                        // final-result field mapping
  readonly streamExtractor: StreamEventExtractor;                 // per-turn → AgentStreamEvent
  harnessArgs(opts): string[];                                    // write-mode argv (drives edits)
  readonlyArgs(opts): string[];                                   // read-only argv (judge/approver)
  parse(stdout): AgentOutput | null;                              // tolerant, never throws
  classify(input): HarnessRunResult;                              // process outcome → status
}
```

The codec is consumed by **both** roles a CLI can play, from one source of truth: the write-role
`HarnessAdapter` (seam #1) drives the agent, and the read-only `AgentCliLlmProvider` (the
judge/approver/compiler LLM role) reuses the same extractors and the `readonlyArgs` dialect — so
there is no `llm → harness` coupling. The generic `AgentCliHarness` is all the seam-#1 wiring a codec
needs; registering a harness is one codec module + one line in `makeHarness`. `diffHash` and verifier
execution live in the shared `Workspace`, not the codec — so stuck-detection and verification work on
any harness for free. The shared `agent-cli` core owns the tolerant final-result parse, the streaming
`StreamTap`, and the flat status policy (`classifyFlatRun`), and the shared `runProcess` owns the one
tested subprocess dance (output cap, timeout, process-group kill, never-reject). See
[`docs/adding-a-harness.md`](docs/adding-a-harness.md) for the full guide.

## Develop

`make help` lists every task. The common ones:

```bash
make dev ARGS='run --goal "..." --verify-cmd "true" --harness fake --autonomous'  # run from SOURCE (tsx) — no build
make build          # bundle the standalone CLI + type declarations into dist/
make check          # typecheck + tests (the definition-of-done gate)
make coverage       # vitest run --coverage (80% thresholds)
```

Each maps to an npm script (`npm run dev -- …`, `npm run build`, `npm run typecheck`, `npm test`,
`npm run coverage`). `make dev` / `npm run dev` execute the TypeScript entry directly with `tsx`, so
there is **no build step** for the dev loop; `npm run build` (esbuild) is only needed to produce the
installable `dist/` artifacts.

The walking skeleton (domain → pure reducer → fakes → driver) is proven end-to-end with **zero IO**
before any subprocess exists; real adapters/verifiers are leaves behind frozen interfaces.

To record a terminal-demo GIF of a goaly run (e.g. to attach to a PR), use the **`record-demo-gif`**
skill — see [`.claude/skills/record-demo-gif/`](.claude/skills/record-demo-gif/) and its
`references/goaly-demo-recipe.md`.

## Embedding

The library works headless; the CLI is a thin caller. Import from the package root:

```ts
import { drive, composeDeps, freezeContract, type DriverDeps } from 'goaly';
```

## License

[MIT](LICENSE) © krimvp
