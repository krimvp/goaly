# goaly reference

The complete practical reference: every flag, mode, and guarantee. The [README](../README.md) is
the short tour; this is the depth. Architecture lives in [`ARCHITECTURE.md`](../ARCHITECTURE.md),
rationale in [`DESIGN.md`](../DESIGN.md) and [`docs/adr/`](adr/), the terse contributor glossary in
[`CONTEXT.md`](../CONTEXT.md).

## Contents

- [CLI cookbook](#cli-cookbook)
- [Autonomy profiles](#autonomy-profiles---mode)
- [Named presets](#named-presets---preset)
- [Onboarding](#onboarding-goaly-doctor--goaly-init)
- [Dry run](#dry-run---dry-run)
- [Config file](#config-file)
- [Model & provider selection](#model--provider-selection)
- [Harnesses](#harnesses)
- [Per-step timeouts](#per-step-timeouts)
- [Seal: the contract gate](#seal-the-contract-gate)
- [Setup, preflight & soundness](#setup-preflight--soundness)
- [The verifier ladder](#the-verifier-ladder)
- [Stuck detection](#stuck-detection)
- [Diff baselines](#diff-baselines---baseline-and---delta-verify)
- [Best-of-N parallel worker](#best-of-n-parallel-worker---candidates)
- [Phased goals](#phased-goals---phased)
- [Cooperative parallel waves](#cooperative-parallel-waves---parallel-phases-experimental)
- [Worktrees](#worktrees---worktree)
- [Reliability](#reliability)
- [Operator control](#operator-control-watch-steer-extend)
- [Inspecting past runs](#inspecting-past-runs)
- [Following up](#following-up-after-a-run-ends---from-run)
- [Re-contracting a defective bar](#re-contracting-a-defective-bar---recontract)
- [The defect corpus](#the-defect-corpus-cross-run-learning)
- [Web UI](#web-ui-goaly-ui)
- [Observability](#observability)
- [Spend report & budgets](#spend-report--budgets)
- [Hardening against reward-hacking](#hardening-against-reward-hacking)
- [Sandboxing](#sandboxing)
- [Training arc](#training-arc-experimental)
- [Glossary](#glossary)

## CLI cookbook

```bash
# Easiest: just the goal. The LLM authors the verification (--generate) and checks the work,
# on Claude by default. A human approves the frozen contract once at Seal:
goaly "make the parser handle empty input"

# Fully hands-off: -d (alias --defaults) auto-accepts the still-frozen, still-logged contract:
goaly -d "add a /health endpoint returning 200"

# Point at an existing test command instead of generating one:
goaly run --goal "make the parser handle empty input" --verify-cmd "npm test"

# Generated verification, unattended, with an authored one-time setup (e.g. `npm ci`):
goaly run --goal "add a /health endpoint returning 200" --generate --autonomous

# Override the authored setup (or add one on the --verify-cmd path); --no-setup disables it:
goaly run --goal "..." --verify-cmd "npm test" --setup-cmd "npm ci" --setup-timeout-ms 120000

# Long goal from a file (or stdin), with up to 3 interactive Seal revisions:
goaly run --goal-file ./GOAL.md --generate --max-seal-revisions 3
cat ./GOAL.md | goaly run --goal - --generate --autonomous   # stdin needs --autonomous

# Choose a harness, cap iterations, set a budget; resume a crashed run by id alone:
goaly run --goal "..." --verify-cmd "pytest -q" --harness codex --max-iterations 8 \
          --budget-tokens 500000 --workspace ./myrepo
goaly run --resume run-<id> --workspace ./myrepo

# Follow up on a FINISHED run with a new, re-verified goal that knows what just happened:
goaly "now also handle empty input" --from-run run-<id>
goaly "now also handle empty input" --from-run run-<id> --inherit-session  # keep agent memory too

# Diff against a baseline instead of HEAD; keep long-run judge prompts flat:
goaly run --goal "step 2" --verify-cmd "npm test" --baseline <ref-or-sha>
goaly run --goal "..." --verify-cmd "npm test" --delta-verify

# Best-of-N: 3 isolated attempts per iteration, keep the one furthest up the frozen ladder:
goaly run --goal "..." --verify-cmd "npm test" --candidates 3   # or --best-of 3

# Run in an isolated, named worktree — the main tree is never touched:
goaly "add a /health endpoint" --verify-cmd "npm test" --worktree health
goaly worktree list

# Red-team the run: critics attack the authored contract, refuters attack every green:
goaly run --goal "..." --generate --autonomous --adversarial --critic-model claude-opus-4-8

# Different models for the harness vs. the LLM steps (judge/approver/compiler):
goaly run --goal "..." --verify-cmd "npm test" --harness claude \
          --model claude-opus-4-8 --llm-model claude-sonnet-4-6

# The LLM steps follow the harness by default (one installed CLI is enough)…
goaly run --goal "..." --generate --autonomous --harness codex --model gpt-5-codex --judge-model o3
# …or split them onto a different CLI entirely:
goaly run --goal "..." --generate --autonomous --harness codex \
          --model gpt-5-codex --llm-provider claude --llm-model claude-opus-4-8

# No coding CLI at all: goaly's own agent loop against any OpenAI-compatible endpoint:
goaly run --goal "..." --verify-cmd "npm test" --harness goaly-code \
          --base-url https://api.openai.com/v1 --model gpt-5        # reads OPENAI_API_KEY
goaly run --goal "..." --autonomous --harness goaly-code \
          --base-url http://localhost:11434/v1 --model qwen2.5-coder --approver-model llama3.1

# Observability: step-by-step logs, live agent turns, durable transcript, plain-language narration:
goaly run --goal "..." --verify-cmd "npm test" --log-level debug
goaly run --goal "..." --verify-cmd "npm test" --stream
goaly run --goal "..." --verify-cmd "npm test" --stream-transcript
goaly run --goal "..." --verify-cmd "npm test" --explain --explain-model haiku

# Timeouts: hard caps per step, or kill the agent only when it stalls:
goaly run --goal "..." --verify-cmd "npm test" \
          --harness-timeout-ms 900000 --llm-timeout-ms 120000 --verify-timeout-ms 60000
goaly run --goal "..." --generate --harness-idle-timeout-ms 180000

# A deterministic runtime smoke rung — run the built thing, fail on any runtime error:
goaly run --goal "build a /health endpoint" --generate --smoke "node smoke.mjs"

# Phased: decompose a big goal into a frozen plan of small sub-goals + cumulative acceptance:
goaly run --goal-file ./BIG_GOAL.md --verify-cmd "npm test" --phased --autonomous --max-phases 6
goaly run --goal-file ./BIG_GOAL.md --generate --phased --plan-file ./plan.json

# EXPERIMENTAL parallel waves: group-tagged plan phases run concurrently, merge with git
# plumbing, re-verify on the combined tree (requires --autonomous; see the reference section):
goaly run --goal-file ./BIG_GOAL.md --verify-cmd "npm test" --phased --autonomous \
          --parallel-phases --plan-file ./plan.json

# Jail the agent AND the verifier in an OS sandbox:
goaly run --goal "..." --verify-cmd "npm test" --sandbox                            # auto-detect
goaly run --goal "..." --verify-cmd "npm test" --sandbox=bwrap --sandbox-net allow  # let npm fetch

# USD cost overlay on the spend report (tokens-only without it):
goaly run --goal "..." --verify-cmd "npm test" --cost-table ./prices.json

# Validate the flags + .goalyrc and print the resolved config, without starting a run:
goaly run --goal "..." --generate --phased --dry-run

# From-scratch build with droid: raise its autonomy so it may install & build (default is `low`,
# which forbids both — and `low` is what keeps `git diff HEAD` honest, so raise it deliberately):
goaly run --goal "..." --generate --harness droid --harness-autonomy medium

# Inspect past runs (read-only; re-runs nothing) — or in the browser:
goaly runs list
goaly runs show run-<id>
goaly runs resume-cmd run-<id>
goaly ui                          # http://127.0.0.1:4180, localhost-only

# First-time setup: check the environment, then write a starter .goalyrc:
goaly doctor
goaly init                        # interactive on a TTY; or headless:
goaly init --harness codex --autonomous --yes

# Tab completion (bash shown; zsh alike; fish: goaly completion fish | source):
source <(goaly completion bash)
```

`goaly help` lists every flag. Exit codes: `0` DONE · `1` FAILED/ABORTED · `2` usage error ·
`130` interrupted (Ctrl-C; the run stays resumable).

Goal, intent, and rubric each accept exactly one source: inline (`--goal "…"`, `--intent "…"`,
`--rubric "…"`), a file (`--goal-file <path>`, `--intent-file <path>`, `--rubric-file <path>`),
or stdin (`--goal -`). More than one source per field is a usage error. `--intent` steers what
kind of verification `--generate` authors (e.g. "verify with an integration test, not unit
tests"); `--rubric` overrides the frozen rubric the judge and Sign-off approver hold the work to.

`--verify-cmd` and `--generate` are mutually exclusive: passing both **on the command line** is a
usage error. A `--generate` on the command line still overrides a `verify-cmd` inherited from a
config file — that is an ordinary one-off override — but says so with a warning naming the source
that lost.

## Autonomy profiles (`--mode`)

`--mode review|hands-off|aggressive` bundles the flags that make up a coherent autonomy posture,
so the right combination is one flag instead of five. Profiles expand **at parse time** into the
same explicit flag values you could type by hand — the reducer and the frozen `RunConfig` see
nothing new, and every expansion is logged. Layering: config files < profile < explicit CLI
flags; any flag you also type beats the profile, and the override is reported loudly.

| Profile | Expands to | Posture |
| --- | --- | --- |
| `review` | `--harness-autonomy low`, and **drops** a config-file `autonomous`/`adversarial`/`candidates` | A human at every gate; the least-privileged worker. |
| `hands-off` | `--autonomous --harness-autonomy medium --delta-verify --candidates 1` | Unattended but conservative; warns if no independent `--approver-model(s)` is set. |
| `aggressive` | `--autonomous --harness-autonomy high --adversarial --candidates 3 --auto-remediate-stuck` | Unattended and maximal: red-teamed contract, best-of-3 workers, full worker privileges, bounded stuck self-recovery. |

```bash
goaly "add a /health endpoint" --verify-cmd "npm test" --mode hands-off
goaly "fix the flaky test" --generate --mode aggressive --approver-model claude-opus-4-8
goaly "refactor the parser" --verify-cmd "npm test" --mode hands-off --harness-autonomy low  # explicit wins, loudly
```

`mode` is also a `.goalyrc` key, so a project can default to `review` while an operator opts a
single run into `hands-off` from the command line.

## Named presets (`--preset`)

Where `--mode` bundles the fixed autonomy postures, a preset bundles **your** flags: a
named block you define once under `"presets"` in any config layer, selected with
`--preset <name>` — one word instead of retyping (or remembering) the whole configuration.
A preset body takes the same kebab-case keys as the config file itself (minus `preset` — no
chaining), including `mode`, so a preset can pair an autonomy posture with project wiring.

**One preset ships built in**, so presets work before any config file exists: `default`,
the most straightforward complete run — `{ "mode": "hands-off" }`, everything else left to the
tool defaults. Built-in presets are deliberately **language- and toolchain-neutral**: no verify
command, no setup command, no harness or model choice. Verification falls back to the
`--generate` default (the LLM authors checks for whatever project it finds), so it works the
same in a Rust crate, a Python package, or a Node repo. Redefine `default` in a config file to
make it yours — a redefinition replaces the built-in wholesale, exactly like one config layer
over another.

**`default` is truly the default: it applies without being asked for.** A run that chooses
neither a preset nor a mode gets the `default` preset implicitly — `goaly "<goal>"` and `goaly
--preset default "<goal>"` are the same run. The implied application is deliberately the
**weakest tier there is**: it fills gaps only, so any key a config file or an explicit flag sets
wins, and choosing any `--mode` or `--preset` suppresses it entirely (a chosen posture is never
mixed with an implied one). It is announced on every run with its off-switches; `--preset none`
opts out for one invocation, a persisted `"preset": "none"` for a whole tree, and a config-file
`"mode"` (e.g. `review`) pins a project to an explicit posture instead.

```jsonc
// .goalyrc — preset bodies stay toolchain-neutral; project wiring like a verify
// command belongs in the base keys, where every preset inherits it
{
  "presets": {
    "quick": { "mode": "review", "max-iterations": 3 },
    "ship":  { "mode": "hands-off", "budget-tokens": 500000, "delta-verify": true },
    "nightly": { "mode": "aggressive", "candidates": 3, "stream-transcript": true }
  },
  "preset": "quick"   // optional: applied on every run unless overridden
}
```

```bash
goaly "fix the flaky test"                   # the implied 'default' preset: hands-off, any repo
goaly "fix the flaky test" --preset ship     # one word selects the whole way of running
goaly "audit the parser"                     # a persisted "preset": "quick" applies instead
goaly "hotfix" --preset none                 # bare tool defaults for one invocation
goaly config presets                         # what is defined, from which source, with which keys
```

Like a mode, a chosen preset expands **at parse time** into the same explicit flag values you
could type by hand — nothing invisible reaches the loop, and every expansion is logged with its
defining file. Layering: **implied `default` < config base keys < chosen preset < `--mode` <
explicit CLI flags**; any flag you also type beats the preset, and the override is reported
loudly. A persisted `"preset"` selection is announced on every run together with its off-switch
(`--preset none`), so it can never become silent state. An unknown name fails closed listing
what *is* defined.

Presets resolve across the built-ins plus the same three config layers; a later layer that
redefines a name (built-in or not) replaces it **wholesale** (no body merging) — the nearest
definition wins, debuggably. `goaly config presets` lists the resolved result; its `--names`
form prints bare names and feeds the shell completion for `--preset`.

## Onboarding (`goaly doctor` / `goaly init`)

Two subcommands cover first-time setup, so the common early failures (missing CLI, no git repo,
unparsable config) surface as one actionable report instead of a cryptic mid-run error.

**`goaly doctor`** is a READ-ONLY environment report. It checks:

- the Node version against the supported floor (>= 20),
- git availability and whether the workspace is a git work tree (not fatal — runs fall back to
  `--workspace-mode file`; the report prints the `git init` recipe for full git-mode features),
- which bundled harness CLIs (`claude`, `codex`, `droid`, `pi`) are on PATH — none installed is
  only a warning, since `--harness goaly-code` works against any OpenAI-compatible endpoint,
- presence **and validity** of `~/.goalyrc` and the workspace `.goalyrc` (an invalid config file
  fails every run in the tree, so it is a hard failure here),
- with `--base-url <url>`: whether the OpenAI-compatible endpoint answers (a `GET /models` probe).

Exit code `0` means goaly can run here in some configuration; `1` means something goaly cannot
work around needs fixing first. It writes nothing.

**`goaly init`** writes a starter `.goalyrc` in the workspace: default harness, autonomy
preference, optional model and verify-command defaults. It runs `goaly doctor` first so
environment gaps are visible before defaults are saved. On a TTY it asks interactively (empty
answers accept the defaults); with flags (`--harness`, `--autonomous`, `--model`,
`--verify-cmd`) or `--yes` it is fully headless for CI. The candidate config is validated
against the same fail-closed schema every run parses before a byte is written, and an existing
`.goalyrc` is never overwritten without `--force`.

```bash
goaly doctor --base-url http://localhost:11434/v1   # is my local endpoint reachable?
goaly init --harness goaly-code --yes               # headless starter config
```

**Shell completion.** `goaly completion bash|zsh|fish` prints a tab-completion script covering
every subcommand and every documented flag (the list is extracted from `goaly help`, so it can
never lag the docs). Install with one line — `source <(goaly completion bash)` (zsh alike), or
`goaly completion fish | source` — and add it to your shell rc to make it permanent.

## Dry run (`--dry-run`)

Resolve everything, run nothing:

```bash
goaly run --goal "..." --generate --phased --dry-run
```

It prints the fully-merged, fully-validated configuration — resolved verifier intent, harness and
autonomy, provider and every model, budgets, per-step timeouts, stuck thresholds, baseline, sandbox,
and which config files contributed — then exits `0`. That includes what the **second key** will run
on (`sign-off model (2nd key)`) and a `degraded mode` row when the agent, the judge rung and the
approver all collapse onto one model — see
[degraded mode](#degraded-mode-self-judged).

It runs **after** every read-only check a real run performs (config merge, `--cost-table`,
`--baseline` resolution, `--resume` / `--from-run` log reads, the preflight) and **before** the first
byte is written. So a dry run fails exactly the way the real run would, with the same message and
the same exit code — and on success leaves no run directory, no lock, no diagnostics log, and no
`--worktree`. Nothing is spent: no LLM is called, because the contract is compiled after this point.

`--dry-run` is per-invocation and cannot be set from a config file.

## Config file

`goaly run` reads default flags from JSON config in three layers (later overrides earlier):

1. `~/.goalyrc` — personal defaults across every project (optional),
2. `.goalyrc` discovered in `--workspace` / the current directory (optional),
3. an explicit `--config <path>` — when given it must exist (fails closed).

Keys mirror the CLI flags in kebab-case. Full precedence:
**CLI flag > `--config` > `<workspace>/.goalyrc` > `~/.goalyrc` > tool default**.

```jsonc
// ~/.goalyrc — run hands-off everywhere (generate + Claude already apply by default)
{ "autonomous": true }
```

```jsonc
// .goalyrc — committed once, applies to every run in this repo
{
  "harness": "codex",
  "verify-cmd": "npm test",
  "autonomous": true,
  "max-iterations": 8,
  "budget-tokens": 500000,
  "diff-ignore": "coverage,build",
  "stuck-crash-threshold": 4,
  "stream": true
}
```

Booleans take `true`/`false` (`false` = "not set"). An unknown key, non-primitive value, or invalid
JSON is a usage error (the config seam parses with Zod and fails closed).

A file may also carry a `"presets"` block (named bundles of the same keys, selected with
`--preset <name>`) and a top-level `"preset"` default — see
[Named presets](#named-presets---preset).

**Every documented `goaly run` flag is settable from a file**, except the per-invocation ones, which
are deliberately excluded and enumerated: `--resume`, `--from-run`, `--inherit-session`,
`--recontract`, `--max-recontracts`, `--workspace`, `--worktree`, `--config` itself, `--note`,
`--dry-run`, the `--*-file` input-source selectors, and the `--defaults` alias. Because the schema is strict, that list is the whole
difference — and a test enforces it, so a newly added flag cannot quietly become unpersistable.

### Validating and editing configs

`goaly config validate <path>` parses a config file through the exact fail-closed path every run
uses and reports the verdict (exit `0` valid / `1` invalid / `2` unreadable) — so "this file
validates" and "a run accepts this file" are one fact. It reports the presets a file defines
alongside its settings. `goaly config presets [--names] [--workspace <dir>]` lists the named
presets exactly as a run would resolve them across all layers.
`goaly config defects list|clear [--defect-corpus <path>]` inspects or resets the cross-run
[defect corpus](#the-defect-corpus-cross-run-learning).

For editor auto-completion and inline validation, a JSON Schema is generated from the same Zod
shape (`npm run gen:schema`) and ships as `goalyrc.schema.json` at the package root and in
`dist/`. Register it for `.goalyrc` files:

- **VS Code** — in `settings.json`:

  ```json
  "json.schemas": [
    { "fileMatch": [".goalyrc"], "url": "./node_modules/goaly/goalyrc.schema.json" }
  ]
  ```

- **Zed** — in `settings.json` under `lsp.json-language-server.settings.json.schemas`, same
  `fileMatch`/`url` shape.
- **Vim/Neovim** (jsonls) — add the same entry to the server's `settings.json.schemas` list.

A drift test regenerates the schema in-memory and diffs it against the checked-in file, so a new
config key cannot ship without the schema (and `npm run build` regenerates it as its first step).

## Model & provider selection

Model selection is pure wiring — it never enters the frozen contract.

| Flag | Scope |
| --- | --- |
| `--model` | global default: the harness *and* the LLM steps |
| `--llm-model` | all LLM steps (compiler / judge / approver) |
| `--judge-model`, `--approver-model`, `--compiler-model`, `--critic-model`, `--explain-model` | one step each |
| `--llm-provider` | which CLI/provider runs the LLM steps (`claude` / `codex` / `droid` / `pi` / `openai`) |

Precedence per LLM step: per-step flag → `--llm-model` → `--model` → the tool's own default.
`--llm-provider` **follows `--harness`** by default (`codex` → `codex`, `goaly-code` → `openai`),
so the compiler that authors a `--generate` bar runs on the tool you picked; pass the flag to split
the LLM steps onto a different provider than the worker.

### The Sign-off approver does not inherit `--model`

One deliberate exception to the cascade: `--model X` picks the **coding agent's** model, so letting
the second key inherit it would collapse the agent, the judge rung and the approver onto one
distribution — invariant 3 satisfied mechanically while defeated statistically. Where the
environment permits it, goaly therefore defaults the approver to a model **distinct** from the
agent's:

| Wiring | Approver model |
| --- | --- |
| `--model X` (provider has its own default model) | the provider's own default — **not** `X`; announced in the log |
| `--model X --llm-provider openai` | `X` (that provider has no default model of its own; changing it would refuse to start) |
| `--llm-model L` | `L` — an explicit choice for the LLM steps is always obeyed |
| `--approver-model A` / `--approver-models …` | `A` / the panel — always wins |
| no `--model` at all | the tool default (only one model is available — see the degraded-mode label below) |

It is **non-blocking and best-effort**: goaly compares the models it was *asked* for and cannot
resolve a CLI's own default model id, so a `--model` that happens to name that same default is not
detectable. To restore the old inheriting behavior explicitly, pass `--approver-model <the same
model>`; to choose the skeptic yourself, pass a different one.

### Degraded mode: `SELF-JUDGED`

When the coding agent, the LLM judge rung **and** the Sign-off approver all still resolve to one
model — the zero-config default run, where only one model is available — the run is recorded as a
typed **degraded mode** (`kind: "self-judged"`) in the run-log header, alongside whether the bar was
`--generate`-authored and whether Seal was `--autonomous`. It is surfaced wherever the run is
reported:

```
── goaly run run-… ──
status:      DONE
degraded:    SELF-JUDGED — the coding agent, the LLM judge rung and the Sign-off approver all ran on
             one model (the tool default) (--generate --autonomous) — the two keys are not
             independent, so treat this run with the corresponding suspicion. Pass
             --approver-model <other-model> (or --approver-models) for an independent second key.
```

The same line appears in `goaly runs show <id>` (and the header field is readable by any downstream
consumer — CI, the UI), so a DONE that nobody independently reviewed is *labelled* as such rather
than only warned about at startup — a warning nobody is present to read is a record, not a control.

The label is exactly that: a **label**. It never weakens or strengthens a gate — the frozen ladder
and the veto-only approver still both have to turn for DONE — and it never enters the frozen
contract. Setting `--approver-model` (or `--approver-models` with ≥2 distinct models) removes it.

Approver-panel flags (`--approver-quorum`, `--approver-models`, `--approver-lenses`,
`--approver-diversity-temp`) are covered under
[Hardening](#hardening-against-reward-hacking).

## Harnesses

`--harness` picks the write-role coding agent: `claude` (default), `codex`, `droid`, `pi`, or
`goaly-code`.

- The CLI harnesses shell out to their respective CLIs.
  [`pi`](https://pi.dev) is provider-agnostic: pass `--model "provider/id"`
  (e.g. `"anthropic/claude-opus-4-8"`, `"ollama/qwen3:8b"`) or omit it to use pi's configured
  default.
- **`goaly-code`** needs no coding CLI: goaly runs its own tool-use loop against any
  OpenAI-compatible chat-completions endpoint. Set `--base-url <url>` (`/chat/completions` is
  appended) and a `--model`; the bearer token is read from `OPENAI_API_KEY`
  (`--llm-api-key-env <NAME>` overrides; a keyless local endpoint like ollama needs none). The
  read-only LLM steps default onto the same endpoint. Both fail closed (refuse to start) if the
  base URL or model is missing.
- **`--max-agent-turns N`** (default 50) caps the `goaly-code` agent loop per run. Hitting the cap
  ends the turn as `truncated` — not a failure — and the loop grants another iteration. Raise to
  100–200 for hard from-scratch tasks. A no-op for the CLI harnesses (they manage their own turn
  budgets).

### Harness autonomy (`--harness-autonomy`)

`low | medium | high` — how much the write-role CLI is allowed to do, for CLIs that gate privileged
actions behind a tier. Today that is **droid** (`droid exec --auto <level>`); harnesses without such
a tier ignore the flag. Absent ⇒ the CLI's own least-privilege level.

droid's default is **`low`**: edit files, but no git, no package installs, no builds. That default is
load-bearing — `low` cannot `git commit`, and a commit would empty `git diff HEAD`, which is the diff
both keys review. It is also **fatal for a from-scratch build**: the first thing an agent must do on
an empty tree is install dependencies, so a `--generate` contract that requires a populated tree can
never go green at `low`. Raise it deliberately:

```bash
goaly run --goal "..." --generate --harness droid --harness-autonomy medium
```

Above `low` the agent can `git commit`, which would move `HEAD` and hide the committed work from
both keys — so goaly **auto-pins the review baseline** to the run-start commit's SHA whenever the
tier is raised (announced in the log; an explicit `--baseline <ref>` wins). The pin is recorded in
the run-log header, so a `--resume` re-adopts it even after the agent has committed. Only a tree
with no resolvable `HEAD` (a fresh `git init` with no commits) can't be pinned — goaly then warns
loudly and falls back to the manual `--baseline` advice.

The **read-only** LLM role (judge / approver / compiler) never receives this: it stays on droid's
read-only default by construction, so a reviewer can never mutate the tree it is reviewing.

If droid refuses an action at its current tier, goaly recognises the refusal and the resulting
`STUCK_HARNESS_CRASH` names `--harness-autonomy` instead of the generic "check your install and
auth" advice — see [Stuck detection](#stuck-detection).

Adding your own harness is one codec module + one registration line — see
[`adding-a-harness.md`](adding-a-harness.md).

## Per-step timeouts

Each subprocess has a wall-clock kill-timeout — pure wiring, never part of the frozen contract:

| Flag | Step | Default |
| --- | --- | --- |
| `--harness-timeout-ms` | the coding-agent subprocess (hard cap) | 600000 (10 min) |
| `--harness-idle-timeout-ms` | the coding-agent subprocess (idle/heartbeat cap) | off |
| `--llm-timeout-ms` | each LLM step (judge / approver / compiler) | 600000 |
| `--verify-timeout-ms` | the verify command | 600000 |

A verify command that exceeds its timeout is SIGKILL'd (whole process group) and reported as a
fail-closed could-not-evaluate — never a green.

**Idle vs wall-clock.** Real multi-file builds routinely exceed a hard cap mid-edit.
`--harness-idle-timeout-ms N` kills the agent only after N ms with **no stream output** — an
actively-editing turn keeps resetting the heartbeat; a stalled one is still reaped. When both are
set, the wall-clock cap remains the absolute backstop. Setting an idle timeout auto-enables the
CLI's per-turn streaming so the heartbeat actually sees progress (displaying it is still opt-in via
`--stream`). If you leave it off and turns keep getting cut short with nothing to show, the
[`timeout-no-diff`](#stuck-detection) detector stops the run and points you back here instead of
letting it burn the iteration budget.

**Heavy `--generate` authoring may need a larger `--llm-timeout-ms`.** The compiler authors the
whole contract in one call; a timeout there surfaces as a `COMPILE_FAILED` with a hint naming this
flag (re-issuing the same heavy call would just time out again).

## Seal: the contract gate

On a non-autonomous run (e.g. `--mode review`, or `--preset none` without other autonomy flags —
the implied [`default` preset](#named-presets---preset) otherwise runs hands-off) goaly prints
the frozen contract at Seal and prompts:

```
Approve, revise with feedback, or reject? [a]pprove / [f]eedback / [r]eject:
```

- `a` / `approve` (or `y`) — accept and start the loop.
- `f` / `feedback` — type a free-text note; goaly re-authors the contract from it and re-presents,
  up to `--max-seal-revisions` times (default 10; `0` disables). Empty feedback is a reject.
- `r` / `reject` (or anything else) — abort; the loop never starts.
- `e` / `edited` — after changing the authored verification files in your own editor: goaly
  re-reads them from disk, re-pins their content hashes, **re-freezes** the contract (a new, logged
  `contractHash`) and re-presents it. Without this a manual edit would trip the anti-tamper guard on
  iteration 1. A refreeze costs no LLM tokens and never consumes the revise cap
  ([ADR 0016](adr/0016-seal-review-station.md)).

`--autonomous` skips the pause, never the freeze — the contract is still frozen and loudly logged.
Piping the goal via stdin (`--goal -`) consumes stdin, so there's nothing left for the prompt —
use `--autonomous` or `--goal-file`.

**What the banner shows.** The goal, the `contractHash`, any frozen `setup` and `requiredTools`, the
rubric **once**, then the ladder *as it will actually run* — including the built-in
[generated-files integrity guard](#the-verifier-ladder) as rung `[0]` whenever the
compiler authored verification files (it is part of the ladder, never part of the `contractHash`).
A judge rung whose rubric is identical to the contract rubric points back at it instead of repeating
it. So the rung numbers you read at Seal line up with the `rungsPassed`/`rungsTotal` reported in
every verdict.

**Authoring is resilient, not one-shot.** A `COMPILE_FAILED` (a correctable authoring mistake)
re-authors the verification with the error fed back, up to `--max-compile-retries` (default 2;
`0` disables). A `PLAN_FAILED` under `--phased` does the same one step earlier, up to
`--max-plan-retries` (default 2; `0` disables) — without it a single non-JSON reply from the
planner ends the run at iteration 0, before any work, and the only other re-author path (the
plan-Seal revise) can never fire because the run has already ended. A **timeout** in either seam is
reported with a hint to raise `--llm-timeout-ms` rather than consuming the retry budget: re-issuing a
call that timed out only times out again. Exhausting either budget is a typed `FAILED`, never a
skipped check or a plan accepted unvalidated. Where the provider
supports it (the `claude` CLI), every re-author round — compile retry, Seal revise, red-team
re-author, re-plan — resumes the author's own prior session and sends only the feedback as a small
delta turn (falling back to a fresh full-prompt call on any resume failure). goaly mints its own
per-authoring session id so the resumed session provably contains only the author's turns. The
judge, approver, and refuter panels always run fresh, independent sessions — that separation is a
security property.

## Setup, preflight & soundness

Everything here runs **once**, after Seal and before iteration 1, so a broken bar is caught before
any worker token is spent.

**Required-tools preflight.** Every contract carries a frozen `requiredTools` manifest — the
external programs the verification assumes on PATH (`cargo`, `pytest`, `go`, …). Under
`--generate` the compiler authors it; with `--verify-cmd` it's derived heuristically. goaly probes
each tool before the loop. A missing tool is, by default, **handed to the agent to install**: the
missing tools plus the setup command are threaded into the first prompt as a bootstrap step.
`--install-missing-tools false` opts out — a missing tool is then a typed, fail-closed
`TOOLS_MISSING` abort with guidance. The verify/setup PATH is extended with the standard per-user
install dirs (`~/.cargo/bin`, `~/.local/bin`, `~/go/bin`, …) so an agent-installed toolchain is
visible to the verifier. The manifest is shown at Seal and is part of the `contractHash`.

**One-time setup.** Under `--generate` the compiler authors a setup command (e.g. `npm ci`);
`--setup-cmd` overrides it and `--no-setup` disables it. Failure is provenance-aware:

- a failing **user** `--setup-cmd` is a typed, fail-closed `SETUP_FAILED` — the worker never starts
  on a broken tree. Exit `127` (the toolchain simply isn't installed) adds a hint pointing at
  `--setup-cmd` / `--no-setup`;
- a failing **compiler-authored** setup is best-effort: on a from-scratch `--generate` build an
  authored `npm ci` presupposes scaffolding the agent hasn't written yet, so a non-zero exit is
  expected — goaly logs it loudly, threads a recovery note into the first prompt, and proceeds.

The setup command is frozen into the contract (shown at Seal) so it can't drift.

**Pre-flight & soundness.** The frozen deterministic checks run once before the first agent turn.
When one fails, a single language-agnostic classification (one read-only LLM call) decides:

- the frozen verification is **broken** (a defect inside the frozen files — it can't
  compile/collect/run, which the agent can never fix) → a typed `CONTRACT_UNSOUND` abort;
- an **honest red** (the implementation is simply missing) → proceed to the loop.

On a from-scratch tree the bar is red by definition, so that signal is threaded into the classifier:
an honest red proceeds, while a frozen verifier that itself can't run is still caught. The **green
mirror** is caught too: an authored verifier that *already passes* on a from-scratch tree means the
compiler authored the solution itself into the frozen set, or the bar is vacuous — a second
read-only call classifies a confident `CONTRACT_UNSOUND` before any worker token. Both directions
**fail open** on any uncertainty (no LLM / an error / a "sound" verdict all proceed) — a genuinely
broken frozen verifier is also caught at runtime by repeat-failure stuck detection, which can
itself re-adjudicate the contract in-loop (`CONTRACT_DEFECTIVE`, see
[below](#in-loop-contract-fault-adjudication-contract_defective)). A plain `--verify-cmd` run with
no authored files skips the soundness check.

## The verifier ladder

The composite check runs **cheapest-and-hardest-to-game first**: deterministic rungs (exit codes,
tests) before any LLM judge, short-circuiting on the first deterministic fail. A rung that errors
is fail-closed — a malformed grader is never a green.

- **Guard rung (built-in, `--generate`).** Files goaly authors are pinned by content hash inside
  the frozen contract; an integrity guard runs first every iteration and fails closed if any
  authored file changed since the contract froze. It is printed as rung `[0]` in the
  [Seal banner](#seal-the-contract-gate) and counted in each verdict's `rungsTotal`, so the ladder
  you approve is the ladder that runs.
- **Deterministic rungs.** Your `--verify-cmd` (or the authored command): `pass = exit 0`.
- **Smoke rung (`--smoke "<cmd>"`).** An extra deterministic rung that *executes* the built
  artifact — a headless-browser script, a server probe, a CLI smoke — for goals whose correctness
  only shows at runtime. Runs after `--verify-cmd`, before the judge; frozen into the contract like
  any rung. (Plain `--verify-cmd "npm test && node smoke.mjs"` works too; `--smoke` gives the
  runtime check its own labeled rung and failure feedback.)
- **Judge rung.** An LLM quorum over the diff for fuzzy criteria, judged against the frozen rubric.
- **Refuter rung (built-in, `--adversarial`).** A refute-first skeptic panel appended last; it runs
  only on a candidate green and can only fail it. See
  [Hardening](#hardening-against-reward-hacking).

**Two keys for DONE:** the frozen ladder passes *and* the independent Sign-off approver — which
runs only on a green ladder and is veto-only — doesn't veto.

**Authored files stay out of your way.** Under `--generate`, authored tests/helpers are written to
idiomatic locations and auto-registered in `.git/info/exclude` (per-clone, never committed), so
they never appear in `git status`. A loud log line names each file and how to keep it
(`git add -f`). The guard still pins them by content hash (excluded ≠ unprotected). `--verify-dir
<dir>` steers where they land. Also add `.goaly/` to your repo's `.gitignore`.

## Stuck detection

The loop bails before `--max-iterations` with a typed reason when it's making no progress:

| Kind | Meaning | Tune with |
| --- | --- | --- |
| no-diff | the tree didn't change | `--stuck-no-diff` (bool) |
| repeat-failure | the same verifier-failure signature recurs (`STUCK_REPEATED_FAILURE`) | `--stuck-repeat-threshold` |
| oscillation | period-N cycling between tree states | `--stuck-oscillation` |
| harness-crash | the agent CLI exited abnormally N times in a row (`STUCK_HARNESS_CRASH`) | `--stuck-crash-threshold` |
| contract-unevaluable | the frozen ladder could not be *evaluated* N times in a row (`CONTRACT_UNEVALUABLE`) | `--stuck-unevaluable-threshold` |
| timeout-no-diff | N iterations in a row both hit the harness wall-clock timeout **and** changed nothing (`STUCK_TIMEOUT_NO_DIFF`) | `--stuck-timeout-no-diff-threshold`, `--harness-timeout-ms`, `--harness-idle-timeout-ms` |
| budget | `--budget-tokens` / `--budget-wall-ms` exhausted | the budget flags |

### Automatic remediation (`--auto-remediate-stuck`)

For long unattended runs, `--auto-remediate-stuck` (default off; included in `--mode aggressive`)
lets the run spend up to **three bounded self-recoveries** — one per remediable kind — instead of
stopping for the operator:

- **no-diff** — the next prompt carries a canned "your last turn changed NOTHING — try a genuinely
  different approach" hint, and the burned no-diff iteration is refunded against
  `--max-iterations`. A second unchanged turn aborts.
- **repeat-failure** — the repeat threshold is effectively raised by one, buying exactly one extra
  attempt. The streak continuing aborts.
- **harness-crash** — the crash threshold is effectively raised by one (on top of the driver's
  built-in per-iteration retry). Another crash aborts with the harness's own error.

`CONTRACT_UNEVALUABLE`, budget, and oscillation are **never** remediated — an environment failure,
an operator cap, and a demonstrated cycle all need a human. Every remediation is pure reducer
policy (it replays identically on `--resume`), is visible in the agent's next prompt
(`AUTO-REMEDIATION n/3 …`), is logged loudly by the driver, and is counted in the abort reason if
the run still ends stuck.

Details that make these accurate rather than trigger-happy:

- **Repeat-failure** normalizes volatile tokens (timestamps, PIDs, temp paths) before comparing,
  and keys on the verifier-failure signature independent of the diff hash — a worker that churns
  unrelated files while the same error repeats is still caught, and the abort names the repeated
  signature.
- **Contract-unevaluable** distinguishes a verification-*environment* failure (verify command timed
  out / couldn't start, judge errored) from a real red: the tree may be correct-but-unverified, so
  it's never blamed on the code — still fail-closed, never a green. It keys only on facts goaly
  owns, never exit-code/error-string guessing.
- **A repeat-failure streak may be re-adjudicated as a *contract* fault** — see below.

### In-loop contract-fault adjudication (`CONTRACT_DEFECTIVE`)

Contract soundness is otherwise classified exactly once, at t=0, on a tree with no implementation
in it (the pre-flight soundness check above) — the moment of *least* evidence. For
one defect class that timing isn't unlucky, it's undecidable: when a frozen assertion is impossible
for any implementation to satisfy, its t=0 failure is byte-identical to an honest "not written
yet" red, because nothing exists either way. The evidence that settles it — *a real implementation
now exists and the same assertion still reds* — only appears several iterations later, exactly when
the repeat-failure detector fires.

So goaly asks again, then. When a `repeat-failure` streak is about to abort **and** the repeated
signature names one of the contract's frozen authored files (by path or basename) **and** the
worker has demonstrably changed the tree during the run, the run makes **one read-only LLM call**
asking: *given this implementation, could any correct implementation pass this frozen check, or is
the check itself unsatisfiable?*

- `defective: false` → the run aborts with **today's repeat-failure reason, byte-identical**.
- `defective: true` → the run aborts with a typed **`CONTRACT_DEFECTIVE`** reason that names the
  frozen file, says plainly that your implementation may be correct and the **tree is worth
  keeping**, and points at a corrected bar rather than at `--stuck-repeat-threshold` (which cannot
  help against an unsatisfiable assertion).

Guarantees, all of them structural:

- **Diagnosis only.** This path can only reach `ABORTED`. It can never produce a `DONE`, a green,
  another iteration, or a re-authored contract — the freeze (invariant #2) is untouched, and
  recovery is a *new run*: the abort prints the exact successor command
  ([`--recontract`](#re-contracting-a-defective-bar---recontract)), which keeps your tree.
- **Fail-closed to today's behavior.** No adjudicator wired, an LLM error, a timeout, an
  unparseable reply, a schema miss, or any uncertainty all land on the unchanged repeat-failure
  abort. Only a confident positive relabels it.
- **Bounded to once per run**, as replayable reducer state — so a `--resume` that re-trips the
  streak can't buy a second call.
- **Replay-safe.** The verdict is a Zod-parsed, write-ahead-logged `CONTRACT_ADJUDICATED` event, so
  `--resume` and `goaly runs show` reuse the recorded answer and never re-call the model. (Resume's
  automatic streak relief is suppressed for a run that adjudicated: more iterations against an
  unsatisfiable bar are still unsatisfiable.)
- **The reducer stays pure.** DECIDE only emits an `ADJUDICATE_CONTRACT` command; the driver
  performs the read-only call and feeds the event back (invariant #1). Its spend is metered against
  `--budget-tokens` under the verifier layer.

The adjudicator runs on the **judge** model (the same read-only provider the pre-flight uses), not
the compiler model that authored the bar.
- **Ephemeral verifier artifacts don't count as progress.** A conservative default set is excluded
  from the tree hash (Python bytecode/`__pycache__`, pytest/mypy/ruff caches, JS
  `.nyc_output`/`htmlcov`) so a verify command that regenerates them can't disguise a no-op turn.
  The defaults never touch build output (`build/`, `dist/`, `target/`). `--diff-ignore "<p1,p2,…>"`
  adds your own git pathspecs (deduped with the defaults; `*` spans `/`).
- **A no-diff iteration is excused** when the agent never had a fair chance to act: the previous
  turn timed out, crashed, or was truncated, or the ladder is green and a fresh Sign-off veto is
  the only blocker. A perpetually truncated run still terminates at `--max-iterations` / budget.
- **…but the timeout excuse is bounded** (`timeout-no-diff`). A worker that is killed by the
  wall-clock cap *every* iteration used to be excused every iteration, so it burned the whole
  `--max-iterations` budget in silent ten-minute no-ops. The excuse now lasts
  `--stuck-timeout-no-diff-threshold - 1` consecutive turns (default 2 ⇒ exactly one excused turn,
  the original intent), and the threshold-th one aborts with a typed `STUCK_TIMEOUT_NO_DIFF` that
  names the real fix: more room per turn via `--harness-timeout-ms` and/or
  `--harness-idle-timeout-ms`. A timed-out turn that *did* change the tree was progressing and does
  not count toward the streak. This detector is deliberately **not** silenced by
  `--stuck-no-diff false` — that toggle is about a worker that stops editing, not about one that
  keeps being guillotined — and it is never auto-remediated, since another attempt at the same cap
  just buys another full-length no-op.
- **A harness that REFUSED is not a harness that crashed.** When the agent CLI names an actionable
  fix in its own failure output — droid's "insufficient permission to proceed / re-run with `--auto`
  medium" being the canonical case — the codec recognises it and `STUCK_HARNESS_CRASH` carries that
  remediation instead of the generic "check the CLI is installed, authenticated, and runnable",
  which in that situation is three dead ends. The classification is unchanged: the run is still a
  fail-closed `crashed`, still typed the same way. Only the guidance differs. Per-CLI string
  matching lives in the codec, never in the reducer, so the stuck detectors still key purely on
  facts goaly owns.

**Streak relief on `--resume`.** The counted streaks are not stored — they are re-derived by the
replay-fold — so a run that aborted at the crash threshold used to hit it again on the very first
fold and terminate before the harness got a single turn, no matter what you had just fixed.
Resuming is your explicit signal that something changed, so goaly now raises each tripped threshold
by the length of the streak the log already banked: the resumed run must earn a fresh streak before
aborting again. It applies to the three counted detectors (harness-crash, contract-unevaluable,
repeat-failure), is measured off the run's original thresholds so repeated resumes re-measure rather
than compound, is recorded as an ordinary `RUN_EXTENDED` marker (auditable in the log), and any
explicit `--stuck-*` on the resume command line still wins. `no-diff` is a toggle rather than a
counter, so it is not relieved — pass `--stuck-no-diff false` for that resume.

## Diff baselines (`--baseline` and `--delta-verify`)

The worker's diff — what the Sign-off approver reviews — is computed against `HEAD` by default.

**`--baseline <ref>`** diffs against any git ref/SHA instead, so a multi-step build can chain runs
without committing onto your branch: point run *N+1* at the tree run *N* finished on. The ref must
resolve (`git rev-parse --verify`) before the run starts — fail-closed, never a silently degraded
diff. The baseline only changes what `diff()` is computed *against*; the working-tree hash that
drives stuck detection is unaffected. goaly can also advance the baseline internally via a private
tree snapshot (`git write-tree` through a throwaway index — no commit, no `HEAD`/branch/index
movement), recorded in the run log so `--resume` reconstructs it.

The run-start baseline (an explicit `--baseline`, or the automatic pin applied when
[harness autonomy](#harness-autonomy---harness-autonomy) is raised) is recorded in the run-log
header, and a `--resume` **re-adopts** it — a re-passed `--baseline` wins, and a logged internal
checkpoint still re-points on top. So the pin survives a crash even if the agent committed mid-run.

**`--delta-verify`** (default off) keeps the LLM **judge's** prompt flat on long runs: after each
continuation iteration goaly takes an internal checkpoint so the next judge reviews only that
iteration's delta. The trust model is preserved because the **DONE decision stays cumulative**:

- deterministic rungs always execute on the full working tree (they run commands, not diffs), and
- the terminal Sign-off approver stays pinned to the run's **start** baseline, reviewing the entire
  cumulative diff — a change smeared across iterations is still visible.

If a checkpoint can't be taken, the iteration falls back to the full diff (never an empty one). It
composes with `--phased`: deltas feed the judge within a phase, while the approver baseline
advances only at phase boundaries. For a huge monolithic change, `--phased` remains the way to
bound the cumulative diff itself.

## Workspace mode (`--workspace-mode`)

By default goaly uses git plumbing to hash and diff the working tree, and it requires a git
repository. **`--workspace-mode file`** replaces git plumbing with a content-addressed file-system
manifest: it hashes every file, renders a textual diff against stored baseline manifests, and keeps
baseline snapshots under `.goaly/baselines/` so the run can resume. This lets goaly run in a plain
directory without `git init`.

- `--workspace-mode git` — explicit git plumbing (the preflight enforces a git repo).
- `--workspace-mode file` — explicit file-system manifest mode.
- `--workspace-mode auto` — pick `git` when the workspace is inside a git work tree, otherwise `file`.
  This is the default.

File mode supports the full two-key loop, stuck detection, checkpoints, and resume. It does **not**
support worktrees, best-of-N (`--candidates > 1`), or parallel phases, because those features need git
plumbing. Harness-autonomy auto-pinning (which pins the review baseline to the run-start HEAD SHA) is
also git-only and is skipped in file mode.

In file mode, an explicit `--baseline` must name a previously stored manifest hash (produced by a
prior `checkpoint`), not a git ref.

## Best-of-N parallel worker (`--candidates`)

Some iterations are a coin-flip. `--candidates N` (alias `--best-of N`, default 1) runs N
independent worker attempts every iteration in isolated git worktrees, scores each against the
**same frozen ladder**, and keeps the best — without weakening the bar.

```
each iteration, with --candidates N:
   ┌─ worktree 1 ─► RUN_AGENT ─► score the FROZEN ladder ─┐
   ├─ worktree 2 ─► RUN_AGENT ─► score the FROZEN ladder ─┤  pick the best,
   └─ worktree N ─► RUN_AGENT ─► score the FROZEN ladder ─┘  promote its tree
```

- **Driver-side; the reducer is untouched.** The pure state machine emits one `RUN_AGENT_BEST_OF`
  command and receives the same single `AGENT_RAN` for the winner — `--candidates 1` is
  byte-for-byte the classic single attempt, and stuck detection sees exactly one `diffHash` per
  iteration.
- **The scorer is the frozen ladder — no second scorer.** Candidates are graded by how far each got
  *up* the ladder; furthest wins (an all-pass beats every partial), so two failing attempts are
  distinguished. Depth is read off the verdict at zero extra cost (the ladder already
  short-circuits at the first failing rung). Ties break to lower token cost, then lowest index.
  All-N-fail is a normal red iteration; a crashed/timed-out candidate scores depth 0 and can't win.
- **Write-ahead + resume.** Each candidate logs on completion (`CANDIDATE_RAN`), then the selection
  (`CANDIDATE_SELECTED`). On `--resume`, a crashed fan-out re-runs only the not-yet-logged
  candidates and re-selects deterministically. `--resume-best-of-incomplete rerun|collapse` picks
  the policy: `rerun` (default) completes the full N-way set; `collapse` selects from only the
  already-logged candidates and re-runs nothing (fail-closed: zero logged still runs the full set).
- **Bounded.** Spend scales up to ~N× per iteration (still governed by `--budget-tokens`), and N is
  capped at 16 — a higher value is a fail-closed usage error. Needs a committed HEAD (`git
  worktree` can't check out an unborn tree; it refuses to start otherwise). Composes with
  `--phased`, `--delta-verify`, and `--sandbox`.

### Natural-language delegation

You don't have to remember the flag — a delegation directive in the goal (or a resume note) maps
onto the same tournament:

```bash
goaly "fix the flaky auth test, work with 4 subagents"        # ⇒ --candidates 4
goaly "make the linter pass using 3 parallel attempts"        # ⇒ --candidates 3
goaly "port the parser to TS, use subagents"                  # ⇒ --candidates 3 (default)
goaly --resume run-… --note "focus on the parser, try 4 parallel attempts"
```

Detection is a small **deterministic grammar** (`src/cli/delegation.ts`), never an LLM parse, and
it's deliberately narrow: only `subagents` (with a delegation verb) and `N parallel
attempts|candidates|tries` match — app-domain goals like *"a queue with 4 parallel workers"* never
do. No match ⇒ the classic single attempt. The directive is **stripped from the frozen goal** (a
leftover "use 4 subagents" would become an unverifiable success criterion), the interpretation is
loudly logged, and the explicit flag always wins. In a resume note it becomes a `candidates`
overlay on the `RUN_EXTENDED` marker — an operational knob; the frozen contract stays unreachable.

## Phased goals (`--phased`)

A big goal produces a big diff — costly to judge and easy to half-finish. `--phased` turns one goal
into a **frozen plan of small sub-goals** (a dependency DAG, listed dependencies-first), runs each
as its own frozen two-key contract,
and finishes with a **cumulative acceptance** contract on the original goal — so decomposition
can't green a goal whose parts pass but whole doesn't.

```
PLAN ──► plan SEAL ──reject──► ABORTED        🔁 "revise" → re-plan from the human's note
   │ approve → freeze the plan (planHash)         (≤ --max-plan-revisions, default 10)
   ▼
for each phase:  COMPILE ─► SEAL ─► loop (RUN_AGENT ▸ ladder ▸ SIGN-OFF ▸ DECIDE)
   │ both keys → internal CHECKPOINT ──► next phase
   ▼
ACCEPT (a cumulative contract on the ORIGINAL goal) ──both keys──► DONE  ──else──► FAILED
```

- **Planner seam (read-only, like the compiler).** An LLM authors the ordered phases
  (`--planner-model` picks its model), or `--plan-file <p>` supplies one:
  `{ "phases": [{ "goal", "intent"?, "rubric"?, "id"?, "dependsOn"? }] }`. The plan is parsed
  fail-closed and frozen (`planHash`, logged loudly); a planner error, bad plan, or more than
  `--max-phases` (default 10) is a typed `PLAN_FAILED`, never a skipped decomposition.
- **The plan is a DAG** ([issue #123](https://github.com/krimvp/goaly/issues/123)). A phase may name
  itself with `"id"` and declare exactly what it needs with `"dependsOn": ["<id>", …]`
  (`[]` = a root, no prerequisites). Phases are still *listed* in a topological order — dependencies
  come first — and everything about the graph is checked at parse time, **fail-closed**: an unknown
  id, a self-reference, a duplicate id, a cycle, or a forward edge is a typed `PLAN_FAILED` with the
  offending phase named. A silently linearized plan is never produced. A phase with no `dependsOn`
  keeps the conservative default (it depends on everything before it), so a plan that declares
  nothing is exactly the classic linear plan. The edges are part of the canonical plan string and
  therefore of `planHash` — frozen like everything else, so no transition can re-shuffle the graph.
- **The plan is frozen too.** Re-planning is only the bounded, human-gated plan-Seal revise path —
  never an automatic "make phase 3 easier".
- **Each phase is a normal run** (compiler, ladder, Sign-off, DECIDE unchanged), scoped to its
  sub-goal. Between phases goaly takes an internal checkpoint (no commit) so each phase's diff
  stays small.
- **Acceptance is the whole-run key.** The final phase verifies the original goal end-to-end —
  your `--verify-cmd` becomes the cumulative deterministic bar, or `--generate` authors cumulative
  acceptance. A phase that can't reach DONE within its budget fails the whole run.
- `--autonomous` auto-accepts the plan and each phase contract (still frozen + logged).
  `--budget-tokens` is the whole-run total. `--resume` re-enters mid-plan without repeating
  completed phases. `goaly runs show` prints the frozen plan and stamps each iteration's phase.

## Cooperative parallel waves (`--parallel-phases`, EXPERIMENTAL)

Sequential phases leave wall-clock on the table when sub-goals are independent. With
`--parallel-phases` (opt-in), every phase whose dependencies have all completed — the plan DAG's
current **topological frontier** — forms a **wave** that executes concurrently, then merges, without
weakening a guarantee. End-to-end:

```bash
goaly run --goal-file ./BIG_GOAL.md --verify-cmd "npm test" \
          --phased --autonomous --parallel-phases --plan-file ./plan.json
```

It requires `--autonomous` (wave children seal their frozen contracts concurrently — an
interactive gate cannot pause K children at once; the CLI refuses the combination otherwise,
fail-closed), and a plan that says which phases are independent:

```jsonc
// plan.json — parser + formatter are one frontier; the CLI wiring needs both, the docs need only the parser
{ "phases": [
  { "id": "parser",    "goal": "implement the parser",    "dependsOn": [] },
  { "id": "formatter", "goal": "implement the formatter", "dependsOn": [] },
  { "id": "cli",       "goal": "wire parser + formatter into the CLI", "dependsOn": ["parser", "formatter"] },
  { "id": "docs",      "goal": "document the parser grammar",          "dependsOn": ["parser"] }
] }
```

Independence is **declared and validated**, not inferred from position: reordering the list can no
longer silently change what runs concurrently, and "`cli` needs both, `docs` needs only the parser"
is expressible. The frontier is recomputed after each wave (here: `parser`+`formatter`, then
`cli`+`docs`), and a `--resume` recomputes it from the log, so no completed phase is repeated.

The legacy `group` sugar still works and means exactly what it always did — a *contiguous* band of
same-`group` phases, each depending on everything before the band:

```jsonc
// plan.json — phases 1+2 are one wave; phase 3 runs after the merged result
{ "phases": [
  { "goal": "implement the parser",    "group": 1 },
  { "goal": "implement the formatter", "group": 1 },
  { "goal": "wire parser + formatter into the CLI" }
] }
```

- **Fork.** Every wave member is a full goaly child run — its own frozen contract, iterations,
  ladder, veto-only Sign-off, and write-ahead log — in an isolated worktree off the wave-start
  checkpoint, all metered by the one shared `--budget-tokens`.
- **Merge: plumbing, not prayer.** DONE children merge in phase order with a real 3-way
  `git merge-tree` (objects only, no commits). A textual conflict applies nothing of that child.
- **Re-verify: a merge is never trusted.** Each merged child's frozen deterministic rungs re-run on
  the combined tree — two individually-green changes can still break each other.
- **Fail-closed to sequential.** A conflict, a red re-verify, a crashed child, or a missing wave
  executor all downgrade that phase to the classic sequential run on the merged tree, under a fresh
  frozen contract for the same sub-goal. The cumulative acceptance contract still gates the whole.
- **Scheduling is pure.** The frontier is a pure function of `(frozen plan, completed phases)`
  computed inside the reducer — no clock, no IO, no LLM (invariant #1), and identical on replay.
- **v1 limits:** requires `--autonomous`; a crash mid-wave re-runs the whole wave on `--resume`;
  wave-child spend reports under the parent's `harness` layer. A DAG (or grouped) plan runs strictly
  sequentially without the flag — the list order is a valid topological order, so the result is the
  same, only slower. The graph is frozen into `planHash`. The LLM planner may author `id`/`dependsOn`
  (it is told the shape); a `--plan-file` is still the reliable way to get exactly the graph you want.

## Worktrees (`--worktree`)

Sometimes the run shouldn't touch your working tree at all. `--worktree <name>` re-roots the
**entire run** at a named, persistent git worktree; the work merges back with plain git.

```bash
goaly "add a /health endpoint" --worktree health      # create (or reuse) + run inside it
goaly "try the other approach" --worktree             # bare flag: auto-named (wt-<8 hex>)

goaly worktree create feature-x --base main           # create up front (default base: HEAD)
goaly worktree list                                   # NAME / BRANCH / HEAD / DIRTY / RUNS / PATH
goaly worktree remove feature-x                       # refuses if dirty; branch kept for merge-back
goaly worktree remove feature-x --force --delete-branch
```

- **Where they live:** `git worktree add`-ed at `.goaly/worktrees/<name>` on branch
  `goaly/<name>` — inside the already git-ignored `.goaly` dir, so nothing shows in `git status`.
  (Corollary: `git clean -dfx` on the main tree deletes the checkouts; committed work survives on
  the branch. `worktree list` flags orphaned registrations as `PRUNABLE`.)
- **The whole run is re-rooted:** run log, run lock, agent cwd, verifier, diff scope. Resume with
  the same `--worktree <name>` (the banner prints the exact command).
- **Merge-back is plain git.** Runs never commit; the end-of-run hint shows the two steps
  (commit inside the worktree, then `git merge goaly/<name>`). `remove` keeps the branch by default;
  `--delete-branch` opts out (an unmerged branch then needs `--force`).
- **Fail-closed safety.** Creating over an existing worktree, an unresolvable `--base`, or an
  invalid name (one safe path component: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`) all refuse. `remove`
  refuses while a live goaly run is inside (always) and refuses a dirty tree without `--force`.
- **Distinct from best-of-N:** `--candidates` makes ephemeral worktrees for one iteration's
  tournament; `--worktree` is the persistent, named counterpart a whole run can live in. They
  compose.

## Reliability

goaly fails closed but not eagerly: a wrong green must be impossible, and a transient blip must not
kill an hours-long run. All defaults, no flags needed
([ADR 0011](adr/0011-reliability-hardening.md)):

- **Fail-fast preflight.** A run refuses to start — with the exact fix — when the workspace isn't a
  git repo, the `--harness` / `--llm-provider` CLI isn't on PATH, a `--resume` id is unknown, or a
  stdin-fed goal lacks `--autonomous` (which would deadlock the Seal prompt).
- **Transient failures are absorbed.** The OpenAI-compatible transport retries 429/5xx/network
  errors with backoff (honoring `Retry-After`, capped at 60 s); CLI-backed LLM steps retry a
  non-zero exit or unparseable output; a judge-quorum sample that throws drops that sample only; a
  crashed harness turn is retried once before counting toward the stuck-crash streak. Timeouts are
  never retried.
- **Ctrl-C is safe.** The first Ctrl-C / SIGTERM stops between steps: the in-flight step finishes,
  lands write-ahead, and the outcome is a typed `ABORTED` naming `--resume <runId>` (exit 130). A
  second Ctrl-C exits immediately, after reaping live child process groups.
- **Crash-safety end to end.** Every run-log append is fsync'd write-ahead; a torn tail is
  tolerated on read and repaired on the next append. A per-run lock stops two processes driving the
  same run (stale locks self-heal). A terminated-but-corrupt line still fails closed.
- **Budgets survive `--resume`.** Prior token spend is folded out of the log and re-armed against
  `--budget-tokens`. (The wall-clock budget restarts per process — the crash-to-resume gap is idle
  time, not spend.)
- **Terminal outcomes tell you the next step.** A failed/aborted run prints a one-line `next:`
  hint — what the reason means and the exact `--resume` / `runs show` command.

## Operator control (watch, steer, extend)

You're never locked out of a run ([ADR 0012](adr/0012-operator-control.md)). Everything below
steers the worker or the operational caps — never the frozen bar.

```bash
goaly runs watch run-<id>          # tail a live run read-only, from any terminal

^C                                  # stops cleanly between steps; nothing is lost
goaly --resume run-<id> --note "the fixture belongs in test/fixtures, not src"

goaly --resume run-<id> --max-iterations 25      # revive FAILED at the iteration cap
goaly --resume run-<id> --budget-tokens 900000   # revive a budget abort (prior spend counts)
goaly --resume run-<id> --stuck-no-diff false --note "edit src/parser.ts directly"
goaly --resume run-<id> --candidates 4           # widen the best-of-N fan-out
```

Only the operational knobs are extendable (`--max-iterations`, `--budget-tokens`,
`--budget-wall-ms`, the `--stuck-*` thresholds, `--candidates`) — the extension schema structurally
has no field for the goal, verifier, or rubric, so autonomy never becomes "renegotiate the bar".
Each extension persists as an auditable `RUN_EXTENDED` log marker. A DONE run refuses to extend and
points at `--from-run`. A resume continues the run's **own recorded harness** (session ids are
harness-specific); pass `--harness` explicitly to override.

Rule of thumb: same goal, more room → `--resume` with caps/note; new or refined goal →
`--from-run`.

## Inspecting past runs

Read-only subcommands replay the persisted event stream with the same fold `--resume` uses — they
re-run nothing:

```bash
goaly runs list                  # one row per run: id, status, iterations, tokens, goal
goaly runs show run-<id>         # frozen contract + hash, Seal outcome, every verdict, totals,
                                 # and any degraded-mode label (e.g. SELF-JUDGED)
goaly runs watch run-<id>        # follow a LIVE run from another terminal
goaly runs resume-cmd run-<id>   # how to continue the run's CLI session interactively
goaly runs list --workspace ./myrepo
```

`resume-cmd` prints the command to continue the underlying CLI session in its own interactive mode
(`claude --resume <id>`, `codex resume <id>`, `droid --resume <id>`, `pi --continue`), recovered
from the log. For a `goaly-code` run it routes you to `--from-run --inherit-session`.

Both `list` and `show` parse the log with Zod and fail closed: a corrupt run is flagged (`CORRUPT`
in the table; exit 1 for `show`), never silently dropped or treated as green.

## Following up after a run ends (`--from-run`)

To act on a **finished** run — *"good, but also handle empty input"* — start a new, re-verified run
that builds on it:

```bash
goaly "now also handle empty input" --from-run run-<id>                    # fresh session
goaly "now also handle empty input" --from-run run-<id> --inherit-session  # keep agent memory
```

`--from-run` runs in the same workspace (the prior outcome is already on disk), seeds the new
contract's authoring with a concise, deterministic **compaction** of the prior run (its goal, the
frozen bar it met, how it ended), and then compiles its **own** frozen two-key contract — every
invariant preserved by construction. It composes with every other flag.

This is distinct from `--resume`, which re-enters an *incomplete* run's loop. `--inherit-session`
additionally resumes the prior harness session on the first turn so the agent keeps its working
memory — the new frozen contract still solely governs DONE. Valid only with the same `--harness` as
the prior run; ignored under `--phased`. The end-of-run banner prints a "Continue this session:"
hint with the same mapping as `runs resume-cmd`.

## Re-contracting a defective bar (`--recontract`)

When goaly's own adjudicator condemns a frozen bar
([`CONTRACT_DEFECTIVE`](#in-loop-contract-fault-adjudication-contract_defective)), the implementation
in your tree may be perfectly correct — only the bar was wrong. Recovery used to mean one of three
bad options: hand-edit a frozen file the anti-tamper machinery deliberately git-excluded and pinned,
throw away a correct tree and start from zero, or `--resume` with a raised
`--stuck-repeat-threshold` (more iterations against an unsatisfiable bar are still unsatisfiable).

A **successor run** is the fourth option, and the abort prints it verbatim:

```bash
goaly --from-run run-<id> --recontract          # keep the tree, repair the bar
goaly --from-run run-<id> --recontract --max-recontracts 2
```

It **keeps the predecessor's working tree**, inherits its **frozen goal** (a repair changes the bar,
not the goal — a goal passed on the command line is ignored, loudly), and re-runs COMPILE with the
**defect report as authoring feedback** — the same free-text channel a Seal "revise" round uses. The
result is a **new** contract with a **new** `contractHash` under a **new** `runId`.

**No contract is ever mutated.** Invariant #2 is *strengthened*: one run owns exactly one frozen
contract for its whole life, and evolution happens *between* runs, in the open, with provenance. The
successor's log header records `predecessorRunId`, `predecessorContractHash`, the adjudication
verdict, and the chain depth; `goaly runs show` prints them:

```
successor of: run-a1b2  (re-contract #1 in this chain)
  predecessor contract: 9f3c…  — adjudicated DEFECTIVE, never reused
  verdict:   the frozen assertion requires a call the goal never implies
```

Five guards keep this from becoming a weakening channel:

- **Only a `CONTRACT_DEFECTIVE` adjudication can reach it.** Eligibility keys off the write-ahead,
  Zod-parsed `CONTRACT_ADJUDICATED` **event** — goaly's own read-only adjudicator — not off the
  abort reason string (which carries the repeated verifier failure as context). A worker that prints
  `CONTRACT_DEFECTIVE:` into its own output can never open the door; any other outcome is refused
  with exit 2 before anything is written.
- **No worker-supplied text feeds the re-authoring.** The seed is built only from the frozen
  contract (compiler-authored), the goal (yours), and the adjudicator's verdict — which is itself
  fenced as untrusted data, since it was written after reading worker-influenced output.
- **The new bar still faces the negative control.** A re-authored bar that already *passes* on the
  inherited tree is put to a fail-open pre-flight classifier before a worker token is spent: either
  the implementation really was correct (proceed — the expected happy ending of a re-contract) or
  the repair softened the bar into vacuity (`CONTRACT_UNSOUND`, abort). No LLM, an LLM error, an
  unparseable reply, or any uncertainty all proceed.
- **The chain is bounded.** `--max-recontracts` (default 1) caps how many re-contracts a chain may
  contain. The depth lives in the run log header, so the cap holds **across the chain, not per
  process** — a second `--recontract` off a successor is refused even from a fresh shell.
- **It is an ordinary run in every other respect.** It Seals (auto-accepted under `--autonomous`,
  still frozen and logged loudly; reviewable with `--mode review`), freezes, and needs both keys for
  DONE. A failed re-compile is a normal `COMPILE_FAILED`.

`--recontract` requires `--from-run`; `--max-recontracts` requires `--recontract`. Both are
per-invocation only (never settable from a config file) — a persisted re-contract would re-point
every run in the tree at one predecessor's defective contract.

## The defect corpus (cross-run learning)

Every other feedback channel in goaly is *intra-run*: the verifier's failure reaches the worker, the
veto reaches the worker, a red-team finding reaches the compiler — and then the run ends and all of
it is gone. Author an unsatisfiable bar today and the same compiler authors it again tomorrow, in
another project, forever.

The **defect corpus** closes that loop, and it is the only cross-run state goaly keeps:

1. When a run's in-loop adjudication rules a frozen bar
   [`CONTRACT_DEFECTIVE`](#in-loop-contract-fault-adjudication-contract_defective), goaly appends
   **one compact record** to `~/.goaly/defects.jsonl` — the adjudicator's *generalized* anti-pattern,
   the *generalized* shape of the offending assertion, the language/test-runner derived from the
   frozen contract, and the `contractHash` + `runId` for provenance. Never the source, never the
   diff, never the failure text.
2. Later `--generate` runs read it, keep the entries relevant to **this** workspace's
   language/runner, cap them, and inject them into the contract-authoring prompt as a
   **"known false-red patterns — do not author these"** section. Every injected pattern is logged,
   so a run says out loud which local state shaped its bar.

```bash
goaly config defects list                    # what has been learned, with provenance
goaly config defects clear                   # reset it
goaly config defects list --defect-corpus ./team-defects.jsonl

goaly --no-defect-corpus "…"                 # opt out entirely for this run
goaly --defect-corpus ./team-defects.jsonl "…"   # use a different corpus file
```

`--defect-corpus <path>` and `--no-defect-corpus` are settable from a config file like other wiring
flags; passing both is a usage error.

**It cannot become a weakening channel** — the guarantees are structural, not conventions:

- **Only an adjudicated `CONTRACT_DEFECTIVE` verdict can write.** The append takes a record type
  that only the adjudication path can mint, so no other code path even compiles against it; a
  `defective: false` verdict, an unparseable one, or a positive one with no generalized pattern
  writes nothing.
- **No worker-supplied text can reach a record.** The record builder has no parameter for the
  failure signature, the diff, harness output, or file contents; everything but the adjudicator's
  own two generalized sentences is derived from the frozen contract, and the language/runner fields
  are closed enums.
- **"This was hard" is inexpressible.** The schema is strict and has no iteration count, repeat
  count, duration, token spend, or severity field — difficulty can never turn into "author an easier
  bar". The prompt section is phrased as *impossibility* ("do not author bars that are impossible to
  satisfy… never a reason to make the bar easier").
- **Bounded prompt.** Filtering + a cap mean a corpus of any size produces the same small section.
- **Fail-open, never a gate.** A missing, unreadable, corrupt, or partly unparseable corpus degrades
  to exactly the pre-corpus behavior (bad lines are dropped on read, Zod-parsed); a failed write is
  logged and dropped. It shapes an authoring prompt *before* the freeze and nothing else — Seal, the
  critics, the [pre-flight negative control](#setup-preflight--soundness), the frozen ladder, and the
  two keys for DONE all apply to a corpus-influenced contract exactly as before.
- **Local only.** Nothing is uploaded, shared, or fetched.

## Web UI (`goaly ui`)

A local control center over the run logs — everything the read-only subcommands show, plus live
tails and browser-side operation:

```bash
goaly ui                       # http://127.0.0.1:4180 over this workspace's runs
goaly ui --port 5000 --workspace ./myrepo
```

- **Mission dashboard** — fleet KPIs (live runs, runs parked at a Seal, done, failed/aborted,
  total tokens) over a run board grouped by root — the main workspace and each managed worktree —
  with status badges, live-state chips, and a pulsing LIVE indicator. Corrupt logs are flagged,
  never dropped.
- **Run detail (the mission view)** — a pipeline strip showing where the run is right now
  (plan → compile → seal → prep → the agent/verify/sign-off loop → done), stat tiles (iterations,
  tokens against the budget with a spend meter, duration, harness, state), the frozen contract
  rendered as its rung ladder, an iteration timeline with each verdict and Sign-off, and an
  *operate* card with copyable `--resume` / harness-session commands.
- **Session inspector** — jump inside the agent's session: the recorded stream transcript
  (`stream.jsonl`, always on for UI-started runs) rendered as the agent's actual turns — messages,
  reasoning, tool invocations with expandable inputs/results and ok/error states, token usage, and
  turn boundaries — each tagged and filterable by seam (agent / judge / approver / compiler …),
  streaming live over SSE.
- **Live event feed over SSE** — the write-ahead log tailed read-only (it never takes the run
  lock), so it follows runs started in any terminal.
- **Worktrees panel** — create/remove with the manager's refusal ladder surfaced verbatim.
- **Start runs, and hold the Seal in your hand.** The start form executes in-process through the
  exact same code path as the CLI (same guards, run lock, write-ahead log). A non-autonomous run
  parks at a **browser Seal modal** — a real `SealGate` implementation, never a bypass. The modal
  is a full review station ([ADR 0016](adr/0016-seal-review-station.md)): authored files render
  with their contents and an in-browser editor; setup/verify commands and the rubric are
  edit-in-place; "re-freeze & review" re-pins the hashes into a freshly frozen contract (logged,
  zero LLM cost, unlimited rounds). Approving with files drifted on disk is refused (409) so a
  stale approval never wastes an iteration.
- **Stop & resume from the browser** — the same cooperative between-steps interrupt as Ctrl-C, and
  resume with a note + raised operational caps.
- **One live run per tree** — a second run in an occupied root is refused (409) with a pointer at
  worktrees.

The disk is the source of truth, so the server can be started and stopped freely; UI-owned runs
stay resumable if it dies. It binds `127.0.0.1` only and refuses non-local `Host` headers
(DNS-rebinding), cross-site `Origin`s, and state-changing requests without an `X-Goaly-Ui: 1`
header — all fail-closed ([ADR 0014](adr/0014-local-web-ui.md),
[ADR 0015](adr/0015-ui-owned-runs.md)). Embedders get the same server via
`startUiServer({ workspaceRoot })` and the shared run entrypoint via `executeRun()`.

## Observability

All observability is pure wiring: it never touches the frozen contract, the ladder, or the two-key
decision, and every layer fails closed to "no output", never a changed outcome.

- **Diagnostics logging** (`--log-level debug|info|warn|error`, default `info`) — human-readable
  lines to stderr plus a structured JSON-lines file at `.goaly/<runId>/goaly.log`, size-rotated
  (5 MiB × 3). Separate from the write-ahead run log (which stays the single source of truth for
  replay). Prompts, harness output, and diffs stay at `debug` (secrets discipline).
  `--log-file <path>` relocates it; `--no-log-file` is console-only.
- **Live streaming** (`--stream`) — the agent's intermediate turns (tool calls and output,
  messages, reasoning, per-turn tokens) rendered to stderr as they happen, tagged by phase
  (`[agent]` / `[compile]` / `[judge]` / `[approve]`). Every tool maps its native stream onto one
  canonical, tool-neutral taxonomy (`AgentStreamEvent`: `session` / `message` / `reasoning` /
  `tool_use` / `tool_result` / `usage` / `done`), Zod-validated at the seam — the live view is
  uniform across claude, codex, droid, and pi. Embedders subscribe via
  `composeDeps({ onStreamEvent })`.
- **Durable stream transcript** (`--stream-transcript`) — persists that same canonical stream to
  `.goaly/<runId>/stream.jsonl` for offline replay, identical in shape across harnesses. Uncapped
  (never rotated — a dropped `usage` line would corrupt a cost report); read back with the exported
  `readStreamTranscript(stateDir, runId)`, which Zod-validates each line and drops corrupt ones.
  Not the replay log: resume stays a pure fold over `OrchestratorEvent` only. `--stream-file
  <path>` overrides the location.
- **Plain-language narration** (`--explain`) — an opt-in, read-only side-LLM observer that
  synthesizes the run at three checkpoints: the frozen contract at Seal, each ladder run, and the
  terminal outcome (especially *why* a stuck stop happened). Prints to stderr prefixed
  `[explain]`. Strictly advisory; its spend is deliberately not metered into the run budget.
  `--explain-model <m>` picks its model. Off by default (one extra call per checkpoint).
- **Telemetry** (`DriverDeps.telemetry`) — a synchronous fire-and-forget sink fed one datapoint per
  lifecycle beat (`run_started`, one `lifecycle` event per folded reducer event, `run_finished`).
  No LLM calls, no agent content — tags, state, and the Driver clock only. Guarded: a throwing
  sink degrades to no telemetry. Absent ⇒ a no-op sink.

## Spend report & budgets

Every run ends with a token breakdown by layer — the harness vs. the LLM steps — and consumption
against any `--budget-tokens` cap (which governs **total** spend, harness + LLM steps). It's folded
from the write-ahead log, so `--resume` and `goaly runs show` rebuild identical numbers.

```
spend:
  harness      482,113 tokens
  compiler       3,901 tokens
  verifier      11,204 tokens
  approver       4,556 tokens
  llm subtotal  19,661 tokens
  total        501,774 tokens
  by category  in 412 · out 18,902 · cache-read 471,902 · cache-write 10,558
budget:      501,774 / 500,000 tokens (100%) — budget exceeded
```

- **Every category counts, cache included** (input + output + cache-read + cache-write). For
  cache-heavy providers like Claude, cache-read is usually the majority of real throughput —
  counting only input+output would grossly undercount both the report and the budget guard.
- **Fail-closed:** a harness/provider that reports no usage degrades that layer to `unknown`
  loudly (a warning + an `unknown` mark on the budget) — never a silent zero. Wall-clock stays the
  backstop.
- **Estimated when unreported:** if turns are streaming but the CLI reports no `usage`, goaly
  counts spend locally from the streamed turns (~4 chars/token) and marks it `estimated` in the
  report. Estimated tokens still count against the cap. A CLI running in a **buffered** output mode
  emits nothing to estimate from, so a harness that also reports no `usage` there leaves
  `--budget-tokens` blind for that layer and `--budget-wall-ms` is the real cap. (Adding
  `--harness-idle-timeout-ms` puts the CLI into its streaming mode, which restores the estimate —
  and, on some CLIs, a `usage` block the buffered mode omits.)
- **A failed turn still bills what it reported.** A turn that did real work and then crashed, timed
  out, or was truncated is accounted for from its own envelope — a refused or interrupted turn is
  not free, and dropping its count is what would make the budget silently blind. The status is
  unchanged by this; only the spend stops being discarded.
- **Cost is opt-in** (`--cost-table <path>`): a JSON file mapping model → price — either a flat
  USD-per-1M-tokens number or a per-category object (`input` / `output` / `cacheRead` /
  `cacheWrite`, plus optional `default`); a `"default"` key prices unlisted models. Unpriced
  categories are left out and the total is marked approximate. The log stays tokens-only.

```jsonc
// prices.json
{
  "claude-opus-4-8": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 },
  "claude-sonnet-4-6": 3,
  "default": 5
}
```

## Hardening against reward-hacking

The point of goaly is correctness under adversarial self-interest, so the loop is hardened against
the obvious ways a worker (or a gamed contract) could reach DONE without meeting the goal.

**The frozen bar can't be edited out from under the command.** Files authored for `--generate` are
pinned by content hash inside the frozen contract; a guard rung re-checks them every iteration and
fails closed on any change or deletion.

**The two keys ingest the diff as untrusted data.** The judge and approver receive the
worker-controlled diff inside a nonce-fenced envelope and are instructed never to act on
instructions, verdicts, or claims hidden inside it (prompt-injection defense).

**Vacuous and un-runnable authored bars are refused at compile.** A `--generate` command that
trivially passes (`true`, `:`, `exit 0`), reaches outside the repo, or authors a file that can't
even load under the workspace's detected module system is a `COMPILE_FAILED` — it feeds the bounded
compile-retry loop instead of surviving to kill the run at pre-flight. goaly also probes the
workspace once and injects **detected facts** (module system, lockfile, manifests — detected,
never assumed) into the authoring prompts, and steers the compiler toward an objective, in-repo,
runnable bar.

**A "build-and-use" goal can't be greened by a parallel reimplementation.** When the goal is to
build a reusable artifact *and use it*, a worker could satisfy a naive bar by re-deriving the logic
inline and never calling the artifact. An independent shape classifier (a neutral LLM call over the
goal only) flags build-and-use goals; the compiler must then author a **runtime usage assertion** —
a spy/call-through check that instruments the artifact's public entry points and asserts the
verified result is produced *through* them (a reimplementation records zero calls and fails). A
contract lacking the assertion is refused at compile and re-authored. The classifier is fail-open,
so it never blocks a legitimate run.

**Independence is checked, not assumed.** goaly warns loudly when the two keys collapse onto one
model (e.g. a bare `--model X`). Under `--generate --autonomous` the warning escalates when the
agent, judge, and approver all resolve to one model — the self-author + self-judge case. Prefer
`--approver-model` (and/or `--judge-model`) on a different model/provider so the second key is a
genuinely independent skeptic. Beyond the warning, goaly acts on it: the approver
[does not inherit `--model`](#the-sign-off-approver-does-not-inherit---model) where a distinct model
is available, and an irreducible collapse is recorded as the typed
[`SELF-JUDGED` degraded mode](#degraded-mode-self-judged) in the run header, the terminal summary
and `goaly runs show`.

**The second key can be a multi-vote panel.**

- `--approver-quorum N` (default 1) runs Sign-off as an N-reviewer panel behind the unchanged
  seam. It greens only on a strict supermajority of no-veto votes (`noVetoCount * 2 > N`) and only
  when every counted reviewer parsed; any reviewer that throws or returns garbage counts as a veto —
  a panel is never weaker than the single veto. `N = 1` is byte-for-byte the historical single
  call.
- Every reviewer is prompted **refute-first**: name a concrete way the diff could pass the verifier
  without meeting the goal, and veto unless it's ruled out. At `N > 1` reviewers sample at a small
  diversity temperature (`--approver-diversity-temp`, default 0.5) and cycle a lens taxonomy
  (correctness / security / goal-actually-met / prompt-injection / spec-gaming / test-tampering /
  hidden-regression). `--approver-lenses l1,l2,…` replaces the taxonomy with your own (operator
  config — never the fenced, untrusted diff).
- `--approver-models m1,m2,…` runs the panel across **distinct models** (reviewer *i* → model *i*,
  cycled). With it, the quorum defaults to the model count, and ≥2 distinct models make the panel
  a genuinely independent second key (the collapse warnings are suppressed). A quorum on one model
  is variance reduction, not independence — goaly warns about that too.
- **Cost:** a panel multiplies approver spend ~quorum× (metered against `--budget-tokens`).
  Mitigations: the panel stops polling once the outcome is mathematically decided, and reviewers
  share a cached prompt prefix (the lens rides the prompt tail). A small panel (≈3–5) is the
  practical range; quorum 1 is cost-neutral.

**Opt-in adversarial review (`--adversarial`)** — red-teaming at three points, all
veto/feedback-shaped, never a third key that can promote a red:

- **Contract red-team (before Seal).** A lensed critic panel (`--adversarial-contract-critics`,
  default 2) attacks each compiled `--generate` contract — gaming/vacuity, rubric-command mismatch,
  tamper/hard-code surface, reproducibility, and false-red/satisfiability. Critical findings trigger
  a bounded re-author round. Skipped for `--verify-cmd` (your own bar isn't second-guessed).
- **Plan critique (before the plan Seal, `--phased`).** The same shape
  (`--adversarial-plan-critics`, default 2) attacks the authored plan; a `--plan-file` plan is
  never critiqued.
- **Refuter rung (after a green ladder).** N refuters (`--adversarial-refuters`, default 3) run as
  a built-in rung appended after every frozen rung — part of the ladder, never part of the
  `contractHash`. They run only on a candidate green, prompted refute-first; the green survives
  only a strict supermajority of parsed "could not refute" votes. A refuted green re-enters the
  loop as verifier feedback and never reaches Sign-off.
- **Fail direction.** The pre-Seal critics are advisory (a broken panel passes through — the Seal
  gates still stand). The refuter rung is fail-closed (a thrown/unparseable refuter counts as
  refuted; zero parseable refuters is an unevaluable red).
- `--adversarial` also widens Sign-off to a 3-reviewer panel unless `--approver-quorum` is set;
  `--critic-model` picks one model for all critics/refuters. Panels short-circuit once decided and
  share cached prompt prefixes. Without the flag, a run is byte-for-byte unchanged.

### The satisfiability critic (false-red guard)

Flag: `--no-satisfiability-critic` (the critic itself is ON by default under `--generate`).


Everything above attacks a **false green** — could a lazy worker pass this bar without meeting the
goal? The mirror failure is a **false red**: a frozen bar that *no* correct implementation can pass.
That one costs the entire run — every iteration reds, the worker keeps "fixing" already-correct
code, and the loop ends at `maxIterations` or the budget with a good tree thrown away.

So goaly runs one extra critic **before the freeze**, under a fifth lens — `FALSE-RED /
SATISFIABILITY`: *could a correct, complete implementation still FAIL this bar?* It looks for

- assertions no implementation can satisfy — above all a spy/mock **call-count assertion made after
  the spy was restored or reset** (vitest `mockRestore()`/`mockReset()`/`restoreAllMocks()` and jest
  `restoreAllMocks()` clear `mock.calls`, so a later `expect(spy).toHaveBeenCalled()` reds a perfect
  implementation), or an assertion on state the test itself already tore down;
- bars over-coupled to one import graph, file layout, or internal structure instead of the
  observable behavior the goal names;
- assertions on nondeterministic values (wall-clock timing, iteration order, generated ids, exact
  float equality) or on the environment (locale, timezone, CPU count, absolute paths).

Details that matter:

- **On by default** — the only pre-Seal review step that is. The asymmetry justifies it: a false red
  burns a whole run; the guard is *one* LLM call at compile time. It is **independent of
  `--adversarial`**, which stays off by default.
- **One call per re-author round**, and only when `--generate` actually authored verification files
  (nothing authored ⇒ nothing to check; `--verify-cmd` is never checked at all).
- **Never softening.** A finding is "critical" only if the critic can *name* a correct implementation
  the bar would still red. The re-author feedback says **make this bar satisfiable by a correct
  implementation — never make it easier**: no assertion a correct implementation would already pass
  may be deleted or loosened, and the re-authored bar must still be **red on the current tree**
  (the soundness pre-flight is the backstop that enforces it).
- **Advisory and fail-open**, like the other pre-Seal critics: a critic that errors or returns
  unparseable output drops its findings and the contract proceeds to Seal. It can never weaken a rung.
- **Metered** under the compile phase against `--budget-tokens`, and it uses `--critic-model` like
  the other critics.
- The compiler's own authoring prompt carries the matching "do not author these" rule, naming the
  post-`mockRestore` call-count assertion explicitly — the critic is defense in depth, not the only
  guard.

Opt out with `--no-satisfiability-critic` (config-file key `no-satisfiability-critic`). With
`--adversarial` on, the same lens is also cycled as the fifth member of the contract red-team panel.

### The contract dry run (compile-time positive control)

Flag: `--contract-dry-run true|false` (ON by default under `--generate`).

Every guard above — the red-team lenses, the satisfiability critic, the soundness pre-flight — is an
LLM **opinion** about the bar. This one is an **execution**.

The frozen bar already gets a *negative* control: the pre-flight runs the deterministic rung(s) once
and requires them to be **red** on the current tree, and a bar that is already green there is caught
as `CONTRACT_UNSOUND`. That proves the bar discriminates against nothing. Nothing proved the other
half — that the bar can **ever** go green. A bar no implementation can satisfy passes pre-flight (its
red looks exactly like an honest "implementation missing" red) and the run is unwinnable from that
moment on.

So, strictly **before the freeze**:

1. after the compiler authors the verification files, it also authors a **throwaway reference
   implementation** of the goal;
2. that reference is materialized in a **scratch copy** of the workspace, next to the authored
   verification files;
3. the contract's one-time `setup` (if any) and its **deterministic rungs** run there — judge rungs
   are out of scope, since an LLM rubric cannot be positively controlled by execution;
4. **green** ⇒ the bar is satisfiable: the scratch copy is destroyed and the contract freezes
   unchanged. **red** ⇒ the bar is defective: the freeze is **refused** and the failure feeds the
   same bounded re-author loop as a compile failure (`--max-compile-retries`).

Details that matter:

- **The reference implementation never leaves the scratch copy.** It is written only there, the copy
  is destroyed on every exit path (green, red, or error), and it appears in neither your workspace,
  the run diff, nor any worker prompt. It is not reused as a hint, a seed, or a fallback — handing
  the worker the solution would defeat the run and recreate exactly the deadlock the vacuous-contract
  check exists to catch. The refusal fed back to the author quotes only the failing rung's own
  output, never the reference source. A reference file whose path collides with an authored
  verification file is discarded, so the control can never rewrite the bar it measures.
- **Fail-open on infrastructure.** No LLM, an unparseable reference, a scratch-copy failure (including
  a workspace too large to copy cheaply), a `setup` that cannot run there, a rung that timed out or
  could not be started — each logs and freezes exactly as it does today. The dry run can only *reject*
  a contract or step aside; it can never turn a red bar green or relax a rung.
- **`--generate` only**, and only once the contract actually authored verification files. A
  user-supplied `--verify-cmd` is your own bar and is never dry-run.
- **Cost:** one extra authoring call plus one verification run per compile attempt, metered under the
  compile phase against `--budget-tokens`, using `--compiler-model`. Weigh it against the run it
  prevents — the motivating incident burned ~39 min and ~2M tokens against a single unsatisfiable
  assertion.

Opt out with `--contract-dry-run false` (config-file key `contract-dry-run`).

**The verify command runs with a credential-scrubbed environment.** Credential-looking variables
(`*_TOKEN`, `*_KEY`, `*SECRET*`, `AWS_*`, `GITHUB_*`, …) are stripped so they can't be exfiltrated
through a check; PATH/HOME and the toolchain env are kept. This narrows but does not eliminate the
host trust boundary — only run `--autonomous` against repositories you trust, or pass `--sandbox`.

## Sandboxing

`--sandbox` (opt-in OS isolation, [ADR 0007](adr/0007-sandboxing-model.md)) jails the two
untrusted-code execs — the coding agent and the verify command. Off by default: without the flag,
behavior is byte-for-byte unchanged and the caller owns isolation (CI/container).

| Flag | Meaning |
| --- | --- |
| `--sandbox[=<mode>]` | `none` (default) · `auto` (best available: `bwrap`, then `firejail`, else `container`) · `bwrap` · `firejail` · `container` (a `docker`/`podman run --rm`; portable, covers macOS). Bare `--sandbox` = `auto`. |
| `--sandbox-net <v>` | egress: `none` (default when sandboxed) · `allow` (full egress) · `allow:<host,…>` (an allowlist applied to **both** seams). |
| `--sandbox-image <ref>` | container image (`container` mode; default `debian:stable-slim`). |
| `--sandbox-runtime <r>` | `docker` (default) · `podman`. |

**Fail-closed:** a requested mechanism absent on the host refuses to start — never a silent
downgrade to unsandboxed. Flags parse with Zod; unknown values are usage errors.

Per-seam profiles when sandboxed:

| Seam | Filesystem | Network | Env |
| --- | --- | --- | --- |
| Harness (the agent) | rw workspace, ro system | allow (needs the model API) | full (needs API keys) |
| Verifier | rw workspace, ro system | none by default | credential-scrubbed |

An **allowlist** (`--sandbox-net allow:api.anthropic.com,*.npmjs.org`) applies to both seams at
once: hosts may be bare names, subdomain wildcards, or pin a port. Traffic routes through a small
loopback egress proxy goaly starts; every other egress is denied (HTTP 403 / refused CONNECT) and
denied attempts are summarized after the run. Because both seams are constrained, the agent's
model-API host must be on the list too. In both seams, `$HOME` credential locations (`~/.ssh`,
`~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.docker`, `~/.kube`, `~/.npmrc`) are denied.

A verify command that needs the network (e.g. an `npm test` that installs) fails under the default
`--sandbox-net none` — pass `--sandbox-net allow` deliberately. The container path mirrors the
workspace at the same absolute path inside the jail so relative/pinned paths resolve.

> **Threat model** (ADR 0007): `--sandbox` defends against secret exfiltration via the
> verifier/agent, host-FS damage outside the workspace, and `$HOME` credential reads. It does
> **not** defend against a compromised model endpoint the agent may talk to, supply-chain code
> pulled with the network on, or kernel 0-days. The allowlist is proxy-based filtering — a strong
> guardrail for cooperating tooling that honours proxy env vars, not an airtight jail against
> malicious native code opening raw sockets (a kernel-level netns/nftables allowlist is future
> work). It is fail-closed: if the proxy can't start, the run errors.

## Training arc (experimental)

`--harness goaly-code` exists so goaly can own the inference path and specialize a small model to
its own loop, using the frozen ladder + independent approver as a reward-hacking-resistant training
signal (a policy cannot win by weakening the bar). The data pipeline is shipped and embeddable:

```ts
import { exportRunTrajectory, toSftJsonl, BENCH_TASKS, runBench, summarizeBench } from 'goaly';

// 1. Every goaly-code run is an automatically-LABELED trajectory (tagged with its two-key outcome).
const traj = await exportRunTrajectory({ stateDir: '.goaly', runId, sessionStore });
// 2. Rejection-sample PASSED trajectories → an SFT dataset in goaly-code's tool schema.
const sftJsonl = toSftJsonl(records, { maxIterations: 3 });
// 3. A held-out eval bench gates each new model (pass@1, iters, tokens).
const summary = summarizeBench(await runBench(BENCH_TASKS, runTask));
```

Slices 0–1 (harness + transport) and the Slice 2–3 data pipeline are implemented and verified
end-to-end. The remaining slices are infra-gated: training (provider fine-tune / local LoRA),
expert-iteration RL using the ladder as reward, and a productionized bench-gated `goaly-coder-vN`.
See [ADR 0008](adr/0008-goaly-code-harness.md) and [ADR 0009](adr/0009-training-data-pipeline.md).

## Glossary

Plain-language definitions of the project-specific terms used across the docs. (For the terse
contributor *"one term, one meaning"* reference, see [`CONTEXT.md`](../CONTEXT.md).)

### Core idioms

- <a id="g-fail-closed"></a>**Fail-closed** — when anything errors or can't be parsed, it resolves
  to the *safe* answer: a FAIL / VETO / aborted run, never a false green. A malformed grader is a
  failure, not a pass. Invariant #4 and the spine of the design.
- <a id="g-fail-open"></a>**Fail-open** — the deliberate opposite, used only where a wrong "block"
  is worse than a wrong "proceed": an uncertain *advisory* check proceeds, because the real
  fail-closed gates still govern the outcome downstream (e.g. the pre-flight soundness classifier).
- <a id="g-reward-hacking"></a>**Reward-hacking** (specification gaming) — reaching the *measured*
  goal ("the test passes") without meeting the *actual* goal, e.g. by weakening the test.
  Preventing this is goaly's reason to exist.
- <a id="g-frozen"></a>**Frozen / `contractHash`** — the success contract is authored once, hashed,
  and locked at Seal; no later step can rewrite it, and the hash is logged every iteration to prove
  the bar never moved.
- <a id="g-two-keys"></a>**Two keys (for DONE)** — the frozen verifier ladder passes *and* the
  independent approver doesn't veto. "Tests pass" is not "done".
- **Seam** — a boundary where a real implementation and a fake are interchangeable. goaly has four
  real seams (harness, verifier/ladder, approver, clock+budget) plus the internal read-only
  `LlmProvider` seam.

### The loop & its gates

- **Reducer / Orchestrator** — the pure, synchronous `step(state, event) -> [state, Command[]]`
  that owns all policy and makes zero LLM/IO calls (invariant #1).
- **Driver** — the imperative half: performs the Commands (run the agent, judge, approve, persist)
  and feeds the resulting Events back. The only place that touches a clock, process, or disk.
- **DECIDE** — the pure truth table mapping (ladder verdict, approval, stuck, iteration) to
  `CONTINUE / DONE / FAILED / ABORTED`.
- **Seal** — the contract gate: once, before the loop, a human (or `--autonomous`) approves the
  frozen contract.
- **Sign-off / Approver** — the result gate: an independent, veto-only reviewer run every green
  iteration. It can block a green, never promote a red.
- **Compiler** — the read-only LLM step that authors the verification under `--generate`.
- **Phased / `planHash`** — `--phased` decomposes a goal into a frozen plan of sub-goals (a DAG,
  listed dependencies-first), each its own two-key contract, ending in cumulative acceptance on the
  original goal.
- **Frontier** — the phases of a frozen plan whose dependencies have all completed: what
  `--parallel-phases` runs concurrently, recomputed after every wave and on `--resume`.

### Verification

- <a id="g-ladder"></a>**Verifier ladder / rung** — the composite check, run
  cheapest-and-hardest-to-game first: deterministic rungs before any LLM judge, short-circuiting on
  the first deterministic fail.
- **Verdict** — the unified `{ pass, confidence, detail }` every verifier returns.
- **Quorum / confidence floor** — a judge rung samples the model *quorum* times and passes only if
  enough samples agree above the floor.
- **Rubric** — the frozen judging criteria for a judge rung.
- **Integrity guard** — authored files are pinned by content hash; a guard rung fails closed on any
  change, so the worker can't rewrite the bar it's measured against.
- **Vacuous bar** — an authored check that trivially passes without measuring anything. Rejected at
  compile.
- **Untrusted-data fencing** — the judge/approver receive the worker-controlled diff inside a
  nonce-delimited envelope and never obey instructions hidden in it.

### Prepare & soundness

- **Setup / `SETUP_FAILED`** — the one-time pre-loop bootstrap. A failing user `--setup-cmd` is
  fatal; a failing compiler-authored setup is best-effort.
- **Pre-flight** — running the frozen deterministic checks once before the first agent turn.
- **`CONTRACT_UNSOUND`** — a typed abort (before any worker token) when the frozen verification is
  itself defective: it can't run, or it already passes vacuously on a from-scratch tree.
- **From-scratch** — a tree with no implementation source yet; the bar is red by definition, so
  soundness biases toward "honest red, proceed".
- **`CONTRACT_DEFECTIVE`** — the in-loop sibling of `CONTRACT_UNSOUND`: a repeat-failure streak
  re-adjudicated (once per run, read-only) against a tree that now HAS an implementation, and found
  to be failing an assertion no implementation could satisfy. Relabels an abort that was already
  happening; the tree is worth keeping. See
  [In-loop contract-fault adjudication](#in-loop-contract-fault-adjudication-contract_defective).
- <a id="g-recontract"></a>**Re-contract / successor run** — the recovery from a `CONTRACT_DEFECTIVE`
  verdict: `goaly --from-run <id> --recontract` keeps the tree, re-authors the bar from the defect
  report, and freezes a NEW contract under a NEW run id, recording `predecessorRunId` /
  `predecessorContractHash` / the verdict in its header. No contract is ever mutated — "the bar was
  wrong" becomes an auditable chain of frozen contracts. See
  [Re-contracting a defective bar](#re-contracting-a-defective-bar---recontract).

### Failure & stuck

- <a id="g-stuck"></a>**Stuck detection** — bailing before `--max-iterations` with a typed reason:
  no-diff, repeat-failure, oscillation, harness-crash, contract-unevaluable, timeout-no-diff, or
  budget — one of which (repeat-failure) may be re-adjudicated as `CONTRACT_DEFECTIVE`. See
  [Stuck detection](#stuck-detection).
- **Terminal statuses** — DONE (both keys), FAILED (typed failure), ABORTED (Seal-reject / stuck /
  driver error), INCOMPLETE (never finished — shown in `runs list`).

### Persistence & resumption

- <a id="g-write-ahead"></a>**Write-ahead run log** — the append-only event stream under
  `.goaly/<runId>/`, written before state advances; the single source of truth for replay and
  resume (≠ the diagnostics log).
- **Replay / resume** — run state is a pure fold over the logged events; `--resume` replays then
  continues, repeating no completed iteration.
- **Command vs Event** — a Command is data describing an effect the Driver must perform (never
  persisted); an Event is its resolved result (persisted write-ahead).
- **`diffHash`** — a non-mutating content hash of the working tree that drives stuck detection.
- **Baseline / checkpoint** — the git ref a diff is computed against; a checkpoint is a private
  `git write-tree` snapshot (no commit) that can advance it.

### Architecture & wiring

- **Harness / Adapter / Codec** — a harness is a coding agent run headlessly; the adapter is its
  `run(prompt, sessionId?)` wrapper; a codec holds one CLI's quirks in one module.
- **LLM provider (internal seam)** — the read-only seam the compiler/judge/approver/observer call.
- **Composition root** — the one place real implementations are wired to the seams; embedders swap
  seams here.
- **Sandbox / launcher / egress proxy** — opt-in OS isolation of the two untrusted execs; a
  launcher translates a per-seam profile into `bwrap`/`firejail`/container flags; the egress proxy
  enforces a host allowlist.

### Observability & sessions

- **Stream / `AgentStreamEvent` / transcript** — the tool-neutral live event taxonomy
  (`--stream`) and its durable JSONL form (`--stream-transcript`). Pure observability.
- **Observer (`--explain`)** — the opt-in read-only narrator. Advisory only.
- **Spend report / `estimated` / `unknown`** — the per-run token breakdown; unreported usage is
  estimated from streamed turns or marked unknown loudly, never a silent zero.
- **Session (`--from-run` / `--inherit-session`)** — a `sessionId` is the harness's handle to a
  continued CLI conversation; `--from-run` starts a new re-verified goal that knows the prior run,
  `--inherit-session` also keeps the agent's memory.
