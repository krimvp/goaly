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

# Just give it a goal — the agent writes the check, runs, and verifies, hands-off:
# with no preset or mode chosen the built-in 'default' preset applies (announced on
# every run; the contract is still frozen and logged, just auto-accepted at Seal):
goaly "add a /health endpoint returning 200"

# Keep a human at the gates instead — approve the frozen contract once at Seal:
goaly --mode review "add a /health endpoint returning 200"

# With one model available, the agent, the judge rung and the Sign-off approver are the same
# model — that run is labelled SELF-JUDGED (degraded) in its summary and `goaly runs show`.
# Give the second key its own model to make the two keys independent in fact:
goaly "add a /health endpoint returning 200" --approver-model <a-different-model>

# Or point at a check you already have:
goaly run --goal "make the parser handle empty input" --verify-cmd "npm test"
```

Requires Node ≥ 20. Git is recommended (used by default); pass `--workspace-mode file` to run in a plain directory without `git init`. Exit codes: `0` DONE · `1` FAILED/ABORTED · `2` usage error ·
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

- **The contract is frozen at Seal.** Its `contractHash` never changes again and is logged every
  iteration. Under `--mode review` you approve it once; autonomous runs skip the pause, never the freeze.
- **The verifier ladder runs cheapest-and-hardest-to-game first**: deterministic checks before any
  LLM judge, short-circuiting on the first fail. A rung that errors is **fail-closed**.
- **Two keys for DONE**: the frozen ladder passes *and* the independent, **veto-only** Sign-off
  approver does not veto. "Tests pass" is not "done".
- **The second key stays independent, and is labelled when it can't be.** `--model` picks the
  *agent's* model; the approver defaults to a different one. A collapse (`SELF-JUDGED` and kin) is
  labelled everywhere the run is reported — see [key independence](docs/reference.md#the-sign-off-approver-does-not-inherit---model).
- **The control flow has zero LLM calls.** A pure reducer owns all policy behind four narrow seams.
- **Every run is crash-safe and resumable.** A write-ahead log under `.goaly/<runId>/` makes runs
  replayable, `--resume`-able, and inspectable (`goaly runs list` / `show` / `watch`, `goaly ui`).
- **Stuck detection bails early with a typed reason** (no-diff, repeated failure, oscillation,
  harness crash, unevaluable contract, repeated timeout-with-no-diff, budget).

Under `--generate` (the default) the compiler also authors a one-time **setup** command, and a
**pre-flight** proves the frozen verification can run before any worker token is spent. A bar that
later proves unsatisfiable aborts as `CONTRACT_DEFECTIVE`; [re-contracting](docs/reference.md#re-contracting-a-defective-bar---recontract)
re-authors it under a **new** run id (no contract is ever mutated), and the signed
[defect corpus](docs/reference.md#the-defect-corpus-cross-run-learning) remembers the defect for future authoring.

## Features

Every row links to its section in the **[reference](docs/reference.md)**.

| Feature | Flags | In short |
| --- | --- | --- |
| [Generated verification](docs/reference.md#seal-the-contract-gate) | `--generate` | The LLM authors the check and setup; pinned by hash, guarded against tampering. |
| [Your own bar](docs/reference.md#the-verifier-ladder) | `--verify-cmd`, `--smoke` | Any command as the deterministic rung; `--smoke` runs the built artifact. |
| [Phased goals](docs/reference.md#phased-goals---phased) | `--phased` | A frozen plan (a DAG) of small sub-goals, plus cumulative acceptance on the original goal. |
| [Best-of-N worker](docs/reference.md#best-of-n-parallel-worker---candidates) | `--candidates N` | N isolated attempts per iteration; the frozen ladder picks the winner. Or say *"use 4 subagents"*. |
| [Parallel waves](docs/reference.md#cooperative-parallel-waves---parallel-phases-experimental) | `--parallel-phases` | Phases that declare `dependsOn` run concurrently, merge with git plumbing, re-verify. Experimental. |
| [Worktrees](docs/reference.md#worktrees---worktree) | `--worktree <name>` | The whole run in an isolated checkout; merge back with plain git. |
| [Harness autonomy](docs/reference.md#harness-autonomy---harness-autonomy) | `--harness-autonomy` | Let the agent install and build for a from-scratch goal; a refusal names the fix. |
| [Autonomy profiles](docs/reference.md#autonomy-profiles---mode) | `--mode` | `review` / `hands-off` / `aggressive` bundle the right flags; explicit flags override, loudly. |
| [Named presets](docs/reference.md#named-presets---preset) | `--preset` | Flag bundles by name: the built-in `default`, or your own from `"presets"` in `.goalyrc`. |
| [Dry run](docs/reference.md#dry-run---dry-run) | `--dry-run` | Validate the flags and `.goalyrc`, print the resolved config. Writes nothing, spends nothing. |
| [Adversarial review](docs/reference.md#hardening-against-reward-hacking) | `--adversarial` | Critics attack the contract before Seal; refuters attack every green before Sign-off. |
| [Satisfiability critic](docs/reference.md#the-satisfiability-critic-false-red-guard) | on by default; `--no-satisfiability-critic` | Before the freeze, one call asks whether a **correct** implementation could still fail the bar. |
| [Contract dry run](docs/reference.md#the-contract-dry-run-compile-time-positive-control) | on by default; `--contract-dry-run false` | A throwaway reference implementation runs against the bar in a scratch copy; red refuses the bar. |
| [Approver panels](docs/reference.md#hardening-against-reward-hacking) | `--approver-quorum`, `--approver-models` | Sign-off as a refute-first multi-vote panel, optionally across distinct models. |
| [Key independence](docs/reference.md#the-sign-off-approver-does-not-inherit---model) | `--approver-model` | The approver never inherits `--model` where a distinct model exists; a collapse is labelled. |
| [Sandboxing](docs/reference.md#sandboxing) | `--sandbox`, `--sandbox-net` | OS-jail the agent and verifier (bwrap / firejail / container), with egress allowlists. |
| [Operator control](docs/reference.md#operator-control-watch-steer-extend) | `--resume`, `--note` | Watch live, steer with notes, raise caps mid-run — never the frozen bar. |
| [Follow-ups](docs/reference.md#following-up-after-a-run-ends---from-run) | `--from-run` | A new re-verified goal that knows what the last run did. |
| [Web UI](docs/reference.md#web-ui-goaly-ui) | `goaly ui` | A localhost control center: dashboard, live pipeline, session inspector, browser Seal review. |
| [Spend & budgets](docs/reference.md#spend-report--budgets) | `--budget-tokens`, `--cost-table` | Per-layer token report (cache included); budgets survive resume. |
| [Observability](docs/reference.md#observability) | `--stream`, `--explain`, `--log-level` | Live agent turns, durable transcripts, plain-language narration. |
| [Onboarding](docs/reference.md#onboarding-goaly-doctor--goaly-init) | `goaly doctor`, `goaly init` | A read-only environment report, and a starter `.goalyrc` written interactively or headless. |
| [Reliability](docs/reference.md#reliability) | *(defaults)* | Preflight, bounded retries (contract and plan), safe Ctrl-C, fsync'd write-ahead log. |
| [Stuck detection](docs/reference.md#stuck-detection) | `--stuck-*` | Typed early aborts (no-diff, repeat-failure, oscillation, crash, …), each naming the flag that fixes it. |
| [Stuck self-recovery](docs/reference.md#automatic-remediation---auto-remediate-stuck) | `--auto-remediate-stuck` | Opt-in: up to 3 bounded self-recoveries before the run stops for the operator. |
| [Contract-fault adjudication](docs/reference.md#in-loop-contract-fault-adjudication-contract_defective) | *(defaults)* | A repeat-failure streak on a frozen authored file is re-adjudicated once; `CONTRACT_DEFECTIVE` keeps your tree. |
| [Re-contract successor run](docs/reference.md#re-contracting-a-defective-bar---recontract) | `--recontract`, `--max-recontracts` | Recover from a `CONTRACT_DEFECTIVE` bar and keep the tree: a new run, a new contract, chained. |
| [Defect corpus](docs/reference.md#the-defect-corpus-cross-run-learning) | on by default; `--no-defect-corpus`, `--defect-corpus <path>` | Adjudicated defects append a signed anti-pattern to `~/.goaly/defects.jsonl` for future authoring. |

## Usage

```bash
# Choose a harness, cap iterations, set a budget; resume a crashed run by id:
goaly run --goal "..." --verify-cmd "pytest -q" --harness codex --max-iterations 8 --budget-tokens 500000
goaly run --resume run-<id>

