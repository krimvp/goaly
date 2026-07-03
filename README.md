# goaly

[![CI](https://github.com/krimvp/goaly/actions/workflows/ci.yml/badge.svg)](https://github.com/krimvp/goaly/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/goaly.svg)](https://www.npmjs.com/package/goaly)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**🌐 [Interactive overview →](https://krimvp.github.io/goaly/)** — the landing page (`docs/`) is a
high-level tour: what this is, how the loop works, and what's possible, with interactive diagrams. It
links back here and to [`ARCHITECTURE.md`](ARCHITECTURE.md) / [`docs/adding-a-harness.md`](docs/adding-a-harness.md)
for the depth.

A **harness-agnostic goal-orchestration layer**: run a coding agent repeatedly until a goal is
*verifiably* achieved, with a deterministic thin layer in control and a [**frozen**](#g-frozen) success
criterion the agent can't weaken mid-loop.

> The [anti-reward-hacking](#g-reward-hacking) core: "until the goal is achieved" must not collapse into "until the
> agent weakens its own test." goaly compiles the success contract **once**, freezes it, and
> requires [**two independent keys**](#g-two-keys) — a frozen verifier *and* an independent approver — before
> declaring a run DONE.

See [`DESIGN.md`](DESIGN.md) (what & why), [`ARCHITECTURE.md`](ARCHITECTURE.md) (how),
[`CONTEXT.md`](CONTEXT.md) (glossary), and [`docs/adr/`](docs/adr) (decisions).

> **New to the vocabulary?** Terms like *[fail-closed](#g-fail-closed)*, *[fail-open](#g-fail-open)*,
> *[two keys](#g-two-keys)*, *[reward-hacking](#g-reward-hacking)*, and *[frozen contract](#g-frozen)*
> are all defined in plain language — with links to read more — in the **[Glossary](#appendix-glossary)**
> at the end. The first use of each below also links straight to its entry.

## Quick start

```bash
npm i -g goaly                 # or, from a clone: make install

# Just give it a goal — the agent writes the check, runs, and verifies (Claude + --generate,
# all defaults). A human approves the frozen contract once at Seal:
goaly "add a /health endpoint returning 200"

# Run hands-off (-d auto-accepts the still-frozen, still-logged contract):
goaly -d "add a /health endpoint returning 200"

# Or point at a check you already have:
goaly run --goal "make the parser handle empty input" --verify-cmd "npm test"
```

Exit codes: `0` DONE · `1` FAILED/ABORTED · `2` usage error · `130` interrupted (Ctrl-C — the run
stays resumable). See [Usage](#usage) for every flag.

## Contents

- [How it works](#how-it-works) — the loop, the two gates, the verify ladder
- [Install](#install) · [Usage](#usage) — every flag and mode
- [Phased goals](#phased-goals---phased) · [Worktrees](#worktrees---worktree) · [Sandboxing](#sandboxing) · [Per-run spend report](#per-run-spend-report) — going further
- [Reliability](#reliability-preflight-retries-interrupts-crash-safety) — preflight, retries, Ctrl-C, crash-safety
- [Operator control](#watching-steering--extending-a-run-operator-control) — watch live, steer with `--note`, extend caps on `--resume`
- [Web UI](#web-ui-goaly-ui) — `goaly ui`: runs, live feeds, and worktrees in the browser
- [Develop](#develop) · [Embedding](#embedding) — contributing and the library API
- [Glossary](#appendix-glossary) — every project-specific term & idiom, plain-language

## How it works

The loop has exactly **two named gates** and **three bounded retry edges** — nothing else loops:

```
PHASE 1 · SEAL the bar (once, before the loop)

   🔁 COMPILE_FAILED → re-author with the error            🔁 "revise" → re-author
      (≤ --max-compile-retries, default 2)                    from the human's note
                   └──────────────┐            ┌───────────── (≤ --max-seal-revisions, default 10)
                                  ▼            ▼
                         COMPILE_VERIFIER ──► SEAL ──── reject ───► ABORTED
                                               │ approve → freeze the contract
                                               ▼
                    SETUP + PRE-FLIGHT (once) ──┬─ SETUP_FAILED ────► FAILED
                                                └─ CONTRACT_UNSOUND ─► FAILED
                                               │ ready / honest red
                                               ▼
PHASE 2 · the loop (🔁 ≤ --max-iterations, default 10; bails early on STUCK)
                                               ▼
            RUN_AGENT ───► VERIFIER LADDER ──pass──► SIGN-OFF ──no veto──► DONE
                ▲                │ fail                  │ veto
                └─── feedback ── DECIDE ◄────────────────┘
                                   │ stuck / budget / out of iterations
                                   ▼
                                 FAILED

🔁 = the ONLY places goaly loops back, each explicitly bounded:
   COMPILE_FAILED   re-author the verification, the error fed back   ≤ --max-compile-retries (2)
   SEAL "revise"    re-author the contract from a human note         ≤ --max-seal-revisions (10)
   red iteration    re-run the agent with the FAIL / veto as feedback ≤ --max-iterations (10), or STUCK
```

- **SEAL** locks the bar in once and freezes it (the `contractHash` never changes again).
- **SIGN-OFF** runs *only* on a green ladder and is **veto-only** — it can block a green from becoming
  DONE, never promote a red. It is the second of the **two keys** for DONE.

- The **control flow has zero LLM calls.** A pure reducer `step(state, event) -> [state, Command[]]`
  owns all policy; an imperative Driver performs the effects it requests. Everything stochastic
  (running the agent, judging, approving) hides behind boolean/value interfaces at four real seams.
- The [**verifier ladder**](#g-ladder) runs cheapest-and-hardest-to-game first: deterministic checks (exit codes,
  tests) before any LLM judge, short-circuiting on the first deterministic fail. A rung that errors is
  [**fail-closed**](#g-fail-closed) — a malformed grader is never a green. When goaly **authored** the verification
  (`--generate`), an integrity **guard rung runs first** and fails closed if any generated test file
  was changed since the contract froze — the worker can't quietly rewrite the bar the frozen command
  measures.
- **Artifact-running smoke rung (`--smoke`).** For goals whose correctness only shows at *runtime* — a
  web UI, a server endpoint, a CLI's actual behavior — add `--smoke "<cmd>"`: an **extra deterministic
  rung** (a second `--verify-cmd`) that *executes* the built artifact and exits non-zero on failure.
  It's runtime-agnostic — the command can be a headless-browser script, a server probe, a CLI smoke,
  anything — so goaly bakes in no browser/ecosystem dependency. It runs after `--verify-cmd` but before
  the judge, turning "it actually runs" from a diff-reading judge's guess into an ungameable key, and
  is frozen into the contract like any rung. (Plain `--verify-cmd "npm test && node smoke.mjs"` does
  the same; `--smoke` just gives the runtime check its own labeled rung with its own failure feedback.)
- **Seal is the human's say over the bar — a full review station.** Before the loop you can
  **approve** the frozen contract, **reject** it (abort), give **free-text feedback to revise** it
  (goaly re-authors and re-presents, bounded by `--max-seal-revisions`, default 10; `0` disables
  revision) — or **edit the artifacts yourself**. Answer **`e` (edited)** after changing the
  authored verification files in your own editor: goaly re-reads them from disk, re-pins their
  content hashes, **re-freezes** the contract (a new, logged `contractHash`) and re-presents it —
  without this, a manual edit would trip the anti-tamper guard on iteration 1. A refreeze costs no
  LLM tokens and never consumes the revise cap; iterate until you're happy, and only the contract
  you finally approve enters the loop ([ADR 0016](docs/adr/0016-seal-review-station.md)). The
  [web UI](#web-ui-goaly-ui) goes further: it renders the authored files' **contents**, lets you
  edit them (and the setup/verify commands and rubric) **in the browser**, and re-freezes on click.
  `--autonomous` skips this pause entirely, never the freeze.
- **Required-tools preflight, before anything else.** Every contract carries a frozen **`requiredTools`**
  manifest — the external programs the verification assumes already exist on PATH (`cargo`, `python`,
  `pytest`, `go`, `node`…). Under `--generate` the compiler authors it; on `--verify-cmd` it's derived
  heuristically from the command. Before the loop, goaly probes each. A missing tool, by **default**, is
  **handed to the agent to install**: goaly skips its own setup (which would only fail on the absent
  toolchain) and threads the missing tools — plus the setup command — into the first prompt as a
  bootstrap step, so the experience stays seamless (run `goaly "…in rust…"` on a box without rust and the
  agent installs it). `--install-missing-tools false` opts out: a missing tool is then a typed,
  fail-closed **`TOOLS_MISSING`** abort with guidance, before any token is spent. So that an
  agent-installed toolchain is actually visible to the verifier, goaly extends the verify/setup PATH with the standard
  per-user install dirs (`~/.cargo/bin`, `~/.local/bin`, `~/go/bin`, …). The manifest is shown at SEAL
  and part of the `contractHash`.
- **One-time setup + pre-flight, before the first agent turn.** After SEAL and before iteration 1,
  goaly runs a single **setup** command to prepare the tree (install deps, etc.) and then **pre-flights**
  the frozen deterministic checks once. Under `--generate` the compiler *authors* the setup command for
  you (e.g. `npm ci`) — delegated like the contract itself; `--setup-cmd` overrides it and `--no-setup`
  disables it. **Setup failure is provenance-aware (from-scratch-aware).** A failing **user `--setup-cmd`**
  is a typed, fail-closed **`SETUP_FAILED`** — the worker never starts on a broken tree (which is what
  drives an agent to hand-roll brittle workarounds for missing deps); an exit `127` (a toolchain like
  `rustup`/`cargo`/`go` simply isn't installed here, which goaly can't bootstrap for you) adds an
  actionable hint pointing at `--setup-cmd` / `--no-setup`. A failing **compiler-authored** setup, by
  contrast, is **best-effort**: on a from-scratch `--generate` build an authored `go mod download` / `npm
  ci` presupposes scaffolding (a `go.mod`/`package.json`) the agent hasn't written yet, so a non-zero exit
  is *expected*, not fatal — goaly logs it loudly, threads a recovery note into the first prompt, and
  proceeds to the loop. The
  pre-flight then proves the authored verification can actually *run*: when a deterministic check fails, a
  single **language-agnostic** classification (one read-only LLM call) decides whether the frozen
  verification is **broken** (a defect *inside the frozen verification files* — it can't
  compile/collect/run, which the agent can never fix) → a typed **`CONTRACT_UNSOUND`** abort **before any
  worker token is spent**, vs. an honest red (the implementation — or scaffolding the implementation must
  create, like a dependency manifest — is simply missing) → proceed to the loop. (Reading the failure the
  way a human would is what keeps this generic — pytest, `cargo`, `go test` and tsc all encode "couldn't
  run" vs "ran and failed" differently, so no exit-code/regex rule could be both correct and
  cross-language.) On a **from-scratch tree** (no implementation source yet — only docs + the authored
  verification) the bar is red *by definition* until the agent scaffolds, so a red there is almost always
  an honest "implementation missing"; the rung is still **run and classified**, but the from-scratch
  signal is threaded into the classifier so an honest red proceeds while a frozen verifier that *itself*
  can't run/compile (which the agent can never fix) is still caught as `CONTRACT_UNSOUND` up front. The
  **green mirror** is caught the same way: an authored verifier that *already passes* on a from-scratch
  tree means the bar isn't actually testing the goal — the compiler authored the **solution itself** into
  the frozen set (which the anti-tamper guard then pins, deadlocking the worker), or the bar is vacuous —
  so a second read-only call, asked to rule in "the goal is genuinely already satisfied," classifies a
  confident `CONTRACT_UNSOUND` before any worker token. Both directions [fail *open*](#g-fail-open) to proceed on any
  uncertainty (no LLM, an error, or a "sound" verdict all proceed; a genuinely broken frozen verifier is
  also caught at runtime by repeat-failure stuck detection) — so a not-yet-created file or a false signal
  never blocks a legitimate run. The compiler is also instructed up front that authored files are
  **verification only** (never the implementation) and the bar must be **red on an empty tree**, heading
  the deadlock off at authoring time. The setup command is frozen into the contract
  (shown at SEAL) so it can't drift. A plain `--verify-cmd` run with no authored files skips the check.
- **Two keys for DONE:** the frozen verifier passes *and* the independent approver (Sign-off, veto-only)
  doesn't veto.
- **Best-of-N parallel worker (`--candidates N`, default 1).** Each iteration can fan out **N independent
  worker attempts in isolated git worktrees** off the current baseline tree, score each against the
  **same frozen verifier ladder**, keep the **best** candidate's tree, and advance. The whole tournament
  is **Driver-side**: the pure reducer sees exactly **one** winning agent run and never learns N existed,
  so the state machine is untouched and `--candidates 1` is byte-for-byte the classic single attempt. The
  **scorer is the frozen ladder itself** (no second scorer that could disagree): candidates are ranked by
  **how far each got *up* that ladder** — the **furthest up the ladder wins** (an all-pass candidate, the
  maximal depth, beats every partial), so two *failing* attempts are no longer indistinguishable. This
  graded depth is read straight off the ladder verdict at **zero extra cost** (the ladder already
  short-circuits at the first failing rung, so "rungs passed" is just where it stopped). Ties on depth
  break to lower token cost, then lowest index; all-N-fail is a normal red iteration (the furthest-then-
  cheapest failing candidate) that loops as usual; a crashed/timed-out candidate scores a hard red (depth
  0) and can't win. Each candidate completes write-ahead, so `--resume` re-runs only the not-yet-logged
  ones and re-selects deterministically — or, with `--resume-best-of-incomplete collapse`, collapses to the
  best already-logged candidate and re-runs nothing. Needs a committed HEAD (it refuses to start fail-closed
  on an unborn branch). See [Best-of-N parallel worker](#best-of-n-parallel-worker---candidates).
- **Compile is resilient, not one-shot.** A `COMPILE_FAILED` (a correctable authoring mistake — bad
  path, transient parse miss) re-authors the verification with the error fed back as guidance, up to
  `--max-compile-retries` (default 2; `0` disables), before the run fails — so one bad compile output
  no longer discards a valid plan. Exhausting the budget is still a typed `FAILED`, never a skipped
  check. (Mirrors the Seal revise loop; the reducer stays pure.)
- [**Stuck detection**](#g-stuck) bails before `maxIterations` with a reason: no-diff, repeat-failure (volatile
  tokens like timestamps / PIDs / temp paths are normalized away first, so a noisy-but-identical
  failure still trips it — keyed on the **verifier-failure signature, independent of the diff hash**, so
  a worker that churns unrelated files every turn while the same error repeats is still caught as a typed
  **`STUCK_REPEATED_FAILURE`** that *names the repeated signature*), short-period oscillation (period-N,
  not just A,B,A,B), **harness-crash** (the agent CLI exited abnormally N times in a row — a typed
  **`STUCK_HARNESS_CRASH`** that surfaces the harness's own error and points at the environment, so a
  crashing CLI is diagnosed as such instead of looping on the stale verifier red an unfinished turn
  leaves behind), **contract-unevaluable** (the frozen ladder could not be *evaluated* N times in a
  row — the verify command **timed out** or could not be **started**, or the LLM judge errored /
  overflowed — a typed **`CONTRACT_UNEVALUABLE`** that distinguishes a verification-**environment**
  failure from a real red: it says the tree may be correct-but-**unverified** instead of letting a
  misleading no-diff/repeat abort blame and discard possibly-correct work — still fail-closed, never a
  green. It keys only on facts goaly *owns* — never heuristic exit-code/error-string guessing — and is
  prevented at the source: the compiler authors **offline** verify commands [install once in `setup`,
  invoke the local binary], and a missing toolchain is caught **before** the loop by the
  `requiredTools` pre-flight), and budget. Tune it
  with `--stuck-no-diff`, `--stuck-repeat-threshold`, `--stuck-oscillation`, `--stuck-crash-threshold`,
  `--stuck-unevaluable-threshold`.
  **By default** goaly already keeps a conservative set of ephemeral verifier artifacts out of the tree
  hash — Python bytecode/`__pycache__` and the pytest/mypy/ruff caches, plus JS `.nyc_output`/`htmlcov`
  (`*.pyc`, `*__pycache__*`, `*.pytest_cache*`, `*.mypy_cache*`, `*.ruff_cache*`, `*.nyc_output*`,
  `*htmlcov*`) — so a verify command that regenerates them between iterations can't make a no-op agent
  turn look like it changed something. The defaults are deliberately narrow: they never touch build
  output (`build/`, `dist/`, `target/` — a build goal's deliverable must stay visible) and avoid the
  bare word `coverage` (which would over-match a real `coverage_report.py`). Use `--diff-ignore
  "<p1,p2,…>"` to add your own artifact paths on top (deduped with the defaults); each is a git
  pathspec where `*` spans `/`. A no-diff iteration is **excused**
  when the agent never had a fair chance to act — the previous turn **timed out**, **crashed**, or was
  **truncated** (it hit its turn/wall-clock cap mid-work), or the ladder is green and a **fresh Sign-off
  veto** is the only blocker — so a correct, actionable critique (or a run that simply ran out of room)
  isn't thrown away before the worker gets one real turn to make progress. A perpetually
  truncated-with-no-diff run still terminates — at `--max-iterations` / budget, the correct backstop,
  rather than a premature no-diff abort on the first capped iteration.
- **Diff baseline** — the worker's diff (what the Sign-off approver reviews) is computed against `HEAD`
  by default, but `--baseline <ref>` points it at any git ref/SHA instead. Chain a multi-step build by
  pointing each run at where the last one finished, so every run reviews only its own delta —
  **without `git commit`-ing onto the user's branch**. The baseline only changes what `diff()` is
  computed *against*; the working-tree hash that drives stuck-detection is unaffected. (goaly can also
  advance the baseline internally via a private tree snapshot — no commit, no `HEAD`/branch/index
  movement — recorded so `--resume` reconstructs it.)
- **Per-iteration delta diffs** (`--delta-verify`, default off) — keep the LLM **judge's** prompt flat
  across a long run. goaly takes an internal checkpoint after each continuation iteration, so the next
  iteration's judge reviews only *that iteration's* delta instead of the whole cumulative diff. The
  **DONE decision stays cumulative** — the deterministic rungs always run on the **full working tree**
  (the ungameable key), and the terminal **Sign-off approver reviews the diff against the run's start
  baseline** — so a change *smeared* across iterations (no single delta looks bad) is still caught. If
  a checkpoint can't be taken it falls back to the full diff (never an empty one). It **composes with
  `--phased`**: per-iteration deltas feed the judge *within* a phase, while the approver stays pinned
  to each *phase's* start (so it reviews that phase's whole cumulative diff) — and `--phased` is still
  the right tool to bound the cumulative diff for a huge monolithic change.
- [**Write-ahead run log**](#g-write-ahead) under `.goaly/<runId>/` makes every run replayable, **resumable**, and
  **inspectable** after the fact (`goaly runs list` / `goaly runs show`).
- **Per-run spend report:** every run ends with a token breakdown by layer — the **harness** vs. the
  **LLM steps** (compiler / judge / approver) — and against any `--budget-tokens` cap. Totals count
  **every category, cache included** (input + output + cache-read + cache-write), with a per-category
  split surfaced — so cache-heavy providers like Claude aren't undercounted. It's folded from the run
  log, so `--resume` and `goaly runs show` rebuild the same numbers; a harness/provider that reports
  no usage degrades that spend to **"unknown" loudly** (a warning + an `unknown` mark on the budget)
  so the token cap is never silently read as zero — wall-clock stays the backstop. Optional USD cost
  via `--cost-table` (flat **or per-category** rates); **tokens-only by default**.

## Phased goals (`--phased`)

A big goal produces a big diff — costly to judge every iteration, and easy to half-finish. `--phased`
turns one goal into a **frozen, ordered plan of small sub-goals**, runs each as its *own* frozen,
two-key contract, and finishes with a **cumulative acceptance** contract on the **original** goal — so
decomposition can't green a goal whose parts pass but whole doesn't. It's "a frozen plan of frozen
contracts": the same freeze + two-key guarantees, one level up.

```
PLAN ──► plan SEAL ──reject──► ABORTED        🔁 "revise" → re-plan from the human's note
   │ approve → freeze the plan (planHash)         (≤ --max-plan-revisions, default 10)
   ▼
for each sub-goal phase:  COMPILE_VERIFIER ─► SEAL ─► 🔁 loop (RUN_AGENT ▸ ladder ▸ SIGN-OFF ▸ DECIDE)
   │ both keys → internal CHECKPOINT (scopes the next phase's diff) ──► next phase
   ▼
ACCEPT  (a cumulative contract on the ORIGINAL goal) ──both keys──► DONE   ──else──► FAILED
```

- **Planner seam (read-only, like the compiler).** An LLM authors the ordered `phases: SubGoal[]`
  (`--planner-model` picks its model), or `--plan-file <p>` supplies a structured plan
  (`{ "phases": [{ "goal", "intent"?, "rubric"? }] }`). The output is parsed fail-closed and **frozen**
  (`planHash`, logged loudly); a planner error / bad plan / a plan longer than `--max-phases` (default
  10) is a typed **`PLAN_FAILED`**, never a skipped decomposition.
- **The plan is frozen too.** No transition rewrites it. Re-planning is *only* the bounded, human-gated
  **plan Seal** revise path (mirrors `--max-seal-revisions`) — never an automatic "make phase 3 easier".
- **Each phase is a normal run.** It reuses the compiler, ladder, Sign-off and DECIDE unchanged, scoped
  to its sub-goal (authored with `--generate`). Between phases goaly takes an **internal checkpoint**
  (the same private tree-snapshot as `--baseline`, no commit) so each phase's diff stays small.
- **Acceptance is the whole-run key.** The final phase verifies the **original** goal end-to-end —
  reusing your original verification (`--verify-cmd` becomes the cumulative deterministic bar, or
  `--generate` authors cumulative acceptance). The whole run is **DONE only when acceptance passes both
  keys**; a phase that can't reach DONE within its budget fails the whole run (no silent skip).
- **`--autonomous` moves the pauses, never the freezes** — it auto-accepts the plan **and** each phase
  contract, but still freezes + logs both. **`--budget-tokens` is the whole-run total** (summed across
  every phase). `--resume` re-enters mid-plan without repeating completed phases. `goaly runs show`
  prints the frozen plan and stamps each iteration with its phase.

## Best-of-N parallel worker (`--candidates`)

Some iterations are a coin-flip — one attempt half-finishes, another nails it. `--candidates N` (alias
`--best-of N`, default `1`) runs **N independent worker attempts every iteration** and keeps the best,
without ever weakening the bar or letting the reducer learn N existed.

```
each iteration, with --candidates N:
   ┌─ worktree 1 (off the baseline tree) ─► RUN_AGENT ─► score the FROZEN ladder ─┐
   ├─ worktree 2 ───────────────────────► RUN_AGENT ─► score the FROZEN ladder ──┤  tournament
   └─ … worktree N ─────────────────────► RUN_AGENT ─► score the FROZEN ladder ──┘  (Driver-side)
                                              │ pick the BEST candidate
                                              ▼ promote its tree → ONE AGENT_RAN → the loop continues
```

- **The tournament is Driver-side; the reducer is untouched.** The pure state machine emits one
  `RUN_AGENT_BEST_OF` command (decided purely from config, still exactly one command per state) and the
  Driver feeds back the **same single `AGENT_RAN`** it always did — for the **winner**. So `--candidates
  1` is byte-for-byte the classic single attempt, and the loop, stuck detection, and the two-key DONE
  see exactly one run per iteration (one `diffHash`).
- **The scorer is the frozen ladder — no second scorer.** Candidates are ranked by the **same**
  `makeLadder(contract)` the loop already uses, and graded by **how far each got up that ladder**: the
  candidate that climbed **furthest up the ladder wins** (an all-pass candidate, whose depth equals the
  rung count, beats every partial). This *subsumes* the old boolean pass — a real pass is just maximal
  depth — so it's still one frozen scorer, and it **distinguishes two failing attempts** the boolean
  couldn't. The depth is read straight off the ladder verdict at **zero extra execution cost**: the ladder
  already **short-circuits at the first failing rung**, so "rungs passed" is just the position where it
  stopped (no second pass, no re-grading). Ties on depth break to **lower token cost**, then **lowest
  candidate index** (stable). If **all N fail**, the furthest-then-cheapest failing candidate wins and the
  iteration is a **normal red** that loops through DECIDE unchanged. A candidate that **crashes / times
  out** scores a hard red (depth 0) and can't win on merit.
- **Isolated worktrees, promoted without a commit.** Each candidate runs in its own linked **git
  worktree** off the current baseline tree, so the N attempts never see each other's edits; the winning
  tree is promoted into the canonical workspace (no user-visible commit, `HEAD` untouched), and **every**
  worktree is torn down on every exit path. So the canonical loop still records **one** `diffHash` per
  iteration — no-diff / oscillation / repeat-failure keep their meaning.
- **Write-ahead + resume.** Each candidate is logged the moment it completes (`CANDIDATE_RAN`, now also
  carrying its ladder depth so resume re-selects by the same graded key), then the selection
  (`CANDIDATE_SELECTED`) before the tree is promoted. On `--resume` a crash mid-fan-out re-runs **only the
  not-yet-logged candidates** (completed ones are read back from their markers, never re-run) and
  re-selects deterministically — no tree is double-applied. These markers are Driver-side only and are
  **never** fed to the reducer (replay skips them, exactly like the internal checkpoint marker).
- **`--resume-best-of-incomplete rerun|collapse` — determinism vs. the best winner.** When a `--resume`
  lands on a fan-out that crashed mid-flight (some `CANDIDATE_RAN` markers, no `CANDIDATE_SELECTED`), you
  choose how to finish it. **`rerun`** (the default) re-runs the not-yet-logged indices then selects over
  the **full** set — maximally faithful to the original N-way fan-out, at the cost of more agent calls.
  **`collapse`** selects from **only the already-logged** candidates and re-runs **nothing** — cheaper and
  fully deterministic, considering a smaller set. Either way the winner still flows through the canonical
  ladder + Sign-off (collapse changes only *which* candidates are considered on resume, never the two-key
  gate). Fail-closed: if **zero** candidates were logged, `collapse` still runs the full set (you can't
  collapse to an empty set — never a green-from-nothing).
- **Cost scales with K, and K is capped.** Running N attempts every iteration multiplies the
  per-iteration **worker** spend up to **~N×** (the K attempts run concurrently). That spend is metered
  and still governed by **`--budget-tokens`** (the whole-run cap), so a budget bounds total spend
  regardless of K. Because each candidate is a full concurrent worker run **plus** a git worktree, an
  unbounded K is a resource-exhaustion footgun: **K is capped at 16** — a `--candidates` / `--best-of`
  value above 16 is a **fail-closed** usage error. `--candidates 1` (the default) and any `2..16` are
  unchanged.
- **Composes with everything.** **`--phased`** sub-goals inherit `--candidates` (each phase runs its own
  tournament); **`--delta-verify`** is unaffected (the judge still reviews the winner's delta);
  **`--sandbox`** jails each of the N execs through the same launcher. Best-of-N needs a **committed
  HEAD** — `git worktree` can't check out an unborn tree, so a `--candidates > 1` run on a HEAD-less repo
  **refuses to start** (fail-closed) with a clear message; make an initial commit or use `--candidates 1`.

## Worktrees (`--worktree`)

Sometimes the run shouldn't touch your working tree at all — you keep editing while goaly builds, or
you want several runs going at once without them stepping on each other. `goaly` manages light,
**named, persistent git worktrees** for exactly that: `--worktree <name>` re-roots the **entire run**
at an isolated checkout of the repo, and the work merges back with plain git.

```bash
goaly "add a /health endpoint" --worktree health      # create (or reuse) + run inside it
goaly "try the other approach" --worktree             # bare flag: auto-named (wt-<8 hex>)

goaly worktree create feature-x --base main           # create one up front (default base: HEAD)
goaly worktree list                                   # NAME / BRANCH / HEAD / DIRTY / RUNS / PATH
goaly worktree remove feature-x                       # refuses if dirty; branch kept for merge-back
goaly worktree remove feature-x --force --delete-branch
```

- **Where they live.** Each worktree is `git worktree add`-ed at `.goaly/worktrees/<name>` on branch
  **`goaly/<name>`** — inside the already git-ignored `.goaly` state dir, so nothing shows in
  `git status` and everything goaly manages sits in one place. (Corollary: `git clean -dfx` on the
  main tree deletes the checkouts — committed work survives on the `goaly/<name>` branch;
  uncommitted work does not. `worktree list` flags such orphaned registrations as `PRUNABLE`.)
- **The whole run is re-rooted.** One early rewrite points the run's workspace at the worktree, so
  the run log (`<worktree>/.goaly/<runId>/`), the run lock, the agent's cwd, the verifier, and the
  diff scope all live there — the main tree is never read or written by the run. Resume it with the
  **same** `--worktree <name>` (the log lives inside the worktree); the startup banner prints the
  exact command.
- **Merge-back is plain git — no magic.** Runs never commit, so a finished worktree run leaves its
  changes uncommitted on `goaly/<name>`; the end-of-run hint shows the two steps
  (`git -C <worktree> add -A && git -C <worktree> commit …`, then `git merge goaly/<name>`).
  Removing a worktree **keeps the branch by default** for exactly this reason; `--delete-branch`
  opts out (an unmerged branch then needs `--force`).
- **Fail-closed safety.** Creating over an existing worktree, an unresolvable `--base`, or an
  invalid name (names are one safe path/branch component: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, no
  `..`) all refuse with a clear message. `remove` refuses while a **live goaly run** is inside
  (always — even `--force`) and refuses a dirty tree without `--force`, naming how to keep the work.
- **Distinct from best-of-N.** `--candidates` makes **ephemeral, detached** worktrees for one
  iteration's tournament and tears them down; `--worktree` is the **persistent, named** counterpart
  a whole run (and you) can live in. They compose: a `--worktree` run with `--candidates 3` runs its
  tournament off the worktree's tree.

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
- **A "build-and-use" goal can't be greened by a parallel reimplementation.** When the goal is to
  *build a reusable artifact (a module/engine/library/API) **and use it***, a worker can satisfy a
  naive numeric/behavioral bar by re-deriving the logic straight inside the higher-level solvers and
  **never calling the artifact** — both keys pass while the thing the goal is about is dead code. An
  **independent shape classifier** (a separate, neutral LLM call over the *goal only*, so an authoring
  model can't opt itself out) decides whether the goal is build-and-use; when it is, the compiler must
  author a **runtime usage assertion** — a spy/call-through check that instruments the artifact's public
  entry points and asserts the verified result is produced *through* them (a reimplementation records
  zero calls and **fails**), embedded in a frozen test file. A `--generate` contract that lacks that
  assertion (or declares target symbols that aren't actually spied in a frozen file) is refused at
  compile (`COMPILE_FAILED`) and re-authored *with* the assertion by the bounded compile-retry loop.
  The classifier is **fail-open** (any error/uncertainty → treated as not-build-and-use, so it never
  blocks a legitimate run); it only bites on a confident build-and-use verdict. This is why the
  "no static `grep`/source-text check as the bar" steering carves out **runtime** usage assertions:
  they *run* the code, so they aren't a gameable source scan.
- **Independence is checked, not assumed.** goaly warns loudly when the "two independent keys" collapse
  onto one model (e.g. a bare `--model X`, which would make the approver share the worker's/judge's
  blind spots); pass `--approver-model` (or a different `--llm-provider`) to separate them. Under
  **`--generate --autonomous`** specifically, the warning **escalates** when the coding agent, the judge
  rung, *and* the Sign-off approver all resolve to one model: that is the self-author + self-judge case,
  where the model writes a bar it then grades itself against with no human in the loop — the most
  deadlock-prone setup (it can stall authoring a bar it cannot satisfy or recognize as satisfied). For
  autonomous `--generate`, prefer `--approver-model` (and/or `--judge-model`) on a **different
  model/provider** so the second key is a genuinely independent skeptic.
- **The second key can be a multi-vote panel.** `--approver-quorum N` (default `1`) runs the Sign-off
  approver as an **N-reviewer panel** behind the unchanged seam — the reducer and driver still see
  exactly one verdict. The panel **greens only on a strict supermajority** of no-veto votes
  (`noVetoCount * 2 > N`) *and* only when **every** counted reviewer parsed; any reviewer that throws,
  times out, or returns unparseable output counts as a **veto**, and zero parseable reviewers is a
  veto — so a panel is **never weaker** than the single veto. At `N > 1` the reviewers sample at a
  small diversity temperature (`--approver-diversity-temp`, default `0.5`) and are cycled through a
  small default lens taxonomy (correctness / security / goal-actually-met / prompt-injection) for
  perspective spread; `N = 1` is **byte-for-byte** the historical single call (temperature 0, no
  lens). A quorum on **one** model is **variance reduction, not perspective independence** — goaly
  warns when a multi-vote panel shares a model with the judge or the worker; pair `--approver-quorum`
  with `--approver-model` on a different model/provider for a genuinely independent second key.
  **Cost:** a panel multiplies approver LLM spend **~quorum×**; that spend is metered and counts
  against **`--budget-tokens`**. A **small panel (≈3–5 reviewers)** is the recommended practical range;
  `--approver-quorum 1` (the default) is **cost-neutral**.
- **The lens taxonomy is overridable.** `--approver-lenses l1,l2,…` replaces the built-in lens taxonomy
  with an **operator-supplied** comma-separated list, cycled across reviewers when `quorum > 1`
  (ignored at quorum 1). Each lens biases one reviewer toward a failure mode and rides the approver
  **system** prompt — it is operator config, **not** the worker-controlled diff (which stays fenced as
  untrusted data). Absent ⇒ the default correctness / security / goal-actually-met / prompt-injection
  lenses, byte-for-byte unchanged.
- **The panel can run genuinely independent models.** `--approver-models m1,m2,…` gives the Sign-off
  panel **real per-reviewer independence**: reviewer *i* runs model *i* (cycled when the quorum
  exceeds the count), each paired with lens *i*, every one an `'approve'`-metered provider on the same
  `--llm-provider` — so **all** panel spend still attributes to the approver layer (no new spend
  category). With `--approver-models` the quorum **defaults to the model count** unless you set
  `--approver-quorum` explicitly. Because **≥2 distinct models** have uncorrelated blind spots, that
  panel **is** the independent second key (not just variance reduction), so goaly **suppresses** the
  variance-reduction / collapse warnings; a one-model list (or all-identical entries) falls back to the
  single-model panel and the warnings stay. Use `--approver-model` (singular) for a single distinct
  model; `--approver-models` (plural) for a per-reviewer panel.
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
| `--sandbox[=<mode>]` | `none` (default, no isolation) · `auto` (best available: `bwrap`, then `firejail`, on Linux, else `container`) · `bwrap` (Linux bubblewrap) · `firejail` (Linux firejail, the fallback when bwrap is absent) · `container` (a `docker`/`podman run --rm`, portable, covers macOS). Bare `--sandbox` means `--sandbox=auto`. |
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

Requires Node ≥ 20 and `git`. The default adapters shell out to the `claude` / `codex` / `droid` /
`pi` CLIs; the LLM compile/judge/approve steps use a CLI-backed provider (`claude` by default,
switchable with `--llm-provider`). Pick the model per layer with `--model` / `--llm-model` (see
Usage). [`pi`](https://pi.dev) is provider-agnostic — one CLI over any model from any provider — so
pass `--model` as `"provider/id"` (e.g. `"anthropic/claude-opus-4-8"`, `"ollama/qwen3:8b"`) to pick
provider+model on one flag, or omit it to use pi's own configured default; credentials come from your
env / pi's config, the same boundary `claude` and `codex` already assume.

> **No CLI? Use `--harness goaly-code`.** The `goaly-code` harness needs no coding CLI at all — goaly runs its own
> agent loop directly against any OpenAI-compatible chat-completions endpoint (`--base-url`, plus a
> `--model`; the bearer token is read from `OPENAI_API_KEY`, override with `--llm-api-key-env`). The
> read-only LLM steps can use the same endpoint with `--llm-provider openai`. Only Node ≥ 20's built-in
> `fetch` is required. A local keyless endpoint (e.g. ollama) needs no token.

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
# Easiest: just give it a goal. The LLM authors the verification (--generate) and checks the work,
# using Claude (the claude harness + claude LLM provider) — all defaults, no flags. The goal is
# a positional and `run` is optional. A human approves the frozen contract once at Seal:
goaly "make the parser handle empty input"

# Fully hands-off: -d (alias --defaults) auto-accepts the (still-frozen, still-logged) contract.
# That's its only effect — generate + Claude already apply with no flag:
goaly -d "add a /health endpoint returning 200"

# Point at an existing test command; a human approves the frozen contract once:
goaly run --goal "make the parser handle empty input" --verify-cmd "npm test"

# Let the agent author the verification, and run unattended (contract still frozen + logged loudly).
# Under --generate the compiler also AUTHORS a one-time setup command (e.g. `npm ci`) so the worker
# starts from a populated tree; a deterministic pre-flight then catches an unsound contract before
# spending any worker tokens:
goaly run --goal "add a /health endpoint returning 200" --generate --autonomous

# Override the authored setup (or add one on the --verify-cmd path); --no-setup disables it:
goaly run --goal "..." --verify-cmd "npm test" --setup-cmd "npm ci" --setup-timeout-ms 120000

# Provide a longer, well-specified goal from a file (or stdin), and revise the contract
# interactively at Seal up to 3 times before it sticks:
goaly run --goal-file ./GOAL.md --generate --max-seal-revisions 3
cat ./GOAL.md | goaly run --goal - --generate

# Choose a harness, cap iterations, set a budget, resume a crashed run:
goaly run --goal "..." --verify-cmd "pytest -q" --harness codex --max-iterations 8 \
             --budget-tokens 500000 --workspace ./myrepo
# Resume needs only the run id — the goal (and the rest of the contract) is read from the frozen log:
goaly run --resume run-<id> --workspace ./myrepo

# Follow up on a FINISHED run: a new, re-verified goal that knows what just happened (it seeds the
# new contract's authoring with a compaction of the prior run, and runs in the same workspace):
goaly "now also handle empty input" --from-run run-<id>
# ...keep the agent's working memory too (same harness only): resume the prior session on turn 1:
goaly "now also handle empty input" --from-run run-<id> --inherit-session

# Diff against a baseline instead of HEAD — keep a multi-step build's diff small with no commits:
goaly run --goal "step 2 of the build" --verify-cmd "npm test" --baseline <ref-or-sha>

# Keep the per-iteration judge prompt flat on a long run (DONE stays cumulative-safe):
goaly run --goal "..." --verify-cmd "npm test" --delta-verify

# Best-of-N: run 3 isolated attempts each iteration and keep the one that best passes the frozen
# ladder (needs a committed HEAD; composes with --phased / --delta-verify / --sandbox):
goaly run --goal "..." --verify-cmd "npm test" --candidates 3   # or --best-of 3

# Run in an isolated, named worktree (.goaly/worktrees/health, branch goaly/health) — the main
# tree is never touched; merge back with plain git when it's done:
goaly "add a /health endpoint" --verify-cmd "npm test" --worktree health
goaly worktree list                          # manage them: create / list / remove

# Author verification into test/, give the compiler more self-correction, and loosen no-diff for an
# exploratory build (authored files are auto git-excluded, so your `git status` stays clean):
goaly run --goal "..." --generate --autonomous --verify-dir test \
             --max-compile-retries 3 --stuck-no-diff false

# Pick a model for the harness, and a different model for the LLM steps (judge/approver/compiler):
goaly run --goal "..." --verify-cmd "npm test" --harness claude \
             --model claude-opus-4-8 --llm-model claude-sonnet-4-6

# Run the LLM steps on a different CLI entirely (kept read-only so they never touch the tree):
goaly run --goal "..." --generate --autonomous --harness codex \
             --model gpt-5-codex --llm-provider codex --judge-model o3

# Drive goaly's OWN agent loop against an OpenAI-compatible endpoint — no coding CLI installed:
goaly run --goal "..." --verify-cmd "npm test" --harness goaly-code \
             --base-url https://api.openai.com/v1 --model gpt-5    # reads OPENAI_API_KEY
# ...or a local, keyless endpoint (ollama). The same flag also backs the read-only LLM steps:
goaly run --goal "..." --autonomous --harness goaly-code --llm-provider openai \
             --base-url http://localhost:11434/v1 --model qwen2.5-coder --approver-model llama3.1

# Follow the loop step-by-step, and keep a structured diagnostics file (rotated):
goaly run --goal "..." --verify-cmd "npm test" --log-level debug
goaly run --goal "..." --verify-cmd "npm test" --log-file ./run.log   # or --no-log-file

# Watch the agent's turns live — tool calls, messages, token counts — for the run AND the LLM steps:
goaly run --goal "..." --verify-cmd "npm test" --stream

# Persist that same stream durably for offline replay (.goaly/<runId>/stream.jsonl), any harness:
goaly run --goal "..." --verify-cmd "npm test" --stream-transcript

# Narrate the run in plain language — what "done" means, why each ladder run passed/failed, why it
# ended — with an opt-in, read-only side-LLM explainer (off by default; costs one extra call/checkpoint):
goaly run --goal "..." --verify-cmd "npm test" --explain --explain-model haiku

# Cap how long each step may run (subprocess kill-timeouts, in ms):
goaly run --goal "..." --verify-cmd "npm test" \
             --harness-timeout-ms 900000 --llm-timeout-ms 120000 --verify-timeout-ms 60000

# Build-heavy run: kill the agent only when it STALLS (no stream output for 3 min), not on a hard cap:
goaly run --goal "..." --generate --harness-idle-timeout-ms 180000

# Add a deterministic artifact-running smoke rung — run the built thing, fail on any runtime error:
goaly run --goal "build a /health endpoint" --generate --smoke "node smoke.mjs"

# Phased: decompose a big goal into a frozen plan of small, individually-verified sub-goals, then
# accept cumulatively on the original goal (--verify-cmd npm test is the cumulative acceptance bar):
goaly run --goal-file ./BIG_GOAL.md --verify-cmd "npm test" --phased --autonomous --max-phases 6
# Or supply the plan yourself instead of having the LLM author it:
goaly run --goal-file ./BIG_GOAL.md --generate --phased --plan-file ./plan.json

# Jail the agent AND the verifier in an OS sandbox (refuses to start if no mechanism is present):
goaly run --goal "..." --verify-cmd "npm test" --sandbox            # auto-detect (bwrap / container)
goaly run --goal "..." --verify-cmd "npm test" --sandbox=bwrap --sandbox-net allow   # let npm fetch

# Add an approximate USD cost to the end-of-run spend report (tokens-only without it):
goaly run --goal "..." --verify-cmd "npm test" --cost-table ./prices.json

# With a .goalyrc in the repo (or ~/.goalyrc at home), the repeated wiring lives in the file —
# just pass the goal positionally:
goaly "make the parser handle empty input"

# Inspect past runs (read-only — replays the run log, re-runs nothing):
goaly runs list
goaly runs show run-<id>
goaly runs resume-cmd run-<id>   # print how to continue the run's CLI session (e.g. claude --resume <id>)

# Or in the browser: runs across the workspace AND its worktrees, live SSE feeds, start runs with
# a browser Seal modal, stop/resume, worktree panel:
goaly ui                         # http://127.0.0.1:4180, localhost-only
```

### Config file

So you don't repeat the same wiring on every invocation, `goaly run` reads **default flags from a
JSON config file** in three layers (later overrides earlier):

1. a **home-level `~/.goalyrc`** — your personal defaults across every project — optional,
2. an **implicit `.goalyrc`** discovered in `--workspace` (or the current directory) — optional,
3. an **explicit `--config <path>`** JSON file — when given it **must exist** (fails closed).

Keys mirror the CLI flag names in **kebab-case** (`verify-cmd`, `max-iterations`,
`harness-timeout-ms`). **Any flag passed on the command line overrides the file**, so the full
precedence is:
**CLI flag > `--config` file > `<workspace>/.goalyrc` > `~/.goalyrc` > tool default**.

This is what makes `goaly "my goal"` enough: drop your hands-off preference in `~/.goalyrc` once
and every project inherits it.

```jsonc
// ~/.goalyrc — your personal default: run hands-off everywhere (generate + Claude already apply)
{ "autonomous": true }
```

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
| `--harness-timeout-ms` | the harness (coding-agent) subprocess — hard wall-clock cap | `600000` (10 min) |
| `--harness-idle-timeout-ms` | the harness subprocess — **idle/heartbeat** cap | off |
| `--llm-timeout-ms` | each LLM step — judge / approver / compiler | `600000` (10 min) |
| `--verify-timeout-ms` | the verify command | `600000` (10 min) |

A verify command that exceeds its timeout is SIGKILL'd (whole process group) and reported as a
**fail-closed could-not-evaluate — never a green** (invariant #4). It defaults to the same 10-minute
cap as the other steps so a hanging check (a test awaiting the network, a spawned server that never
exits) can never hang the whole run; raise it for genuinely long verifications. Each value must be a
positive integer number of milliseconds.

**Heavy/parallel `--generate` authoring may need a larger `--llm-timeout-ms`.** The compiler authors
the whole frozen contract in one LLM call; for a large goal — or many runs sharing one endpoint — that
call can exceed the default 10-min step cap and surface as a `COMPILE_FAILED` whose reason says the
authoring call timed out. Re-issuing the same heavy call just times out again (it burns
`--max-compile-retries` on a transient infra limit, not a model mistake), so the fix is to **raise
`--llm-timeout-ms`** (or reduce concurrent load) — goaly appends exactly that hint to a timeout
`COMPILE_FAILED` so the remedy is visible.

**Idle vs wall-clock harness timeout.** The default 10-min wall-clock cap is tuned for small tasks;
real multi-file builds routinely exceed it mid-edit, truncating progressing turns and blinding the
token budget for that turn (it reports `tokensUnknown`). `--harness-idle-timeout-ms N` instead kills
the agent only after **N ms with no stream output** — a turn that is actively editing keeps resetting
the heartbeat and survives, while a genuinely stalled one is still reaped (fail-closed: the loop
always terminates). When both are set, the wall-clock `--harness-timeout-ms` remains the absolute
backstop. Recommended for long, build-heavy runs. **You don't need `--stream`/`--stream-transcript`
for it to work:** the heartbeat re-arms on the agent CLI's stdout, and a CLI left in its buffered
output mode emits nothing until the turn ends — so goaly **auto-enables the CLI's per-turn streaming
whenever an idle timeout is set**, ensuring the heartbeat actually sees progress (a side benefit: the
streamed turn also surfaces token usage the buffered mode omits). Displaying/persisting that stream is
still opt-in via `--stream`/`--stream-transcript`.

### Reliability: preflight, retries, interrupts, crash-safety

goaly is built to **fail closed but not fail eagerly**: a wrong green must be impossible, and a
transient blip must not kill an hours-long run. What that means in practice (all defaults, no flags
needed — [ADR 0011](docs/adr/0011-reliability-hardening.md) records the full policy):

- **Fail-fast preflight (before any spend).** A `run` refuses to start — with the exact fix — when
  the workspace is not a git repository (`git init …`), or the `--harness` / `--llm-provider` CLI is
  not on `PATH` (install/authenticate it, or switch harness). A typo'd `--resume` id and a
  stdin-fed goal without `--autonomous` (which would deadlock the interactive Seal prompt) are also
  caught up front. The `fake` harness skips the CLI probes.
- **Transient failures are absorbed, not terminal.** The OpenAI-compatible transport retries
  429/5xx/network errors with exponential backoff and honors `Retry-After` (capped at 60 s); the
  CLI-backed LLM steps (compiler / judge / approver) retry a non-zero exit or unparseable output
  with bounded backoff; a judge-quorum sample that throws drops **that sample only** (its healthy
  siblings still vote); and a **crashed harness turn is retried once** after a short backoff before
  it counts toward the stuck-crash streak. Timeouts are never retried — the wall-clock cap is the
  run's own guard. Persistent failure still terminates exactly as before: retries absorb blips,
  stuck detection governs walls.
- **Ctrl-C is safe and resumable.** The startup banner prints the run id and resume command up
  front. The first Ctrl-C / SIGTERM stops **between steps**: the in-flight step finishes, its event
  lands write-ahead, and the outcome is a typed `ABORTED` naming `--resume <runId>` (exit `130`). A
  second Ctrl-C exits immediately — after reaping any live child process groups, so an agent CLI
  can never outlive goaly and keep editing or spending.
- **Crash-safety end to end.** Every run-log append is fsync'd write-ahead; a line torn by a crash
  mid-append is tolerated on read and repaired on the next append (write-ahead semantics: that
  transition never happened — resume re-performs the one effect). A per-run **lock file** stops two
  goaly processes from driving the same run (stale locks from dead processes self-heal). goaly-code
  session saves are atomic (`tmp → fsync → rename`). A terminated-but-corrupt log line still fails
  closed — tolerance is only for the torn tail.
- **Budgets survive `--resume`.** The prior token spend is folded out of the log and re-armed
  against `--budget-tokens`, so a run resumed near its cap doesn't restart with a fresh budget.
  (The wall-clock budget deliberately restarts per process — the crash-to-resume gap is idle time,
  not spend.)
- **Terminal outcomes tell you the next step.** A failed/aborted run prints an always-on one-line
  `next:` hint — what `STUCK_*` / `CONTRACT_UNEVALUABLE` / budget / `maxIterations` mean and the
  exact `--resume` / `runs show` command — the zero-cost complement to `--explain`.

### Diff baseline (`--baseline`)

The worker's diff — the text the **Sign-off approver** reviews — is computed against `HEAD` by default.
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
  snapshot is recorded in the run log so `--resume` reconstructs the advanced baseline. The *policy*
  for when to snapshot automatically is `--delta-verify` (below) and `--phased`.

### Per-iteration delta diffs (`--delta-verify`)

Every iteration the LLM **judge** ingests the worker's diff; against the default `HEAD` baseline that
diff grows monotonically across a long run, so the judge's prompt (and cost) balloons even when an
iteration changed very little. `--delta-verify` (default **off**) keeps it flat: after each
*continuation* iteration (a ladder fail or a Sign-off veto that loops back to the agent) goaly takes an
internal checkpoint — the same private tree snapshot as `--baseline`, **no commit** — so the next
iteration's judge reviews only **that iteration's delta**.

The catch is the trust model: shrinking what each iteration sees must not let a change *smeared* across
iterations slip through. The **DONE decision therefore stays cumulative**, backed by two keys that
together cover the whole change:

- the **deterministic rungs** always execute on the **full working tree** (they run commands, not
  diffs — so they ignore the baseline entirely and remain the ungameable cumulative key); **and**
- the terminal **Sign-off approver** is pinned to the run's **start** baseline, so it reviews the
  **entire cumulative diff** — never the shrunken per-iteration delta. A violation that no single delta
  reveals is still visible to the approver (and to the deterministic rungs).

Other guarantees hold: the working-tree hash that drives stuck-detection is unaffected (it never
looks at the baseline); the checkpoints are written to the run log so `--resume` frames the same
deltas; and if a checkpoint can't be taken the iteration **falls back to the full diff** (never an
empty one that would read as "nothing to review"). It **composes with `--phased`**: per-iteration
deltas feed the judge *within* each phase, while the approver baseline advances only at **phase
boundaries** — so each phase's Sign-off reviews that phase's whole cumulative diff, exactly as a
non-delta phased run does. For a huge **monolithic** change, `--phased` remains the way to bound the
cumulative diff the terminal approver ingests, by decomposing the goal into phases each with their own
per-phase approver plus a final cumulative acceptance.

### Per-run spend report

Every run prints a **spend summary** and stores the data in the run log. Token usage is aggregated
**at the Driver** (never the pure reducer) and broken down by layer — the **harness** vs. the **LLM
steps** (compiler, the judge rung, the Sign-off approver) — plus consumption against any
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
its usage is captured; `codex` / `droid` / `pi` providers report usage too (pi via its `--mode json`
`usage` block).

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
`--judge-model` / `--approver-model` / `--compiler-model` (and `--explain-model` for the optional
`--explain` observer) override a single step. Precedence per LLM
step: per-step flag → `--llm-model` → `--model` → the tool's own default. `--llm-provider`
(`claude` default, or `codex` / `droid` / `pi` / `openai`) picks which provider runs those steps —
handy when the harness and the LLM steps should share a model namespace. **`--approver-quorum N`**
(default `1`) turns the Sign-off approver into an N-reviewer panel (see *Two keys for DONE* above),
with **`--approver-diversity-temp T`** (default `0.5`, applied only when `N > 1`) tuning the panel's
sampling spread. **`--approver-models m1,m2,…`** runs that panel across **distinct models** for real
per-reviewer independence (reviewer *i* → model *i*, cycled); with it set the quorum defaults to the
model count, and ≥2 distinct models make the panel a genuinely independent second key.
**`--approver-lenses l1,l2,…`** overrides the panel's default review-lens taxonomy with an
operator-supplied list (cycled across reviewers when `N > 1`, ignored at `N = 1`). All of these
are pure wiring and never enter the frozen contract. Omit them all and every tool uses its own default.

**Harness selection.** `--harness` (`claude` default, or `codex` / `droid` / `pi` / `goaly-code`) picks the
write-role coding agent. `goaly-code` is the first non-CLI harness: goaly drives its own tool-use loop
against an OpenAI-compatible endpoint set by **`--base-url <url>`** (`/chat/completions` is appended),
with the bearer token read from **`--llm-api-key-env <NAME>`** (default `OPENAI_API_KEY`; a keyless
local endpoint like ollama needs none). `--harness goaly-code` requires a resolved `--model`; pair it with
`--llm-provider openai` to run the read-only LLM steps through the same endpoint. Both fail closed
(refuse to start) if the base URL or model is missing.

**`--max-agent-turns N`** caps the `goaly-code` agent loop at *N* model turns per run (default 50). A
run that hits the cap ends as `truncated` — not a failure — and the loop gives it another iteration
(bounded by `--max-iterations` / budget), so a long self-authored contract that eats turns gets more
runway. Raise it to **100–200** for a hard from-scratch task. Only the `goaly-code` harness reads it;
the codec harnesses (`claude` / `codex` / `droid` / `pi`) manage their own turn budgets, so it is a
no-op for them.

At **Seal** (unless `--autonomous`), goaly prints the frozen contract and prompts:

```
Approve, revise with feedback, or reject? [a]pprove / [f]eedback / [r]eject:
```

- `a` / `approve` (or `y`/`yes`) — accept the contract and start the loop.
- `f` / `feedback` — type a free-text note; goaly re-authors the contract from it and re-prompts,
  up to `--max-seal-revisions` times. Empty feedback is treated as a reject.
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
uniform across claude, codex, droid, and pi (codex via its `--json` JSONL and pi via its
`--mode json` JSONL; claude and droid via `--output-format stream-json`). It's **independent of
`--log-level`** (which separately routes
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
are already tool-neutral, the artifact is **identical in shape across claude / codex / droid /
pi** and future harnesses — that's the point. It is **uncapped** (never size-rotated — a dropped `usage`
or `tool` line would corrupt an offline cost report), and read back with the exported
`readStreamTranscript(stateDir, runId)`, which Zod-validates each line and **drops** any corrupt one.
Crucially it is **NOT** the replay log: it is observational, so resume stays a pure fold over
`OrchestratorEvent` only, and a transcript write failure degrades to "no transcript", never a changed
outcome (fail-closed). `--stream-file <path>` overrides the location. Opt-in; off by default.

**Plain-language narration** (`--explain`) is a different layer from streaming. Where `--stream`
surfaces the agent's *raw* turns tool-by-tool, `--explain` turns on a **read-only side-LLM
"observer"** that **synthesizes** what happened, in plain language, at three checkpoints: the
**frozen contract at Seal** ("what does *done* mean for this run, and the agent can't weaken it"),
**each verifier-ladder run** (passed/failed and why, plus what the approver said), and the
**terminal outcome** (why it ended — especially a *stuck* stop: no-diff / repeated-failure /
oscillation / harness-crash / budget). Summaries print to **stderr**, prefixed `[explain] `. It is
**strictly advisory**: it reuses the internal read-only `LlmProvider` seam and can **never**
influence the frozen contract, the verifier ladder, DECIDE, or the two-key DONE — it is an
explainer, not a decision-maker. It is **fail-closed** (an observer error degrades to "no summary",
never a changed outcome), its summaries are **never** written to the run log (resume stays a fold
over `OrchestratorEvent`), and its spend is deliberately **not metered into the run budget** so the
narrator can never starve or perturb the loop. **Off by default** — it costs one extra LLM call per
checkpoint; `--explain-model <m>` selects its model (cascading `--explain-model → --llm-model →
--model`). Embedders can inject their own observer via `composeDeps({ observer })`.

**Telemetry** (`DriverDeps.telemetry`) is the lowest-level observability seam: a synchronous,
fire-and-forget sink (`Telemetry.record(event: TelemetryEvent)`) the main run flow feeds one
datapoint per lifecycle beat — `run_started`, one `lifecycle` event per folded reducer event
(compile → run → verify → sign-off …), and `run_finished` at the terminal outcome. Unlike
`--explain` it makes **no LLM call** and unlike `--stream` it carries **no agent content** — just
tags, state, and the Driver clock — so an embedder can meter phase timings, event counts, or drop
rates cheaply. It is **pure observability**: never fed to the reducer, never written to the run log
(resume stays a fold over `OrchestratorEvent`), and unable to touch the frozen contract or the
two-key DONE. Every call is **guarded**, so a throwing sink degrades to "no telemetry" rather than
crashing a run (fail-closed, invariant #4). Absent ⇒ a no-op sink (off by default).

### Watching, steering & extending a run (operator control)

You are never locked out of a run — before, during, or after ([ADR 0012](docs/adr/0012-operator-control.md)).
The frozen contract is exactly as untouchable as ever: everything below steers the **worker** or the
**operational caps**, never the bar, so both keys still gate DONE.

**Watch it live, from any terminal.** Every run's startup banner names the command; it renders one
line per event as it lands in the write-ahead log (agent turns, verifier verdicts, sign-off vetoes):

```bash
goaly runs watch run-<id>        # read-only; exits 0 when the run finishes
```

**Steer it mid-run.** Ctrl-C stops cleanly between steps (nothing is lost), then resume with
guidance — the note is appended to the worker's next prompt and recorded in the log:

```bash
^C
goaly --resume run-<id> --note "the fixture belongs in test/fixtures, not src"
```

**Extend it after it stops.** A run that ended at an *operational* limit is not a dead end: pass the
raised cap **with** `--resume` and the run continues where it stood — prior work, session, and spend
all intact. Each extension is persisted (an auditable `RUN_EXTENDED` log marker), so later plain
resumes keep it:

```bash
goaly --resume run-<id> --max-iterations 25             # revive FAILED at the iteration cap
goaly --resume run-<id> --budget-tokens 900000          # revive a budget abort (prior spend still counts)
goaly --resume run-<id> --stuck-no-diff false --note "try editing src/parser.ts directly"
                                                        # revive a stuck abort, with direction
```

Only the operational knobs are extendable (`--max-iterations`, `--budget-tokens`,
`--budget-wall-ms`, the `--stuck-*` thresholds) — the goal, verifier, and rubric are structurally
not part of an extension, so autonomy never becomes "renegotiate the bar." A DONE run refuses to
extend and points you at `--from-run`. Rule of thumb: **same goal, more room → `--resume` with
caps/note; new or refined goal → `--from-run`** (a fresh contract, compiled aware of what just
happened — see [Following up](#following-up-after-a-run-ends---from-run)).

### Inspecting past runs

The write-ahead run log is also queryable after the fact, with **read-only** subcommands that
**re-run nothing** — they replay the persisted event stream with the *same* fold `--resume` uses, so
what they render is exactly the state the Driver computed:

```bash
goaly runs list                  # a table of past runs under ./.goaly
goaly runs show run-<id>         # full detail for one run
goaly runs watch run-<id>        # follow a LIVE run's events from another terminal
goaly runs resume-cmd run-<id>   # how to continue this run's CLI session interactively
goaly runs list --workspace ./myrepo   # look elsewhere for the .goaly directory
```

- **`goaly runs list`** — one row per run: id, status (`DONE` / `FAILED` / `ABORTED`, or
  `INCOMPLETE` for a run that never finished), iterations, tokens, started/ended, and the goal.
  Most-recent first.
- **`goaly runs show <runId>`** — the **frozen contract** (and its hash), the **Seal** outcome,
  every iteration's **verifier-ladder verdict** and **Sign-off** approver decision, the
  stuck/failure **reason**, and the totals.
- **`goaly runs resume-cmd <runId>`** — print the command to continue the run's underlying CLI
  session in its **own interactive mode** (e.g. `claude --resume <id>`, `codex resume <id>`,
  `droid --session-id <id>`, `pi --continue`), recovered from the log's recorded harness + last real
  session id. For a `goaly-code` run (no external CLI) it routes you to `--from-run --inherit-session`.
  Pass `--harness <name>` as a fallback when the log predates harness recording.

Both `list` and `show` parse the log with **Zod on read** and **fail closed**: a corrupt run is
*flagged* (`CORRUPT` in the table; a non-zero exit for `show`), never silently treated as green or
dropped (invariants #6/#7). `runs show` exits `1` for an unknown or corrupt run, `0` otherwise.

### Following up after a run ends (`--from-run`)

A finished run is one-shot no more. To act on the result — *"good, but also handle empty input"*, or
*"the test you wrote is too loose"* — start a **new, re-verified run that builds on it**:

```bash
goaly "now also handle empty input" --from-run run-<id>                    # fresh session + compaction
goaly "now also handle empty input" --from-run run-<id> --inherit-session  # also keep the agent's memory
```

`--from-run <runId>` is a flag on the normal run path, so it composes with every other flag
(`--harness`, `--generate`, `--autonomous`, `--phased`, `--baseline`). It:

- runs in the **same workspace**, so the prior outcome is already on disk — the new run literally
  builds on it;
- seeds the new run's **contract authoring** with a concise, deterministic **compaction** of the
  prior run (its goal, the frozen bar it met, how it ended), woven into the compile-phase feedback —
  so the follow-up knows what just happened **without copying or weakening** the old contract;
- compiles its **own** frozen, two-key contract and is otherwise an ordinary `drive()` run — **every
  invariant is preserved by construction** (new Seal, new freeze, new two-key gate).

This is distinct from `--resume`, which re-enters an *incomplete* run's loop; `--from-run` starts a
**new** run that builds on a *terminal* one. `--inherit-session` additionally resumes the prior
harness session on the follow-up's **first turn** so the agent keeps its working memory — the **new
frozen contract still solely governs DONE**; inheritance only seeds the agent's memory, never the
bar. It is valid only with the same `--harness` as the prior run (session ids are harness-specific)
and is ignored under `--phased`. The end-of-run banner also prints a **"Continue this session:"**
hint (the same mapping as `runs resume-cmd`) so the next step is one copy-paste away.

### Web UI (`goaly ui`)

Everything the read-only subcommands show — plus live tails — in the browser:

```bash
goaly ui                       # serve http://127.0.0.1:4180 over this workspace's runs
goaly ui --port 5000 --workspace ./myrepo
```

- **Runs table, across every root.** One section for the main workspace and one per managed
  [worktree](#worktrees---worktree), most-recent first, with status badges and a pulsing **LIVE**
  badge for a run some process is currently driving. Corrupt logs are **flagged, never dropped**
  (the same fail-closed read as `runs list`).
- **Run detail.** The frozen contract (rungs + hash + setup), Seal decisions, every iteration's
  verifier verdict and Sign-off approval/veto, the failure/stuck reason, spend totals, and the
  exact `--resume` command — the `runs show` projection, rendered.
- **Live event feed.** The write-ahead log tailed over **SSE** (the browser twin of
  `goaly runs watch`): contract → seal → each agent turn / verdict / veto as they land. Works for
  runs started in **any terminal** — the tail is strictly read-only (it never takes the run lock).
  When a run records a per-turn transcript (`--stream-transcript`), its tool calls and messages
  stream into the feed too.
- **Worktrees panel.** Name / branch / HEAD / dirty / runs-count for every managed worktree,
  `PRUNABLE` flagged — with create / remove (the manager's refusal ladder surfaces verbatim: a live
  run or a dirty tree refuses, exactly like the CLI).
- **Start runs — and hold the Seal in your hand.** The start form takes a goal, a `--verify-cmd`
  or `--generate`, harness, caps, and an optional worktree; the run executes **in-process through
  the exact same code path as the CLI** (same guards, same run lock, same write-ahead log — a
  server crash leaves it `--resume`-able like any run). A **non-autonomous** run parks at a
  **browser Seal modal**: the frozen contract (rungs, hash, setup, authored files) presented for
  **approve / revise-with-feedback / reject**, exactly the CLI prompt's semantics — a third
  `SealGate` *implementation*, never a bypass: the contract still freezes and the decision still
  lands in the log. Each parked gate carries a one-time `gateId`, so a double-submit can never
  answer a later gate.
- **The Seal modal is a review station ([ADR 0016](docs/adr/0016-seal-review-station.md)).**
  Every artifact the run will use is reviewable *by content* before you approve: each authored
  verification file renders with its **full contents** and an **in-browser editor**, and the
  contract's operator-editable fields (setup command, deterministic verify commands, rubric) are
  edit-in-place. **"Re-freeze & review"** saves your edits through the same guarded, git-excluding
  writer the compiler uses (writes are allowlisted to exactly the parked contract's authored
  files), re-pins the hashes, and re-presents a freshly frozen contract — iterate as many times as
  you like (a refreeze costs no LLM tokens and never consumes the revise cap). Edits made in your
  **own editor** are picked up too: a *"changed on disk since frozen"* badge appears, and
  **"refresh from disk"** re-freezes from the current tree. Approving with drifted files is
  refused (409, *"re-freeze first"*) so a stale approval never wastes an agent iteration. Only the
  contract you finally approve starts executing.
- **Stop & resume from the browser.** Stop is the same cooperative between-steps interrupt as
  Ctrl-C (the ABORTED lands in the feed; nothing is lost); the resume panel continues any non-live
  run — terminal-started ones included — with an optional `--note` and raised **operational** caps
  (the ADR 0012 extension schema, which structurally has no field for the goal/verifier/rubric).
- **One live run per tree.** Starting a second run in an occupied root is refused (409) with a
  pointer at worktrees — per-run locks stop double drivers, this stops two agents editing one tree.

The server is the same replay-fold the CLI uses — **the disk is the source of truth**, so it can be
started and stopped freely; UI-owned runs stay resumable if it dies. It binds `127.0.0.1` only
and — because a no-auth localhost server is reachable from any page your browser has open — refuses
requests with a non-local `Host` (DNS-rebinding) or a cross-site `Origin`, and requires an
`X-Goaly-Ui: 1` header on every state-changing request (a cross-site form can never attach one) —
all fail-closed ([ADR 0014](docs/adr/0014-local-web-ui.md),
[ADR 0015](docs/adr/0015-ui-owned-runs.md)). Embedders get the same server via
`startUiServer({ workspaceRoot })`, and the same shared run entrypoint via `executeRun()`.

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
  interactiveResume?(id): { command: string; caveat? };          // optional: continue the CLI session (A)
}
```

The codec is consumed by **both** roles a CLI can play, from one source of truth: the write-role
`HarnessAdapter` (seam #1) drives the agent, and the read-only `AgentCliLlmProvider` (the
judge/approver/compiler LLM role) reuses the same extractors and the `readonlyArgs` dialect — so
there is no `llm → harness` coupling. The generic `AgentCliHarness` is all the seam-#1 wiring a codec
needs; registering a harness is one codec module + one line in `codecFor`. `diffHash` and verifier
execution live in the shared `Workspace`, not the codec — so stuck-detection and verification work on
any harness for free. The shared `agent-cli` core owns the tolerant final-result parse, the streaming
`StreamTap`, and the flat status policy (`classifyFlatRun`), and the shared `runProcess` owns the one
tested subprocess dance (output cap, timeout, process-group kill, never-reject). See
[`docs/adding-a-harness.md`](docs/adding-a-harness.md) for the full guide.

There are **two adapter shapes**. The codec shape above wraps an external CLI. The `goaly-code` harness
(`--harness goaly-code`) is the first **non-codec** adapter: goaly becomes the coding agent itself, running
its own tool-use loop against an OpenAI-compatible chat-completions endpoint — so there is no CLI to
install. It reuses the same seam #1 (`HarnessAdapter`), the same `Workspace`/sandbox/streaming/token
machinery, and a shared HTTP transport (`OpenAiClient`) with the read-only `openai` LLM provider. See
the "goaly-code harness" path in [`docs/adding-a-harness.md`](docs/adding-a-harness.md).

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

Two optional `DriverDeps` hooks matter to embedders: `interrupted: () => boolean` (poll-based
cooperative shutdown — when it turns true, `drive()` finishes the in-flight step, persists it
write-ahead, and resolves to a typed `ABORTED` naming the resume path) and
`sleep: (ms) => Promise<void>` (the crash-retry backoff timer — inject a no-op in tests). Both
default sensibly; the CLI wires `interrupted` to SIGINT/SIGTERM.

Subscribe to the live stream programmatically with `composeDeps({ onStreamEvent })`, or have goaly
persist it and read it back offline — the same canonical `AgentStreamEvent` shape across every
harness:

```ts
import { composeDeps, drive, readStreamTranscript } from 'goaly';

const deps = composeDeps(config, { /* … */ runId, streamTranscript: true });
await drive(deps, config, runId);
const stream = await readStreamTranscript('.goaly', runId); // [{ phase, kind, …, ts }] | null
```

## Training arc (experimental — the goaly-tuned model)

`--harness goaly-code` exists so goaly can **own the inference path** and specialize a small model to
its own loop, using the frozen verifier ladder + the independent approver as a free,
reward-hacking-resistant training signal (a policy **cannot** win by weakening the bar — the contract
is frozen and the approver is an independent key). The data pipeline (Slices 2–3) is shipped and
embeddable:

```ts
import { exportRunTrajectory, toSftJsonl, BENCH_TASKS, runBench, summarizeBench } from 'goaly';

// 1. Every goaly-code run is an automatically-LABELED trajectory: the conversation in our exact tool
//    schema, tagged with its ladder/approver outcome (DONE = the two keys passed).
const traj = await exportRunTrajectory({ stateDir: '.goaly', runId, sessionStore });

// 2. Rejection-sample: keep only PASSED trajectories → an SFT dataset in goaly-code's tool schema.
const sftJsonl = toSftJsonl(records, { maxIterations: 3 });

// 3. A held-out eval bench compares harnesses / gates each new model (pass@1, iters, tokens).
const summary = summarizeBench(await runBench(BENCH_TASKS, runTask));
```

**Status.** Slices 0–1 (the harness + transport) and the Slice 2–3 **data pipeline** (trajectory
export, eval bench, rejection-sampling SFT assembly) are implemented and verified end-to-end against a
real OpenAI-compatible endpoint. The remaining slices are infra-gated: **Slice 3 training** (feeding
`sftJsonl` to a provider fine-tune API or a local LoRA), **Slice 4** (expert-iteration / RL using the
ladder as reward), and **Slice 5** (a productionized, bench-gated `goaly-coder-vN` shipped as
`--harness goaly-code --base-url <endpoint> --model goaly-coder-vN` — the harness code does not change,
only the endpoint/model). See [`docs/adr/0008`](docs/adr/0008-goaly-code-harness.md) and
[`docs/adr/0009`](docs/adr/0009-training-data-pipeline.md).

## Appendix: Glossary

Plain-language definitions of the project-specific terms and idioms used throughout this README and
the codebase — so none of the jargon is load-bearing-but-unexplained. **Standard** concepts that are
just easy to miss link out to a canonical reference; **project-specific** ones link to where they're
specified in depth. (For the terse contributor *"one term, one meaning, and what it is **not**"* noun
list, see [`CONTEXT.md`](CONTEXT.md) — the ubiquitous-language reference.)

### Core idioms

- <a id="g-fail-closed"></a>**Fail-closed** — when anything errors, returns garbage, or can't be
  parsed, it resolves to the *safe* answer — a FAIL / VETO / aborted run, **never a false green**. A
  malformed grader is a failure, not a pass. This is invariant #4 and the spine of the design.
  ↪ [AGENTS.md → the eight invariants](AGENTS.md), [Fail-safe (Wikipedia)](https://en.wikipedia.org/wiki/Fail-safe).
- <a id="g-fail-open"></a>**Fail-open** — the deliberate *opposite*, used **only** where a wrong
  "block" is worse than a wrong "proceed": an advisory check that is uncertain **proceeds** instead of
  aborting, because the real fail-closed gates (the frozen ladder + the approver) still govern the
  outcome downstream. Example: the pre-flight soundness classifier — a wrong "broken" would kill a
  legitimate run, a wrong "sound" only lets the loop run (and be caught later). ↪ [ADR 0010](docs/adr/0010-prepare-from-scratch.md).
- <a id="g-reward-hacking"></a>**Reward-hacking** (a.k.a. *specification gaming*) — reaching the
  *measured* goal ("the test passes") without meeting the *actual* goal — e.g. by weakening the test
  it's graded against. Preventing this is goaly's entire reason to exist. ↪ [DESIGN.md](DESIGN.md), [Hardening against reward-hacking](#hardening-against-reward-hacking).
- <a id="g-frozen"></a>**Frozen / freeze / `contractHash`** — the success contract is authored
  **once**, hashed, and locked before the loop; no later step can rewrite it, and the hash is logged
  every iteration to prove the bar never moved. "Freezing" is the act of locking it at **Seal**.
  ↪ [How it works](#how-it-works), invariant #2 in [AGENTS.md](AGENTS.md).
- <a id="g-two-keys"></a>**Two keys (for DONE)** — a run is DONE only when **both** independent keys
  turn: the frozen **verifier ladder** passes **and** the independent **approver** doesn't veto.
  "Tests pass" is not "done". ↪ [How it works](#how-it-works), invariant #3.
- <a id="g-seam"></a>**Seam** — a boundary where a real implementation and a fake are interchangeable,
  so policy can be tested with zero IO. goaly has **four real seams** (harness, verifier/ladder,
  approver, clock+budget) and one **internal seam** (the read-only `LlmProvider` behind the
  judge/approver/compiler). ↪ [ARCHITECTURE.md](ARCHITECTURE.md), [Adding a harness](#adding-a-harness).

### The loop & its gates

- **Reducer / Orchestrator** — the **pure**, synchronous `step(state, event) -> [state, Command[]]`
  that owns all policy and makes **zero** LLM/IO calls (invariant #1). "Pure" = output depends only on
  inputs, no side effects. ↪ [Pure function (Wikipedia)](https://en.wikipedia.org/wiki/Pure_function), [ARCHITECTURE.md](ARCHITECTURE.md).
- **Driver** — the imperative half: it performs the `Command`s the reducer asks for (run the agent,
  judge, approve, persist) and feeds the resulting `Event`s back. The only place that touches a clock,
  process, budget, or disk. ↪ [ARCHITECTURE.md](ARCHITECTURE.md).
- **DECIDE** — the pure truth table that maps `(ladder verdict, approval, stuck, iteration)` to one of
  `CONTINUE / DONE / FAILED / ABORTED`. ↪ [CONTEXT.md](CONTEXT.md).
- **Seal** — the **contract** gate: once, before the loop, a human (or `--autonomous` auto-accept)
  approves the frozen contract. Not per-iteration. ↪ [How it works](#how-it-works).
- **Sign-off / Approver** — the **result** gate: an independent reviewer that runs every iteration and
  is **veto-only** — it can stop a green from becoming DONE but can **never** promote a red.
- **Compiler / `COMPILE_FAILED`** — the read-only LLM step that *authors* the verification under
  `--generate`. A correctable authoring miss is a bounded retry (`COMPILE_FAILED`, re-author with the
  error fed back), not an immediate failure.
- **`--autonomous`** — moves the **human pauses only** (auto-accepts at Seal). It never skips the
  freeze or any verification. ↪ invariant #5.
- **`--generate`** — goaly's compiler authors the verification (and a one-time setup) for you, instead
  of you supplying `--verify-cmd`.
- **Phased / Plan / `planHash`** — `--phased` decomposes one big goal into a **frozen, ordered plan**
  of small sub-goals, each run as its own two-key contract, ending in a cumulative acceptance on the
  original goal. The plan is frozen just like a contract. ↪ [Phased goals](#phased-goals---phased).

### Verification vocabulary

- <a id="g-ladder"></a>**Verifier ladder / rung** — the composite check, run **cheapest-and-hardest-to-game
  first**: **deterministic** rungs (exit codes, tests) before any **judge** (LLM) rung, short-circuiting
  on the first deterministic fail. A **rung** is one step of the ladder. ↪ [How it works](#how-it-works).
- **Deterministic rung** — an ungameable shell check: `pass = exit 0`, `confidence = 1`. **Judge rung**
  — an LLM-quorum check for fuzzy criteria. **Smoke rung** (`--smoke`) — an extra deterministic rung
  that *runs the built artifact* to prove it works at runtime.
- **Verdict** — the unified `{ pass, confidence, detail }` every verifier returns; the reducer can't
  tell which kind of check produced it.
- **Quorum / confidence floor** — a judge rung samples the model **quorum** times and passes only if
  enough samples agree above the **confidence floor**. ↪ [Quorum (Wikipedia)](https://en.wikipedia.org/wiki/Quorum_(distributed_computing)).
- **Rubric** — the *frozen* judging criteria for a judge rung (never regenerated per iteration).
- **Integrity guard / anti-tamper / generated files** — files goaly authors for `--generate` are
  pinned by content hash inside the frozen contract; a **guard rung** re-checks them every iteration
  and **fails closed** on any change, so the worker can't rewrite the bar it's measured against.
- **Vacuous bar** — an authored check that trivially passes without measuring anything (`true`, `:`,
  `exit 0`). Rejected at compile time. ↪ [Hardening against reward-hacking](#hardening-against-reward-hacking).
- **Untrusted-data fencing / prompt-injection defense** — the judge/approver receive the
  worker-controlled diff inside a nonce-delimited envelope and are told never to obey instructions
  hidden in it. ↪ [Prompt injection (Wikipedia)](https://en.wikipedia.org/wiki/Prompt_injection).
- **Independence / self-judge risk** — the two keys should not collapse onto **one model** (which would
  share blind spots). goaly warns loudly, and escalates under `--generate --autonomous` when the agent,
  judge, and approver are all the same model. ↪ [Hardening against reward-hacking](#hardening-against-reward-hacking).

### The prepare phase & soundness

- **Prepare phase / setup / `SETUP_FAILED`** — a one-time, pre-loop **bootstrap** (run setup, prepare
  the tree) after Seal and before iteration 1. A failing **user** `--setup-cmd` is a fatal
  `SETUP_FAILED`; a failing **compiler-authored** setup is best-effort. ↪ [ADR 0010](docs/adr/0010-prepare-from-scratch.md).
- **Pre-flight** — running the frozen deterministic checks **once** before the first agent turn, to
  prove the bar can actually run.
- **Soundness / `CONTRACT_UNSOUND`** — a typed abort (before any worker token) when the frozen
  verification is itself defective rather than the implementation: it can't run/compile, **or** it
  already passes vacuously on a from-scratch tree (the compiler authored the solution into the frozen
  set). The classifier is **[fail-open](#g-fail-open)**. ↪ [ADR 0010](docs/adr/0010-prepare-from-scratch.md).
- **From-scratch / empty-of-source** — a tree with no implementation source yet (only docs + the
  authored verification). The bar is red *by definition* there until the agent scaffolds, so the
  soundness check biases toward "honest red, proceed."

### Failure & stuck vocabulary

- <a id="g-stuck"></a>**Stuck detection** — bailing **before** `--max-iterations` with a typed reason,
  because the loop is making no progress. Kinds: **no-diff** (the tree didn't change), **repeat-failure**
  (`STUCK_REPEATED_FAILURE`, the same verifier-failure signature recurs), **oscillation** (period-N
  cycling), **harness-crash** (`STUCK_HARNESS_CRASH`, the agent CLI keeps exiting abnormally),
  **contract-unevaluable** (`CONTRACT_UNEVALUABLE`, the frozen ladder could not be *evaluated* — the
  check couldn't run or the judge errored — so the tree is correct-but-unverified, never blamed), and
  **budget**. ↪ [How it works](#how-it-works), [CONTEXT.md](CONTEXT.md).
- **Terminal statuses** — **DONE** (both keys turned), **FAILED** (a typed failure: stuck, budget, out
  of iterations, a fatal prepare abort), **ABORTED** (Seal-reject / a no-diff stuck / driver error),
  and **INCOMPLETE** (a run that never finished, e.g. a crash before a terminal state — seen in
  `goaly runs list`).

### Persistence & resumption

- <a id="g-write-ahead"></a>**Write-ahead log / run log** — the append-only event stream under
  `.goaly/<runId>/`, written **before** the state advances. It is the single source of truth for
  replay and resume (≠ the human diagnostics log). ↪ [Write-ahead logging (Wikipedia)](https://en.wikipedia.org/wiki/Write-ahead_logging), invariant #7.
- **Replay / resume** — rebuilding run state is a pure **fold** over the logged events; `--resume`
  replays then continues, repeating no completed iteration.
- **At-least-once / idempotent** — durability is at-least-once: a crash may re-run exactly one effect
  on resume; the harness's session-resume makes that re-run **idempotent** (same result, no double
  effect). ↪ [Idempotence (Wikipedia)](https://en.wikipedia.org/wiki/Idempotence).
- **Command vs Event** — a **Command** is data describing an effect the Driver must perform (never
  persisted); an **Event** is its resolved result, fed to the reducer and persisted write-ahead.
- **`diffHash`** — a non-mutating content hash of the working tree (computed by the Workspace, not the
  adapter) that drives stuck detection. Not a commit.
- **Baseline / `--delta-verify` / checkpoint** — the git ref a diff is computed **against**. The
  **judge** baseline can advance per-iteration (`--delta-verify`, via an internal **checkpoint** — a
  private `git write-tree` snapshot, no commit) to keep its prompt flat, while the **approver**
  baseline stays pinned to the run/phase start so Sign-off always reviews the **whole** cumulative
  change. ↪ [Diff baseline](#diff-baseline---baseline), [Per-iteration delta diffs](#per-iteration-delta-diffs---delta-verify).

### Architecture & wiring

- **Harness / Adapter / Codec** — a **harness** is a coding agent run headlessly (Claude Code, Codex,
  Droid, pi, or goaly's own `goaly-code`). The **adapter** is its one-method `run(prompt, sessionId?)`
  wrapper; a **codec** holds one CLI's quirks (argv dialects, output parsing, status mapping) in one
  module. ↪ [Adding a harness](#adding-a-harness), [docs/adding-a-harness.md](docs/adding-a-harness.md).
- **LLM provider (internal seam)** — the read-only seam the compiler / judge / approver / observer call
  for completions. "Internal" because it varies *inside* those steps, never across the four real seams.
- **Composition root (`compose`)** — the one place real implementations are wired to the seams (the
  CLI `compose.ts`); embedders can swap any seam here. ↪ [Embedding](#embedding).
- **Sandbox / jail / launcher / egress proxy** — opt-in OS isolation (`--sandbox`) of the two
  untrusted execs (agent + verify command). A **launcher** (`bwrap`/`firejail`/`container`) translates
  a per-seam **profile** into its flags; an **egress proxy** enforces a host **allowlist**. ↪ [Sandboxing](#sandboxing), [ADR 0007](docs/adr/0007-sandboxing-model.md).

### Observability & sessions

- **Stream / `AgentStreamEvent` / transcript** — `--stream` renders the agent's **raw** intermediate
  turns live (tool calls, messages, tokens), mapped onto one tool-neutral event taxonomy;
  `--stream-transcript` persists that same stream as JSONL for offline replay. Pure observability —
  never written to the run log. ↪ [Live streaming](#usage).
- **Observer / `--explain`** — an opt-in, **read-only** side-LLM that *synthesizes* the run in plain
  language at three checkpoints (contract at Seal, each ladder run, the outcome). Strictly advisory
  and **fail-closed** to "no summary"; can never influence the contract, ladder, DECIDE, or DONE.
  ↪ [Plain-language narration](#usage).
- **Spend report / token metering / `estimated` / `tokensUnknown`** — every run ends with a token
  breakdown by layer (harness vs. LLM steps). When a provider reports no usage, goaly **estimates**
  from streamed turns, or marks the layer `unknown` (loudly) — never a silent zero. ↪ [Per-run spend report](#per-run-spend-report).
- **Session / follow-up (`--from-run` / `--inherit-session`)** — a `sessionId` is the harness's handle
  to a continued CLI conversation. `--from-run` starts a **new, re-verified** goal that knows what the
  prior run did (seeds the new contract's authoring); `--inherit-session` also resumes the agent's
  working memory. ↪ [Following up after a run ends](#following-up-after-a-run-ends---from-run).

## License

[MIT](LICENSE) © krimvp
