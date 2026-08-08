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

- **The contract is frozen at Seal.** Its `contractHash` never changes again, and it's logged every
  iteration to prove the bar never moved. Under `--mode review` you approve it once — or revise it
  with feedback, or edit the authored files yourself and re-freeze. Autonomous runs (the implied
  `default` preset, `--autonomous`, `-d`) skip the pause, never the freeze.
- **The verifier ladder runs cheapest-and-hardest-to-game first**: deterministic checks (exit
  codes, tests) before any LLM judge, short-circuiting on the first fail. A rung that errors is
  **fail-closed** — a malformed grader is never a green.
- **Two keys for DONE**: the frozen ladder passes *and* the independent Sign-off approver — which
  runs only on a green and is **veto-only** — doesn't veto. "Tests pass" is not "done".
- **The second key is kept independent, and labelled when it can't be.** `--model X` picks the
  *agent's* model; the approver defaults to a **different** one wherever the provider offers it. If
  the agent, the judge rung and the approver still collapse onto one model, the run is recorded as
  a typed `SELF-JUDGED` degraded mode in the run header, the terminal summary and `goaly runs show`
  — so a DONE nobody independently reviewed is labelled everywhere it is reported.
- **The control flow has zero LLM calls.** A pure reducer owns all policy; everything stochastic
  hides behind narrow interfaces at four seams.
- **Every run is crash-safe and resumable.** A write-ahead log under `.goaly/<runId>/` makes runs
  replayable, `--resume`-able, and inspectable (`goaly runs list` / `show` / `watch`, or
  `goaly ui` in the browser).
- **Stuck detection bails early with a typed reason** (no-diff, repeated failure, oscillation,
  harness crash, unevaluable contract, repeated timeout-with-no-diff, budget) instead of burning
  iterations.

