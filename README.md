# goaly

[![CI](https://github.com/krimvp/goaly/actions/workflows/ci.yml/badge.svg)](https://github.com/krimvp/goaly/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/goaly.svg)](https://www.npmjs.com/package/goaly)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Run a coding agent (Claude Code, Codex, Droid, pi, or your own) in a loop until your goal is
**verifiably** achieved — checked against a **frozen** success contract the agent can't weaken to
pass.

The anti-reward-hacking core: "until the goal is achieved" must not collapse into "until the agent
weakens its own test". goaly compiles the success contract **once**, freezes it, and requires **two
independent keys** — a frozen verifier *and* an independent approver — before declaring a run DONE.

**🌐 [Interactive overview →](https://krimvp.github.io/goaly/)**

## Quick start

```bash
npm i -g goaly                 # or, from a clone: make install

# Just give it a goal — the agent writes the check, runs, and verifies.
# A human approves the frozen contract once at Seal:
goaly "add a /health endpoint returning 200"

# Fully hands-off (-d auto-accepts the still-frozen, still-logged contract):
goaly -d "add a /health endpoint returning 200"

# Or point at a check you already have:
goaly run --goal "make the parser handle empty input" --verify-cmd "npm test"
```

Requires Node ≥ 20 and `git`. Exit codes: `0` DONE · `1` FAILED/ABORTED · `2` usage error ·
`130` interrupted (Ctrl-C — the run stays resumable).

## How it works

```
COMPILE ──► SEAL ──► setup + pre-flight ──► ┌─────── loop (≤ --max-iterations) ───────┐
(author &   (freeze      (once)             │ RUN_AGENT ─► VERIFY ladder ─► SIGN-OFF  │
 freeze)     the bar)                       │     ▲             │fail          │veto  │
                                            │     └── feedback ─┴──── DECIDE ◄─┘      │
                                            └──────────────────────│─────────────────-┘
                                                     DONE · FAILED · ABORTED
```

- **The contract is frozen at Seal.** Its `contractHash` never changes again, and it's logged every
  iteration to prove the bar never moved. You approve it once — or revise it with feedback, or edit
  the authored files yourself and re-freeze. `--autonomous` skips the pause, never the freeze.
- **The verifier ladder runs cheapest-and-hardest-to-game first**: deterministic checks (exit
  codes, tests) before any LLM judge, short-circuiting on the first fail. A rung that errors is
  **fail-closed** — a malformed grader is never a green.
- **Two keys for DONE**: the frozen ladder passes *and* the independent Sign-off approver — which
  runs only on a green and is **veto-only** — doesn't veto. "Tests pass" is not "done".
- **The control flow has zero LLM calls.** A pure reducer owns all policy; everything stochastic
  hides behind narrow interfaces at four seams.
- **Every run is crash-safe and resumable.** A write-ahead log under `.goaly/<runId>/` makes runs
  replayable, `--resume`-able, and inspectable (`goaly runs list` / `show` / `watch`, or
  `goaly ui` in the browser).
- **Stuck detection bails early with a typed reason** (no-diff, repeated failure, oscillation,
  harness crash, unevaluable contract, budget) instead of burning iterations.

Under `--generate` (the default), the compiler also authors a one-time **setup** command and a
**pre-flight** proves the frozen verification can actually run — an unsound contract aborts before
any worker token is spent.

## Features

Everything below is documented in depth in the **[reference](docs/reference.md)**.

| Feature | Flags | In short |
| --- | --- | --- |
| [Generated verification](docs/reference.md#seal-the-contract-gate) | `--generate` | The LLM authors the check + setup; pinned by hash, guarded against tampering. |
| [Your own bar](docs/reference.md#the-verifier-ladder) | `--verify-cmd`, `--smoke` | Any command as the deterministic rung; `--smoke` runs the built artifact. |
| [Phased goals](docs/reference.md#phased-goals---phased) | `--phased` | A frozen plan of small sub-goals + cumulative acceptance on the original goal. |
| [Best-of-N worker](docs/reference.md#best-of-n-parallel-worker---candidates) | `--candidates N` | N isolated attempts per iteration; the frozen ladder picks the winner. Or just say *"use 4 subagents"*. |
| [Parallel waves](docs/reference.md#cooperative-parallel-waves---parallel-phases-experimental) | `--parallel-phases` | Independent phases run concurrently, merge with git plumbing, re-verify. Experimental. |
| [Worktrees](docs/reference.md#worktrees---worktree) | `--worktree <name>` | The whole run in an isolated checkout; merge back with plain git. |
| [Adversarial review](docs/reference.md#hardening-against-reward-hacking) | `--adversarial` | Critics attack the contract before Seal; refuters attack every green before Sign-off. |
| [Approver panels](docs/reference.md#hardening-against-reward-hacking) | `--approver-quorum`, `--approver-models` | Sign-off as a refute-first multi-vote panel, optionally across distinct models. |
| [Sandboxing](docs/reference.md#sandboxing) | `--sandbox`, `--sandbox-net` | OS-jail the agent and verifier (bwrap / firejail / container), with egress allowlists. |
| [Operator control](docs/reference.md#operator-control-watch-steer-extend) | `--resume`, `--note` | Watch live, steer with notes, raise caps mid-run — never the frozen bar. |
| [Follow-ups](docs/reference.md#following-up-after-a-run-ends---from-run) | `--from-run` | A new re-verified goal that knows what the last run did. |
| [Web UI](docs/reference.md#web-ui-goaly-ui) | `goaly ui` | Runs, live feeds, worktrees, and a browser Seal review station. Localhost-only. |
| [Spend & budgets](docs/reference.md#spend-report--budgets) | `--budget-tokens`, `--cost-table` | Per-layer token report (cache included); budgets survive resume. |
| [Observability](docs/reference.md#observability) | `--stream`, `--explain`, `--log-level` | Live agent turns, durable transcripts, plain-language narration. |
| [Reliability](docs/reference.md#reliability) | *(defaults)* | Preflight, bounded retries, safe Ctrl-C, fsync'd write-ahead log. |

## Usage

```bash
# Choose a harness, cap iterations, set a budget; resume a crashed run by id:
goaly run --goal "..." --verify-cmd "pytest -q" --harness codex --max-iterations 8 \
          --budget-tokens 500000
goaly run --resume run-<id>

# Different models for the agent vs. the LLM steps (judge/approver/compiler):
goaly run --goal "..." --verify-cmd "npm test" --model claude-opus-4-8 --llm-model claude-sonnet-4-6

# No coding CLI at all — goaly's own agent loop on any OpenAI-compatible endpoint:
goaly run --goal "..." --verify-cmd "npm test" --harness goaly-code \
          --base-url http://localhost:11434/v1 --model qwen2.5-coder

# Inspect and follow runs (read-only), or open the browser UI:
goaly runs list
goaly runs show run-<id>
goaly ui
```

`goaly help` lists every flag. The **[CLI cookbook](docs/reference.md#cli-cookbook)** has a worked
example for every mode; a **[config file](docs/reference.md#config-file)** (`.goalyrc` /
`~/.goalyrc`) keeps repeated wiring out of your invocations.

The LLM steps (compiler/judge/approver) **follow the harness** by default — `--harness codex`
authors and judges on codex too, so one installed CLI is enough; `--llm-provider` splits them.

> Add `.goaly/` to your repo's `.gitignore`. Files authored under `--generate` are auto-registered
> in `.git/info/exclude`, so your `git status` stays clean.

## Install

```bash
make install        # == npm install -g .  (bundles dist/ via the `prepare` hook)
goaly help
```

Or by hand: `npm install && npm run build && npm install -g .` — or `make pack` for a
redistributable tarball. The default adapters shell out to the `claude` / `codex` / `droid` / `pi`
CLIs; `--harness goaly-code` needs no CLI at all (any OpenAI-compatible endpoint, including a local
keyless one like ollama).

## Develop

```bash
make dev ARGS='run --goal "..." --verify-cmd "true" --harness fake --autonomous'  # run from source
make check          # typecheck + tests (the definition-of-done gate)
```

`make help` lists every task. The dev loop runs the TypeScript entry directly with `tsx` — no build
step. See [`AGENTS.md`](AGENTS.md) for the eight invariants and conventions, and
[`docs/adding-a-harness.md`](docs/adding-a-harness.md) to wrap a new coding-agent CLI (one codec
module + one registration line).

## Embedding

The library works headless; the CLI is a thin caller:

```ts
import { drive, composeDeps, readStreamTranscript } from 'goaly';

const deps = composeDeps(config, { runId, streamTranscript: true });
await drive(deps, config, runId);
const stream = await readStreamTranscript('.goaly', runId);
```

`DriverDeps` hooks for embedders: `interrupted` (cooperative shutdown), `sleep` (retry backoff),
`onStreamEvent` (live turn subscription), `telemetry`, and `observer`. There's also an experimental
[training pipeline](docs/reference.md#training-arc-experimental) built on the `goaly-code` harness.

## Docs

- **[Reference](docs/reference.md)** — every flag, mode, and guarantee (start here for depth)
- [`DESIGN.md`](DESIGN.md) — what & why · [`ARCHITECTURE.md`](ARCHITECTURE.md) — how
- [`CONTEXT.md`](CONTEXT.md) — the ubiquitous-language glossary
  ([plain-language version](docs/reference.md#glossary))
- [`docs/adr/`](docs/adr) — decision records · [`docs/adding-a-harness.md`](docs/adding-a-harness.md)

## License

[MIT](LICENSE) © krimvp
