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
- **Compile is resilient, not one-shot.** A `COMPILE_FAILED` (a correctable authoring mistake — bad
  path, transient parse miss) re-authors the verification with the error fed back as guidance, up to
  `--max-compile-retries` (default 2; `0` disables), before the run fails — so one bad compile output
  no longer discards a valid plan. Exhausting the budget is still a typed `FAILED`, never a skipped
  check. (Mirrors the Gate A revise loop; the reducer stays pure.)
- **Stuck detection** bails before `maxIterations` with a reason: no-diff, repeat-failure (volatile
  tokens like timestamps / PIDs / temp paths are normalized away first, so a noisy-but-identical
  failure still trips it), short-period oscillation (period-N, not just A,B,A,B), and budget. Tune it
  with `--stuck-no-diff`, `--stuck-repeat-threshold`, `--stuck-oscillation`. Use `--diff-ignore` to
  keep verifier-produced artifacts (coverage dirs, `__pycache__`, build output) out of the tree hash
  so they can't make a no-op agent look like it changed something. A no-diff iteration is **excused
  once** when the agent never had a fair chance to act — the previous turn timed out, or the ladder is
  green and a **fresh Gate-B veto** is the only blocker — so a correct, actionable critique isn't
  thrown away before the worker gets one real turn to respond to it (a *second* unproductive no-diff
  still aborts).
- **Diff baseline** — the worker's diff (what the Gate-B approver reviews) is computed against `HEAD`
  by default, but `--baseline <ref>` points it at any git ref/SHA instead. Chain a multi-step build by
  pointing each run at where the last one finished, so every run reviews only its own delta —
  **without `git commit`-ing onto the user's branch**. The baseline only changes what `diff()` is
  computed *against*; the working-tree hash that drives stuck-detection is unaffected. (goaly can also
  advance the baseline internally via a private tree snapshot — no commit, no `HEAD`/branch/index
  movement — recorded so `--resume` reconstructs it.)
- **Write-ahead run log** under `.goaly/<runId>/` makes every run replayable, **resumable**, and
  **inspectable** after the fact (`goaly runs list` / `goaly runs show`).
- **Per-run spend report:** every run ends with a token breakdown by layer — the **harness** vs. the
  **LLM steps** (compiler / judge / approver) — and against any `--budget-tokens` cap. Totals count
  **every category, cache included** (input + output + cache-read + cache-write), with a per-category
  split surfaced — so cache-heavy providers like Claude aren't undercounted. It's folded from the run
  log, so `--resume` and `goaly runs show` rebuild the same numbers; a harness/provider that reports
  no usage degrades that spend to **"unknown" loudly** (a warning + an `unknown` mark on the budget)
  so the token cap is never silently read as zero — wall-clock stays the backstop. Optional USD cost
  via `--cost-table` (flat **or per-category** rates); **tokens-only by default**.

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
- **Vacuous and un-runnable authored bars are refused.** A `--generate` command that trivially passes
  without measuring anything (`true`, `:`, `exit 0`, …), or one that reaches outside the repo (e.g. a
  helper at `/tmp/…`), is rejected at compile (`COMPILE_FAILED`) rather than frozen as a hollow or
  un-runnable contract. The compiler is also steered, at the prompt level, toward an **objective,
  in-repo, runnable** bar — author over the repo's existing tooling, keep helpers inside the
  workspace, and don't write rubrics that judge runtime/visual behavior a grader can't execute. A
  rejected bar feeds the bounded compile-retry loop above, so the compiler can self-correct.
- **Independence is checked, not assumed.** goaly warns loudly when the "two independent keys" collapse
  onto one model (e.g. a bare `--model X`, which would make the approver share the worker's/judge's
  blind spots); pass `--approver-model` (or a different `--llm-provider`) to separate them.