Under `--generate` (the default), the compiler also authors a one-time **setup** command and a
**pre-flight** proves the frozen verification can actually run — an unsound contract aborts before
any worker token is spent. And because that pre-flight happens at t=0, on a tree with no
implementation in it, goaly asks once more when the evidence finally exists: a repeat-failure
streak that keeps tripping a frozen authored check is re-adjudicated read-only, and an
unsatisfiable bar aborts as **`CONTRACT_DEFECTIVE`** — "the contract is broken, keep your tree" —
instead of blaming the worker. And that abort prints the way out:
`goaly --from-run <id> --recontract` keeps the tree, re-authors the bar from the defect report, and
freezes a **new** contract under a **new** run id with the predecessor recorded in its header. No
contract is ever mutated — "the bar was wrong" becomes an auditable chain, not an in-place softening.

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
| [Harness autonomy](docs/reference.md#harness-autonomy---harness-autonomy) | `--harness-autonomy` | Let the agent install & build for a from-scratch goal; a refusal names the fix, and the reviewed diff auto-pins to the run-start commit so agent commits stay visible. |
| [Autonomy profiles](docs/reference.md#autonomy-profiles---mode) | `--mode` | `review` / `hands-off` / `aggressive` bundle the right flag combinations; explicit flags override, loudly. |
| [Named presets](docs/reference.md#named-presets---preset) | `--preset` | Flag bundles selected by name — a language-neutral `default` ships built in, and `.goalyrc` (`"presets"`) defines or redefines your own; `"preset"` applies one on every run. One word instead of N flags. |
| [Dry run](docs/reference.md#dry-run---dry-run) | `--dry-run` | Validate the flags + `.goalyrc` and print the resolved config. Writes nothing, spends nothing. |
| [Adversarial review](docs/reference.md#hardening-against-reward-hacking) | `--adversarial` | Critics attack the contract before Seal; refuters attack every green before Sign-off. |
| [Satisfiability critic](docs/reference.md#the-satisfiability-critic-false-red-guard) | on by default; `--no-satisfiability-critic` | The mirror of red-teaming: one call before the freeze asks whether a **correct** implementation could still FAIL the authored bar — an unsatisfiable frozen bar costs the whole run. |
| [Contract dry run](docs/reference.md#the-contract-dry-run-compile-time-positive-control) | on by default; `--contract-dry-run false` | The positive control, by **execution** rather than opinion: before the freeze, a throwaway reference implementation runs against the authored bar in a scratch copy. Red ⇒ the bar is refused and re-authored. The reference never touches your tree. |
| [Approver panels](docs/reference.md#hardening-against-reward-hacking) | `--approver-quorum`, `--approver-models` | Sign-off as a refute-first multi-vote panel, optionally across distinct models. |
| [Key independence](docs/reference.md#the-sign-off-approver-does-not-inherit---model) | `--approver-model` | The approver never inherits the agent's `--model` where a distinct one exists; an irreducible collapse is labelled `SELF-JUDGED` in the header, summary and `runs show`. |
| [Sandboxing](docs/reference.md#sandboxing) | `--sandbox`, `--sandbox-net` | OS-jail the agent and verifier (bwrap / firejail / container), with egress allowlists. |
| [Operator control](docs/reference.md#operator-control-watch-steer-extend) | `--resume`, `--note` | Watch live, steer with notes, raise caps mid-run — never the frozen bar. |
| [Follow-ups](docs/reference.md#following-up-after-a-run-ends---from-run) | `--from-run` | A new re-verified goal that knows what the last run did. |
| [Web UI](docs/reference.md#web-ui-goaly-ui) | `goaly ui` | A local control center: mission dashboard, live pipeline + session inspector, worktrees, and a browser Seal review station. Localhost-only. |
| [Spend & budgets](docs/reference.md#spend-report--budgets) | `--budget-tokens`, `--cost-table` | Per-layer token report (cache included); budgets survive resume. |
| [Observability](docs/reference.md#observability) | `--stream`, `--explain`, `--log-level` | Live agent turns, durable transcripts, plain-language narration. |
| [Onboarding](docs/reference.md#onboarding-goaly-doctor--goaly-init) | `goaly doctor`, `goaly init` | A read-only environment report (Node, git, harness CLIs, config validity), and a starter `.goalyrc` written interactively or headless. |
| [Reliability](docs/reference.md#reliability) | *(defaults)* | Preflight, bounded retries (contract *and* plan), safe Ctrl-C, fsync'd write-ahead log. |
| [Stuck detection](docs/reference.md#stuck-detection) | `--stuck-*` | Typed early aborts — no-diff, repeat-failure, oscillation, harness crash, unevaluable contract, and repeated timeout-with-no-diff — each naming the flag that fixes it. |
| [Stuck self-recovery](docs/reference.md#automatic-remediation---auto-remediate-stuck) | `--auto-remediate-stuck` | Opt-in: up to 3 bounded self-recoveries (no-diff hint, one extra repeat/crash attempt) before stopping for the operator. |
| [Contract-fault adjudication](docs/reference.md#in-loop-contract-fault-adjudication-contract_defective) | *(defaults)* | A repeat-failure streak on a frozen authored file is re-adjudicated once, read-only, against the tree that now HAS an implementation: a `CONTRACT_DEFECTIVE` abort says the bar is broken and your tree is worth keeping. Fail-closed to today's abort. |
| [Re-contract successor run](docs/reference.md#re-contracting-a-defective-bar---recontract) | `--recontract`, `--max-recontracts` | Recover from a `CONTRACT_DEFECTIVE` bar without discarding a correct tree: a NEW run, NEW contractHash, defect report as authoring feedback, predecessor recorded in the header. No contract is ever mutated. |

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

# One flag for a whole autonomy posture (review | hands-off | aggressive):
goaly "..." --verify-cmd "npm test" --mode hands-off

# Or a named preset: the built-in 'default' works in any repo with zero config,
# and "presets" in .goalyrc defines (or redefines) your own:
goaly "..." --preset default
goaly "..." --preset ship          # goaly config presets lists what's defined

# Check what a run WOULD do — flags, .goalyrc, models, budgets — without starting one:
goaly run --goal "..." --generate --dry-run

# Inspect and follow runs (read-only), or open the browser UI:
goaly runs list
goaly runs show run-<id>
goaly ui

# First-time setup: environment report, then a starter .goalyrc:
goaly doctor
goaly init

# Tab completion for every subcommand and flag (zsh alike; fish: goaly completion fish | source):
source <(goaly completion bash)
```

`goaly help` lists every flag. The **[CLI cookbook](docs/reference.md#cli-cookbook)** has a worked
example for every mode; a **[config file](docs/reference.md#config-file)** (`.goalyrc` /
`~/.goalyrc`) keeps repeated wiring out of your invocations — with a shipped JSON Schema
(`goalyrc.schema.json`) for editor auto-completion and `goaly config validate <path>` for the
run-path verdict.

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
