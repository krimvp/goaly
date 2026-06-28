# ADR 0010 — the prepare phase is from-scratch-aware

## Status
Accepted.

## Context
goaly's one-time **prepare phase** (`src/driver/prepare.ts`) runs once after SEAL and before iteration
1, against the **initial** working tree. It does two things, both historically fail-closed:

1. **Setup (Fix #1):** run the contract's one-time bootstrap command (`npm ci`, `go mod download`, …)
   once; a non-zero exit was a typed `SETUP_FAILED` abort.
2. **Soundness pre-flight (Fix #2):** run the frozen deterministic rung once to prove it can execute;
   a red was handed to an LLM classifier that decided *broken frozen verifier* (`CONTRACT_UNSOUND`
   abort) vs. *honest red* (proceed).

Both assume an **existing** project. A 9-model bake-off on a hard **from-scratch** goal (build a Go
stdlib MCP server) under `--generate --autonomous` exposed the failure: the run died at **iteration 0**,
before the agent wrote a line.

- The compiler **authored** a setup (`go mod download`). On the empty seed tree there is no `go.mod`,
  so it exits 1 → `SETUP_FAILED`. (deepseek-v4-pro, haiku.)
- The authored deterministic rung (`go build && …`) is red on the empty tree because the *module/manifest
  the implementation is meant to create* doesn't exist. The classifier's `brokenVerification=true`
  clause listed "a missing tool/**dependency** that prevents the checks from ever executing," and Go's
  "package not in std / unresolved import" matched it → `CONTRACT_UNSOUND`. (qwen3-coder, devstral.)

Round A — the *same* goal with a hand-written deterministic `--verify-cmd` and no setup — was **7/9
DONE**. The models are capable; the fragility was specific to the autonomous-generate **prepare phase**,
which had no notion of "from-scratch": on an empty tree the bar is red *by definition* and the agent
must scaffold first. No flag-only workaround existed (`--no-setup` rescues setup but not the pre-flight,
which has no disable flag).

## Decision
Make the prepare phase **from-scratch-aware**, with two invariant-preserving changes.

### A. Authored setup is best-effort; user setup stays fatal (provenance-aware)
The `PREPARE_WORKSPACE` command gains `setupAuthored: boolean`, **derived purely in the reducer**
(`setup` present **and** no user `--setup-cmd`) — mirroring the existing `installMissingTools` wiring.
It is *not* added to the frozen contract: provenance is "how to prepare," not "what done means," so the
`contractHash` does not churn (invariant #2).

In `prepareWorkspace`, when setup fails **and** `setupAuthored === true`, goaly **logs loudly and
proceeds** with a `setupHint` threaded into the first prompt (the way missing-tool `installTools` is),
instead of aborting. A compiler-guessed `go mod download` that fails on an empty tree is expected, not a
configuration error. A failing **user `--setup-cmd`** (`setupAuthored === false`, also the fail-closed
default when provenance is unknown) keeps today's fatal `SETUP_FAILED`.

### B. Don't (mis)abort the soundness pre-flight on a from-scratch tree
- **B1 (structural, primary):** a new conservative, language-agnostic `Workspace.isEmptyOfSource(
  generatedFiles)` reports "no implementation source yet — only docs + the authored verification."
  `preflightDeterministic` checks it and, on a from-scratch tree, biases the soundness call toward
  "implementation missing." The `GitWorkspace` impl lists `git ls-files --cached --others
  --exclude-standard` (respecting the `.goaly` excludes), subtracts `generatedFiles` and a small doc/meta
  allowlist (`README*`, `LICENSE*`, `*.md`, `.git*`), and returns `true` only when **zero** candidate
  source files remain — so an existing project is never mistaken for from-scratch. Fail-safe to `false` on
  any git error.

  > **Amendment (issue #78).** B1 originally **short-circuited entirely** — on a from-scratch tree it
  > proceeded *without running the rung or the classifier*. That conflated two reds: "implementation
  > missing" (honest) and "the **frozen authored verifier itself** can't run/compile" (broken, and
  > **agent-unfixable** because the file is frozen). The second slipped through, leaving the deterministic
  > rung red every iteration with the worker blocked from editing the frozen file by `GeneratedFilesGuard`
  > — the run could **never reach DONE** and burned its budget to `STUCK_REPEATED_FAILURE` (fail-closed,
  > but un-completable). Fix: on a from-scratch tree still **run the rung and consult the classifier**,
  > threading the `emptyOfSource` signal into the classifier prompt to bias hard toward "honest red." The
  > classifier already fails *open*, so the empty-tree honest-red path is preserved, while a non-compiling
  > authored verifier is now caught as `CONTRACT_UNSOUND` up front (with `--max-compile-retries > 0` it can
  > feed a re-author). B1 is now a *signal into* the classifier rather than a skip *around* it.
- **B2 (classifier refinement, complementary):** the classifier `SYSTEM_PROMPT` now scopes
  `brokenVerification=true` to a defect **inside the frozen verification files themselves**, and
  explicitly classifies a **missing dependency manifest/module the implementation is expected to create**
  (`go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `requirements.txt`, `tsconfig.json`),
  uninstalled deps, or an unresolved import of a not-yet-written module as `brokenVerification=false`
  (agent-fixable). A worked example is included. B1 + B2 ship together.

### C. The GREEN mirror — an authored verifier that already PASSES on a from-scratch tree
A second deadlock class surfaced under `--generate --autonomous` with a weak self-authoring model: the
compiler authored the **solution file itself** into the frozen `generatedFiles` set (not just the test).
Because generated files are **excluded from the diff** *and* pinned by `GeneratedFilesGuard`, the worker
is trapped — editing the file it was told to implement either trips the integrity guard (a deterministic
red) or registers as **no change** (a spurious `no-diff` abort). The pre-flight was *already green* before
the first worker turn (the compiler's own solution satisfied its own test) and silently **proceeded** into
the trap.
- **C1 (classifier, symmetric to B):** when **every** deterministic rung already **passes** at pre-flight
  on a **from-scratch** tree **with** an authored verifier, a second read-only classifier
  (`classifyVacuousContract`) is asked to rule in the one legitimate alternative — "the goal is genuinely
  already satisfied by the starting tree" — vs. an **unsound** contract (the implementation was authored
  into the frozen set, or the bar is vacuous). A confident `unsound` ⇒ `CONTRACT_UNSOUND` before any
  worker token; otherwise proceed. **Fail-open exactly like B:** no LLM, an LLM error, an unparseable
  verdict, or a "sound" answer all proceed. It fires **only** on the high-confidence positive signal
  (authored verifier + `isEmptyOfSource` + LLM-confirmed), so a **not-yet-created or undetected file can
  never become a failure** — that path is a *red*, handled by B.
- **C2 (author-time prevention, complementary):** the compiler `SYSTEM_PROMPT` now states that authored
  files are **verification only** (never the implementation) and the bar **must be red on an empty tree**,
  heading the deadlock off at authoring time. C1 + C2 ship together; C1 is the structural backstop for a
  model that ignores C2.

## Honoring the invariants (why no wrong-green is possible)
- **#1 zero-LLM reducer.** `setupAuthored` is derived synchronously from config + contract; the new
  signal and the effects live in the driver/workspace seams. The reducer stays pure.
- **#2 frozen contract.** Provenance is wiring on the command, never on the contract — `contractHash`
  is unchanged. The setup command itself is still frozen.
- **#3 two keys for DONE.** Unchanged. An authored-setup failure now degrades to *proceed*; the
  frozen verifier ladder and the independent veto-only approver still gate DONE.
- **#4 fail-closed.** A *user* setup failure is still fatal. An authored-setup failure proceeds, but
  correctness is still governed by the fail-closed ladder every iteration — a degraded prepare can only
  cost iterations, never produce a wrong green. The pre-flight was already advisory / fail-**open** by
  design (a wrong "broken" aborts a legitimate run; a wrong "sound" only proceeds), and a genuinely
  broken frozen verifier is still caught generically by `STUCK_REPEATED_FAILURE`. So the from-scratch
  pre-flight (which can only ever *proceed* on an honest red) can never turn a real defect green; per the
  B1 amendment (issue #78) it now also catches a non-compiling frozen verifier up front instead of late.
- **#5 `--autonomous` moves only Seal.** Unchanged.
- **#6 parse at every seam.** The `PREPARE_WORKSPACE` command and `WORKSPACE_PREPARED` /
  `PreparedOutcome` (now carrying an optional `setupHint`) round-trip through Zod.

## Consequences
- **Positive:** a from-scratch `--generate --autonomous` run no longer dies at iteration 0 — it reaches
  the agent loop, where capable models then build (Round A proves the ability) or fail honestly *inside*
  the loop. Autonomous generation — the headline mode for the goaly-code / trained-model arc — is robust
  where it was most fragile.
- **Neutral / accepted:** `isEmptyOfSource` adds one cheap `git ls-files` to the prepare phase when
  there are deterministic rungs to pre-flight. `Workspace` gains a method (impl in `GitWorkspace`,
  `FakeWorkspace`, and the two inline test mocks).
- **Out of scope (documented, not fixed here):** the `no-diff` iteration-1 abort (an agent that cleared
  prepare but wrote nothing). That is harness-loop behavior and the detector behaved correctly; a
  possible follow-up is a one-turn grace for a first-iteration no-diff under from-scratch `--generate`,
  only if it can be done without weakening stuck detection.

## Alternatives considered
- **A `--no-setup` / a new "disable pre-flight" flag.** Rejected: `--no-setup` rescues only the setup
  case, the pre-flight has no disable flag, and a flag-only fix pushes the burden onto every autonomous
  invocation — the opposite of "robust by default."
- **Add provenance to the frozen contract.** Rejected: it would churn `contractHash` for what is purely
  "how to prepare." Deriving it as wiring in the reducer keeps the contract = "what done means."
- **B2 (classifier prompt) alone.** Rejected as the primary gate: it is LLM-dependent and probabilistic.
  B1 is a deterministic structural guard; B2 hardens the remaining existing-tree case. They ship together.
- **A text/exit-code heuristic for "missing manifest."** Rejected: the same per-language correctness/
  generality problem the classifier already replaced (`cargo` exits 101 for both; `go test` 1 vs 2; …).