- **The verify command runs with a credential-scrubbed environment.** The verifier executes
  worker/model-authored code on your host every iteration; goaly strips credential-looking variables
  (`*_TOKEN`, `*_KEY`, `*SECRET*`, `AWS_*`, `GITHUB_*`, …) from its environment so they can't be
  exfiltrated through a check. PATH/HOME and the rest of the toolchain environment are kept, so
  ordinary test commands are unaffected. (This narrows, but does not eliminate, the host trust
  boundary — only run `--autonomous` against repositories you trust, or pass `--sandbox`.)

### Sandboxing

The env-scrub above narrows the host trust boundary; `--sandbox` (opt-in OS isolation, ADR
[0007](docs/adr/0007-sandboxing-model.md)) *enforces* it. **It's off by default** — without the flag
behavior is byte-for-byte unchanged and the caller is responsible for isolation (CI/container). When
on, goaly jails the **two untrusted-code execs** — the coding agent **and** the verify command — at
the composition root; the pure reducer and git plumbing (`diff`/`diffHash`, which must read the real
`.git`) are never touched.

| Flag | Meaning |
| --- | --- |
| `--sandbox[=<mode>]` | `none` (default, no isolation) · `auto` (best available: `bwrap` on Linux, else `container`) · `bwrap` (Linux bubblewrap) · `container` (a `docker`/`podman run --rm`, portable, covers macOS). Bare `--sandbox` means `--sandbox=auto`. |
| `--sandbox-net <v>` | egress policy: `none` (default when sandboxed) · `allow` (full egress) · `allow:<host,…>` (an **allowlist** — only the listed hosts are reachable). With `none`/`allow` the **agent always keeps full egress** (it needs the model API); an allowlist constrains **both** seams, so the agent's model-API host must be on the list too. |
| `--sandbox-image <ref>` | container image (`container` mode only; default `debian:stable-slim`). |
| `--sandbox-runtime <r>` | `docker` (default) · `podman` (`container` mode only). |