# One flag for a whole autonomy posture, or a named preset (goaly config presets lists them):
goaly "..." --verify-cmd "npm test" --mode hands-off     # or: --preset ship

# Check what a run WOULD do without starting one; inspect runs (or open the browser UI: goaly ui):
goaly run --goal "..." --generate --dry-run
goaly runs list && goaly runs show run-<id>

# First-time setup, then tab completion (zsh alike; fish: goaly completion fish | source):
goaly doctor && goaly init
source <(goaly completion bash)
```

`goaly help` prints a topic index; `goaly help <topic>` one section; `goaly help all` every flag.
The **[CLI cookbook](docs/reference.md#cli-cookbook)** has a worked example for every mode; a
**[config file](docs/reference.md#config-file)** (`.goalyrc` / `~/.goalyrc`, with a shipped JSON
Schema and `goaly config validate`) keeps repeated wiring out of your invocations. The LLM steps
**follow the harness** by default, so one installed CLI is enough; `--llm-provider` splits them.

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

`DriverDeps` hooks: `interrupted`, `sleep`, `onStreamEvent`, `telemetry`, and `observer`. There is
also an experimental [training pipeline](docs/reference.md#training-arc-experimental) on `goaly-code`.

## Docs

- **[Docs router](docs/README.md)** — "I want to… → read this", one table
- **[Reference](docs/reference.md)** — every flag, mode, and guarantee (start here for depth)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — how it is built · [`docs/adr/`](docs/adr/README.md) — why
  (decision records)
- [`CONTEXT.md`](CONTEXT.md) — the ubiquitous-language glossary
  ([plain-language version](docs/reference.md#glossary))
- [`docs/adding-a-harness.md`](docs/adding-a-harness.md) — wrap a new agent CLI
- [`CHANGELOG.md`](CHANGELOG.md) — what changed, per version

## License

[MIT](LICENSE) © krimvp
