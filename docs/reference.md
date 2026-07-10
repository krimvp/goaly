# goaly reference

The complete practical reference: every flag, mode, and guarantee. The [README](../README.md) is
the short tour; this is the depth. Architecture lives in [`ARCHITECTURE.md`](../ARCHITECTURE.md),
rationale in [`DESIGN.md`](../DESIGN.md) and [`docs/adr/`](adr/), the terse contributor glossary in
[`CONTEXT.md`](../CONTEXT.md).

## Contents

- [CLI cookbook](#cli-cookbook)
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

# Jail the agent AND the verifier in an OS sandbox:
goaly run --goal "..." --verify-cmd "npm test" --sandbox                            # auto-detect
goaly run --goal "..." --verify-cmd "npm test" --sandbox=bwrap --sandbox-net allow  # let npm fetch

# USD cost overlay on the spend report (tokens-only without it):
goaly run --goal "..." --verify-cmd "npm test" --cost-table ./prices.json

# Inspect past runs (read-only; re-runs nothing) — or in the browser:
goaly runs list
goaly runs show run-<id>
goaly runs resume-cmd run-<id>
goaly ui                          # http://127.0.0.1:4180, localhost-only
```

`goaly help` lists every flag. Exit codes: `0` DONE · `1` FAILED/ABORTED · `2` usage error ·
`130` interrupted (Ctrl-C; the run stays resumable).

Goal, intent, and rubric each accept exactly one source: inline (`--goal "…"`), a file
(`--goal-file <path>`), or stdin (`--goal -`). More than one source per field is a usage error.

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
  "budget-tokens": 500000
}
```

Booleans take `true`/`false` (`false` = "not set"). Per-invocation flags — `--workspace`,
`--resume`, `--config` itself — are never read from a file. An unknown key, non-primitive value,
or invalid JSON is a usage error (the config seam parses with Zod and fails closed).

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
`--stream`).

**Heavy `--generate` authoring may need a larger `--llm-timeout-ms`.** The compiler authors the
whole contract in one call; a timeout there surfaces as a `COMPILE_FAILED` with a hint naming this
flag (re-issuing the same heavy call would just time out again).

## Seal: the contract gate

At Seal (unless `--autonomous`) goaly prints the frozen contract and prompts:

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

**Compile is resilient, not one-shot.** A `COMPILE_FAILED` (a correctable authoring mistake)
re-authors the verification with the error fed back, up to `--max-compile-retries` (default 2;
`0` disables). Exhausting the budget is a typed `FAILED`, never a skipped check. Where the provider
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
broken frozen verifier is also caught at runtime by repeat-failure stuck detection. A plain
`--verify-cmd` run with no authored files skips the soundness check.

## The verifier ladder

The composite check runs **cheapest-and-hardest-to-game first**: deterministic rungs (exit codes,
tests) before any LLM judge, short-circuiting on the first deterministic fail. A rung that errors
is fail-closed — a malformed grader is never a green.

- **Guard rung (built-in, `--generate`).** Files goaly authors are pinned by content hash inside
  the frozen contract; an integrity guard runs first every iteration and fails closed if any
  authored file changed since the contract froze.
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
| budget | `--budget-tokens` / `--budget-wall-ms` exhausted | the budget flags |

Details that make these accurate rather than trigger-happy:

- **Repeat-failure** normalizes volatile tokens (timestamps, PIDs, temp paths) before comparing,
  and keys on the verifier-failure signature independent of the diff hash — a worker that churns
  unrelated files while the same error repeats is still caught, and the abort names the repeated
  signature.
- **Contract-unevaluable** distinguishes a verification-*environment* failure (verify command timed
  out / couldn't start, judge errored) from a real red: the tree may be correct-but-unverified, so
  it's never blamed on the code — still fail-closed, never a green. It keys only on facts goaly
  owns, never exit-code/error-string guessing.
- **Ephemeral verifier artifacts don't count as progress.** A conservative default set is excluded
  from the tree hash (Python bytecode/`__pycache__`, pytest/mypy/ruff caches, JS
  `.nyc_output`/`htmlcov`) so a verify command that regenerates them can't disguise a no-op turn.
  The defaults never touch build output (`build/`, `dist/`, `target/`). `--diff-ignore "<p1,p2,…>"`
  adds your own git pathspecs (deduped with the defaults; `*` spans `/`).
- **A no-diff iteration is excused** when the agent never had a fair chance to act: the previous
  turn timed out, crashed, or was truncated, or the ladder is green and a fresh Sign-off veto is
  the only blocker. A perpetually truncated run still terminates at `--max-iterations` / budget.

## Diff baselines (`--baseline` and `--delta-verify`)

The worker's diff — what the Sign-off approver reviews — is computed against `HEAD` by default.

**`--baseline <ref>`** diffs against any git ref/SHA instead, so a multi-step build can chain runs
without committing onto your branch: point run *N+1* at the tree run *N* finished on. The ref must
resolve (`git rev-parse --verify`) before the run starts — fail-closed, never a silently degraded
diff. The baseline only changes what `diff()` is computed *against*; the working-tree hash that
drives stuck detection is unaffected. goaly can also advance the baseline internally via a private
tree snapshot (`git write-tree` through a throwaway index — no commit, no `HEAD`/branch/index
movement), recorded in the run log so `--resume` reconstructs it.

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
into a **frozen, ordered plan of small sub-goals**, runs each as its own frozen two-key contract,
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
  `{ "phases": [{ "goal", "intent"?, "rubric"? }] }`. The plan is parsed fail-closed and frozen
  (`planHash`, logged loudly); a planner error, bad plan, or more than `--max-phases` (default 10)
  is a typed `PLAN_FAILED`, never a skipped decomposition.
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
`--parallel-phases` (opt-in), consecutive plan phases sharing a `group` value form a **wave** that
executes concurrently, then merges — without weakening a guarantee:

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
- **v1 limits:** requires `--autonomous` and a `--plan-file` with `group` fields (the LLM planner
  doesn't author groups yet); a crash mid-wave re-runs the whole wave on `--resume`; wave-child
  spend reports under the parent's `harness` layer. Grouped plans run strictly sequentially without
  the flag; the grouping is frozen into `planHash`.

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
goaly runs show run-<id>         # frozen contract + hash, Seal outcome, every verdict, totals
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
  report. Estimated tokens still count against the cap.
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
genuinely independent skeptic.

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
  tamper/hard-code surface, reproducibility. Critical findings trigger a bounded re-author round.
  Skipped for `--verify-cmd` (your own bar isn't second-guessed).
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
- **Phased / `planHash`** — `--phased` decomposes a goal into a frozen, ordered plan of sub-goals,
  each its own two-key contract, ending in cumulative acceptance on the original goal.

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

### Failure & stuck

- <a id="g-stuck"></a>**Stuck detection** — bailing before `--max-iterations` with a typed reason:
  no-diff, repeat-failure, oscillation, harness-crash, contract-unevaluable, or budget. See
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