**Fail-closed (invariant #4):** if a requested mechanism is **absent on the host, the run refuses to
start** — a clear error, no subprocess spawned — it never silently downgrades to unsandboxed. The
flags parse with Zod (invariant #6); an unknown mode/value is a usage error.

**Per-seam profiles** (applied only when sandboxed):

| Seam | Filesystem | Network | Env |
| --- | --- | --- | --- |
| **Harness** (the coding agent) | rw workspace, ro system | **allow** (needs the model API) | full (needs API keys) |
| **Verifier** (the verify command) | rw workspace, ro system | **none** by default (`--sandbox-net allow` to open it) | already credential-scrubbed |

An **allowlist** (`--sandbox-net allow:<host,…>`) is the exception to the per-seam split: it applies
to **both** seams at once. Each host may be a bare hostname (`api.anthropic.com`), a subdomain
wildcard (`*.npmjs.org` — matches the base domain and any subdomain), and may pin a port
(`host:443`). The network stays up but is routed through a small allowlisting egress proxy goaly
starts on the host (loopback); only the listed hosts are reachable, every other egress is **denied**
(HTTP 403 / refused CONNECT), and denied attempts are recorded and summarized after the run
(`sandbox egress denied`). The point (issue #39): `npm test` can reach the registry without *also*
opening the unrestricted exfiltration egress that full `allow` does — but because both seams are
constrained, the agent's model-API host must itself be on the list.

In **both** seams the workspace is bound read-write while the rest of the system is read-only, and
`$HOME` credential locations (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gcloud`, `~/.docker`,
`~/.kube`, `~/.npmrc`) are **denied** — defense in depth on top of the env scrub.

**Network/FS tension:** a verify command that fetches the network (e.g. an `npm test` that installs
or hits a service) will **fail with the default `--sandbox-net none`** — pass `--sandbox-net allow`
to let the verifier reach the network. This tradeoff is an explicit, documented toggle, not a hidden
default. The container path mirrors the workspace at the **same absolute path** inside the jail so
pinned/relative paths still resolve.

```bash
# Jail the agent and the verifier; auto-pick the host mechanism (refuses to start if none is present):
goaly run --goal "..." --verify-cmd "npm test" --sandbox

# Force Linux bubblewrap, and let the verifier reach the network (npm test fetches):
goaly run --goal "..." --verify-cmd "npm test" --sandbox=bwrap --sandbox-net allow

# Allowlist egress: only these hosts are reachable from BOTH seams; all other egress is denied.
# (The agent's model-API host must be on the list too — here api.anthropic.com.)
goaly run --goal "..." --verify-cmd "npm test" --sandbox \
             --sandbox-net allow:api.anthropic.com,*.npmjs.org,registry.yarnpkg.com

# Portable container jail on a custom image / runtime (covers macOS via Docker/podman):
goaly run --goal "..." --verify-cmd "npm test" \
             --sandbox=container --sandbox-image node:20-slim --sandbox-runtime podman
```

> The threat model (ADR 0007): `--sandbox` defends against secret exfiltration via the verifier/agent
> (FS + env + egress), host-FS damage outside the workspace, and `$HOME` credential reads. It does
> **not** defend against a compromised model endpoint the agent is allowed to talk to, supply-chain
> code pulled with the network on, kernel/sandbox-escape 0-days, or anything when `--sandbox` is off.
> The `allow:<host,…>` allowlist is **proxy-based** filtering: a strong guardrail and audit trail for
> cooperating tooling (the agent CLI, npm, pip, git-over-https) that honours the proxy env vars, **not**
> an airtight jail against deliberately malicious native code that opens raw sockets bypassing the proxy
> (a hard kernel-level allowlist via netns + nftables is future work). It is fail-closed: if the proxy
> can't start, the run errors rather than running with unrestricted egress.

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
>
> **Authored verification files need no `.gitignore` step.** Under `--generate`, files the compiler
> authors (tests/helpers) are written to idiomatic locations and auto-registered in
> `.git/info/exclude` — git's *per-clone, never-committed* ignore list — so they never appear in your
> `git status` and are never accidentally committed, with no tracked file touched. A loud log line
> names each authored file and how to keep it (`git add -f`). The integrity guard still pins them by
> content hash on disk (excluded ≠ unprotected). Use `--verify-dir <dir>` to steer where they land.

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

# Diff against a baseline instead of HEAD — keep a multi-step build's diff small with no commits:
goaly run --goal "step 2 of the build" --verify-cmd "npm test" --baseline <ref-or-sha>

# Author verification into test/, give the compiler more self-correction, and loosen no-diff for an
# exploratory build (authored files are auto git-excluded, so your `git status` stays clean):
goaly run --goal "..." --generate --autonomous --verify-dir test \
             --max-compile-retries 3 --stuck-no-diff false

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

# Persist that same stream durably for offline replay (.goaly/<runId>/stream.jsonl), any harness:
goaly run --goal "..." --verify-cmd "npm test" --stream-transcript

# Cap how long each step may run (subprocess kill-timeouts, in ms):
goaly run --goal "..." --verify-cmd "npm test" \
             --harness-timeout-ms 900000 --llm-timeout-ms 120000 --verify-timeout-ms 60000

# Jail the agent AND the verifier in an OS sandbox (refuses to start if no mechanism is present):
goaly run --goal "..." --verify-cmd "npm test" --sandbox            # auto-detect (bwrap / container)
goaly run --goal "..." --verify-cmd "npm test" --sandbox=bwrap --sandbox-net allow   # let npm fetch

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

### Diff baseline (`--baseline`)

The worker's diff — the text the **Gate-B approver** reviews — is computed against `HEAD` by default.
`--baseline <ref>` makes `goaly` diff against any git ref or SHA instead. This lets you chain a
multi-step build **without committing onto the user's branch**: point run *N+1* at the tree run *N*
finished on, and each run reviews only its own delta.

- The ref is validated to resolve (`git rev-parse --verify`) **before the run starts** — an unknown
  ref refuses to start (fail-closed), never a silently degraded diff. Precedence: **CLI flag > config**.
- It changes only what `diff()` is computed *against*. The **working-tree content hash** that drives
  no-diff / oscillation detection is unchanged (it always hashes the working tree), so stuck-detection
  stays meaningful. The empty-tree fallback for a repo with no `HEAD` still applies.
- `goaly` can also advance the baseline **internally** via a private tree snapshot — a `git write-tree`
  through a throwaway index, so it writes **no commit and never moves `HEAD`, the branch, or the user's
  staging area** (objects are left dangling, gc-collectable; no `refs/goaly/*` is left behind). Each
  snapshot is recorded in the run log so `--resume` reconstructs the advanced baseline. (The *policy*
  for when to snapshot automatically is a follow-up; this ships the primitive + the explicit flag.)

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
  by category  in 412 · out 18,902 · cache-read 471,902 · cache-write 10,558
budget:      501,774 / 500,000 tokens (100%) — budget exceeded
```

**Counts every token category — including cache.** The per-call total is the sum of **input +
output + cache-read + cache-write** (or a provider-supplied `total_tokens`), and the categories are
kept as a breakdown (the `by category` line). This matters for cache-heavy providers like Claude,
where cache-read is usually the *majority* of real throughput — counting only input+output would make
both the report and the `--budget-tokens` guard a gross undercount.

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
overlay: pass `--cost-table <path>` to a JSON file mapping **model → price** (a `"default"` key
prices any unlisted model). A price is either a single blended **USD per 1,000,000 tokens** number,
or a **per-category** object — `input` / `output` / `cacheRead` / `cacheWrite` rates (plus an
optional `default` for un-split spend). Per-category rates are the accurate choice, since output,
input, and the two cache buckets are priced very differently (output ≈ 5× input, cache-read ≈ 0.1×).
Each layer is priced by *its* resolved model; a category (or layer) whose model isn't priced is left
out and the total is marked approximate.

```jsonc
// prices.json — a flat $/1M rate, or a per-category map; "default" covers anything unlisted
{
  "claude-opus-4-8": { "input": 15, "output": 75, "cacheRead": 1.5, "cacheWrite": 18.75 },
  "claude-sonnet-4-6": 3,
  "default": 5
}
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

**Durable stream transcript** (`--stream-transcript`) persists that *same* canonical stream to a
**separate per-run file**, `.goaly/<runId>/stream.jsonl` — one `{ phase, …event, ts }` object per
line, the `AgentStreamEvent` shape verbatim. Where `--stream` is the live view and `--log-level
debug` folds the events into the human diagnostics file, the transcript is the **programmatic
substrate**: a full-fidelity record any consumer (a UI, a cost report, an analyzer) can replay
**offline without re-running the agent**, independent of log level or rotation. Because the events
are already tool-neutral, the artifact is **identical in shape across claude-code / codex / droid**
and future harnesses — that's the point. It is **uncapped** (never size-rotated — a dropped `usage`
or `tool` line would corrupt an offline cost report), and read back with the exported
`readStreamTranscript(stateDir, runId)`, which Zod-validates each line and **drops** any corrupt one.
Crucially it is **NOT** the replay log: it is observational, so resume stays a pure fold over
`OrchestratorEvent` only, and a transcript write failure degrades to "no transcript", never a changed
outcome (fail-closed). `--stream-file <path>` overrides the location. Opt-in; off by default.

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

Subscribe to the live stream programmatically with `composeDeps({ onStreamEvent })`, or have goaly
persist it and read it back offline — the same canonical `AgentStreamEvent` shape across every
harness:

```ts
import { composeDeps, drive, readStreamTranscript } from 'goaly';

const deps = composeDeps(config, { /* … */ runId, streamTranscript: true });
await drive(deps, config, runId);
const stream = await readStreamTranscript('.goaly', runId); // [{ phase, kind, …, ts }] | null
```

## License

[MIT](LICENSE) © krimvp
