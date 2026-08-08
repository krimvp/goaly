# goaly Improvement Plan

> Derived from a full health pass: `npm ci`, `npm run typecheck`, `npm test`, `npm run coverage`,
> `npm run build`, and real CLI invocations of the `fake` and `goaly-code` harnesses were all green.
> The core architecture (pure reducer, frozen contract, two-key DONE, four seams, write-ahead log)
> is intact. This plan addresses the gaps around **stability**, **DevEX**, **ease of use**, and
> **autonomy in execution** that surfaced around that healthy core.

## Execution principles

1. **Test-first / regression-first.** Every change ships with a test that would have caught the
   gap; every bug-fix reproduces the bug before it is fixed (per `AGENTS.md` / `work-on-issue`).
2. **Docs are part of done.** Any change that touches flags, public API, architecture, or
   user-facing behavior updates `README.md`, `docs/reference.md`, and `docs/index.html` before the
   PR is considered complete.
3. **Typecheck + full test suite + coverage gate are the floor.** `npm run typecheck` and
   `npm test` must stay clean; coverage must not drop below the 80% line/branch/function thresholds
   enforced in `vitest.config.ts`. If a change legitimately lowers coverage, raise the gate only
   after proving the uncovered code is testable in a follow-up slice.
4. **One deep module at a time.** Prefer vertical slices over horizontal refactors — e.g., the
   non-git workspace slice touches `src/workspace/`, `src/cli/`, and docs, but it does not entangle
   with the orchestrator.
5. **Preserve invariants.** None of the eight invariants in `AGENTS.md` may be weakened. If a change
   touches the reducer, the PR must explain how purity and the two-key DONE rule are preserved.

---

## Phase 1 — Stability hygiene (P0)

### 1.1 Resolve `npm audit` vulnerabilities ✅ DONE

**Why.** `npm audit` reports 9 vulnerabilities (2 critical, 4 high, 3 moderate). They are mostly
 dev-time transitive deps, but they affect CI, contributors, and release confidence.

**What.**
- Run `npm audit fix` for non-breaking fixes (`brace-expansion`, `nanoid`, `postcss`).
- Evaluate and upgrade `esbuild` and the `vitest`/`@vitest/coverage-v8`/`vite` chain to patched
  versions. `esbuild@0.28.x` is the suggested patched line, but the build script must be validated.
- Add a CI step that runs `npm audit --audit-level moderate` and fails the build on new
  unaddressed advisories.
- Document any advisories that cannot be auto-fixed in a new `docs/adr/0018-dependency-audit.md`
  or in `CHANGELOG.md`.

**Files.** `package.json`, `package-lock.json`, `.github/workflows/ci.yml`.

**Tests.** No new product tests, but the existing CI matrix (Node 20 + 22) must pass after the
upgrade.

**Definition of done.** `npm audit` reports zero high/critical and `npm run check` is green.

### 1.2 Harden goaly-code harness crash accounting ✅ DONE

**Why.** With `--max-iterations 1`, a transient network blip consumes the only iteration, leaving no
room for the built-in retry to succeed. The user sees `FAILED: reached maxIterations` even though
no agent work was performed.

**What.**
- In `src/driver/driver.ts` and/or `src/goaly-code/harness.ts`, distinguish
  "pre-output harness crash" from "post-output iteration complete". A crash that produces no
  `HarnessRunResult` with `status === 'completed'` should not advance the iteration counter,
  but it should still count toward the crash streak and the budget.
- Add a clear log line and final summary when this happens: "harness crashed before producing
  output — retrying without consuming an iteration".
- Update `CONTEXT.md` vocabulary if a new accounting term is introduced.

**Tests.** Add an integration-style unit test in `src/driver/driver.test.ts` or
`src/goaly-code/harness.test.ts` that wires a harness which crashes twice then succeeds, with
`maxIterations: 2`, and proves the final state is `DONE` (or at least that the third attempt is
allowed).

**Definition of done.** A goaly-code run with a flaky endpoint and `maxIterations: 2` can recover
and complete an iteration.

### 1.3 Add coverage for the UI browser bundle ✅ DONE

**Why.** `src/ui/web/*` is essentially untested (0% for `app.ts`, `views.ts`,
`views-interactive.ts`, `session.ts`, `api.ts`). The server side is tested, but the user-facing
Preact/HTM client is not.

**What.**
- Option A: add a minimal headless browser test using Playwright or `happy-dom` that mounts the
  UI, clicks the "start run" flow, and asserts that the API client is called with the right shape.
- Option B (fallback): move browser-only files out of the Node coverage gate and add explicit
  unit tests for `api.ts` and `session.ts` using `happy-dom` or manual DOM mocks.
- The goal is not 100% coverage of the client, but to have at least one test per top-level view
  file that proves it renders without throwing and wires events correctly.

**Files.** `src/ui/web/*.test.ts` (new), `vitest.config.ts` (if browser environment is needed).

**Definition of done.** `npm run coverage` no longer shows 0% on the `src/ui/web/` aggregate,
or the files are formally excluded from the Node gate with a documented rationale.

---

## Phase 2 — Core ease of use (P0/P1)

### 2.1 Implement non-git workspace support (`FileWorkspace`) ✅ DONE

**Why.** goaly currently refuses to run outside a git repo. A plan document
`docs/plan-no-git-workspace.md` already sketches the design. This is the single biggest ease-of-use
blocker for non-technical users, CI sandboxes, and plain file trees.

**What.**
- Implement `src/workspace/file-workspace.ts` behind the existing `Workspace` seam.
- Content-addressed manifest: deterministic SHA-256 of tracked files; `.goaly` excluded by default.
- `diff()` renders a unified-diff-style textual diff between two manifests (added / deleted /
  modified) without invoking git.
- `checkpoint()` snapshots the current manifest as the new baseline.
- `setBaseline()` restores/overrides the active baseline from a stored tree hash.
- `isEmptyOfSource()` checks for non-doc/non-meta files, mirroring `GitWorkspace` semantics.
- Add `--workspace-mode file|git|auto` (default `auto`). In `auto`, use `FileWorkspace` when the
cwd is not inside a git work tree.
- Update the preflight (`src/cli/preflight.ts`) so the git check is skipped in file mode.
- Update worktree commands to refuse file-mode runs (worktrees are a git concept).
- Add ADR `docs/adr/0018-non-git-workspace.md` describing the seam mapping and the invariant
preservation.
- Update `README.md`, `docs/reference.md`, `docs/index.html`.

**Files.**
- New: `src/workspace/file-workspace.ts`, `src/workspace/file-workspace.test.ts`,
  `docs/adr/0018-non-git-workspace.md`.
- Edit: `src/workspace/workspace.ts` (type docs only, if needed), `src/cli/args.ts`,
  `src/cli/compose.ts`, `src/cli/preflight.ts`, `src/cli/run-cmd.ts`, `src/cli/main.ts`,
  `docs/reference.md`, `docs/index.html`, `README.md`.

**Tests.**
- Unit tests for `FileWorkspace` covering diff, checkpoint, baseline override, empty-source
  detection, command running, and excludes.
- CLI-level test in `src/cli/main.test.ts` that runs in a non-git temp dir with `--workspace-mode
  file` and reaches a terminal state.
- Stuck-detection tests proving `diffHash()` changes when files change and is stable when they
  do not.

**Definition of done.** A user can run `goaly "do X" --workspace-mode file --verify-cmd "..."`
outside any git repository and the run completes, resumes, and inspects normally.

### 2.2 Add `goaly doctor` / `goaly init` onboarding ✅ DONE

**Why.** First-time users must discover git, harness installation, authentication, verify-cmd vs
 generate, and Seal/autonomy on their own.

**What.**
- New subcommand `goaly doctor` (read-only) that checks:
  - Node version ≥ engine floor,
  - git availability (and whether cwd is a git repo),
  - each bundled harness CLI on PATH (claude, codex, droid, pi),
  - OpenAI-compatible endpoint reachability if `--base-url` is configured,
  - presence of a `.goalyrc` / `~/.goalyrc`,
  - writes a concise, actionable report.
- New subcommand `goaly init` that interactively (or via flags) creates a `.goalyrc` with:
  - default harness,
  - autonomy preference,
  - model / provider defaults,
  - project-level smoke/verify-cmd hints.
- Make `goaly doctor` callable from `goaly init` so users fix issues before saving config.

**Files.**
- New: `src/cli/doctor.ts`, `src/cli/doctor.test.ts`, `src/cli/init.ts`, `src/cli/init.test.ts`.
- Edit: `src/cli/args.ts`, `src/cli/bin.ts`, `src/cli/main.ts`, `docs/reference.md`,
  `README.md`, `docs/index.html`.

**Tests.**
- `doctor.test.ts`: fake probes for every check; assert the report mentions the right fix.
- `init.test.ts`: run with a temp home and temp workspace; assert `.goalyrc` is written and valid.

**Definition of done.** A new contributor can run `goaly doctor`, see what is missing, run
`goaly init`, and then run a simple goal without retyping common flags.

---

## Phase 3 — Developer experience (P1)

### 3.1 Split `src/cli/args.ts` into focused modules ✅ DONE

> Landed: `args.ts` 1,859 → ~700 lines (coordinator + `ParsedArgs` + `parseArgs`), with `USAGE`
> in `src/cli/usage.ts` and the group parsers in `src/cli/flags/` (tokens, harness, budget,
> review, sandbox, misc, subcommands). Public exports unchanged (re-exported from `args.ts`).
> The repo-health gate is `scripts/check-file-sizes.mjs` (CI + `npm run check:sizes`); the three
> pre-existing >800-line files (`driver.ts`, `compose.ts`, `step.ts`) are grandfathered with a
> shrink-only ratchet — they fail CI if they grow, and their entries must be removed once split.

**Why.** `args.ts` is 1,755 lines, violating the repo's own 800-line limit. It also mixes the
giant `USAGE` string, 76 flag parsers, subcommand parsers, and model resolution.

**What.**
- Move flag-parsing helpers and per-group parsers into `src/cli/flags/`:
  - `budget-flags.ts`, `model-flags.ts`, `sandbox-flags.ts`, `harness-flags.ts`,
    `stuck-flags.ts`, `stream-flags.ts`, `worktree-flags.ts`, etc.
- Move the `USAGE` string into `src/cli/usage.ts`.
- Keep `src/cli/args.ts` as the coordinator: it imports the group parsers, assembles `ParsedArgs`,
  and remains the public export surface.
- Preserve the existing `args.test.ts` behavior; split the tests along the same module lines so
  each parser has a focused test file.

**Files.**
- New: `src/cli/usage.ts`, `src/cli/flags/*.ts`, matching `*.test.ts`.
- Edit: `src/cli/args.ts`, `src/cli/args.test.ts`, `src/index.ts` (re-exports unchanged).

**Tests.** No behavior change; existing `args.test.ts` must pass. Add a small repo-health script
that fails if any production `.ts` file exceeds 800 lines.

**Definition of done.** No production file > 800 lines, all tests green, public API unchanged.

### 3.2 Generate a JSON Schema for `.goalyrc` ✅ DONE

**Why.** Users editing `~/.goalyrc` get no IDE validation or auto-completion despite a good Zod
schema existing in code.

**What.**
- Derive `goalyrc.schema.json` from `ConfigFileSchema` at build time and ship it in `dist/` and
  the npm tarball.
- Add a `goaly config validate <path>` subcommand that parses a config file against the schema
  and reports errors.
- Extend the drift test in `src/cli/config-file.test.ts` to require the schema file to be
  regenerated whenever the Zod shape changes.
- Document schema registration for VS Code / Zed / Vim in `docs/reference.md`.

**Files.**
- New: `scripts/gen-config-schema.mjs`, `goalyrc.schema.json` (generated), `src/cli/config-validate.ts`.
- Edit: `package.json` (files + scripts), `src/cli/config-file.ts`, `src/cli/args.ts`,
  `src/cli/config-file.test.ts`, `docs/reference.md`.

**Tests.**
- The drift test already exists; extend it to diff the generated schema.
- Add tests for `goaly config validate` with valid, invalid, and unknown-key files.

**Definition of done.** Editing `.goalyrc` in VS Code with the schema provides auto-completion
and flag validation.

### 3.3 Add shell completion ✅ DONE

> Landed as a runtime subcommand (`goaly completion bash|zsh|fish`) rather than build-time
> artifacts — the installed binary generates the script on demand from the `USAGE` contract, which
> is strictly fresher than a file frozen at build time.

**Why.** 76 flags and multiple subcommands make tab completion essential.

**What.**
- Generate bash/zsh/fish completion scripts at build time from the same flag list used by
  `--help` and the config schema.
- Add `goaly completion <shell>` that prints the script to stdout.
- Document one-line install instructions in `README.md`.

**Files.**
- New: `scripts/gen-completion.mjs`, `dist/goaly-completion.bash`, etc.
- Edit: `package.json`, `src/cli/args.ts` or new `src/cli/completion.ts`, `README.md`.

**Tests.**
- Unit test that the generated completion script contains every documented flag and subcommand.
- Optionally a CI smoke test that sources the bash completion and completes a few flags.

**Definition of done.** `source <(goaly completion bash)` enables tab completion for flags and
subcommands.

### 3.4 Hide `fake` harness from public help ✅ DONE

**Why.** `--harness fake` is a no-op test stub. Exposing it to users leads to confusing
`ABORTED: no-diff` outcomes.

**What.**
- Remove `fake` from `HARNESS_CHOICES` surfaced in `--help` and error hints unless
  `NODE_ENV === 'test'` or a hidden `--help-dev` flag is used.
- When `fake` is selected outside a test context, emit a loud warning that it performs no work.

**Files.** `src/cli/args.ts`, `src/cli/run-cmd.ts`.

**Tests.** Add tests in `src/cli/args.test.ts` and `src/cli/main.test.ts`.

**Definition of done.** `goaly --help` no longer lists `fake`; selecting it prints a clear warning.

---

## Phase 4 — Autonomy in execution (P1/P2)

### 4.1 Introduce autonomy profiles / modes ✅ DONE

**Why.** Users must manually compose `--autonomous`, `--harness-autonomy`, `--baseline`,
`--adversarial`, `--approver-models`, `--delta-verify`, `--candidates`, etc. A few built-in
profiles would make the right combinations obvious.

**What.**
- Add `--mode <name>` where `name` is one of `review`, `hands-off`, `aggressive`.
- Profiles expand at parse time into explicit flag values, so the reducer/config still sees the
same frozen `RunConfig`. No invisible state reaches the loop.
  - `review`: human Seal, human Sign-off, harness-autonomy `low`, no adversarial, no candidates.
  - `hands-off`: autonomous, harness-autonomy `medium`, independent approver model (warn if not
    set), delta-verify enabled, candidates 1.
  - `aggressive`: autonomous, harness-autonomy `high`, adversarial enabled, candidates 3,
    parallel-phases allowed, auto-remediate-stuck (Phase 4.2) if implemented.
- Profiles can be combined with explicit flags; explicit flags override profile defaults with a
loud log line.
- Add `mode` to `.goalyrc` schema.
- Document profiles with examples in `docs/reference.md` and `README.md`.

**Files.**
- New: `src/cli/modes.ts`, `src/cli/modes.test.ts`.
- Edit: `src/cli/args.ts`, `src/cli/config-file.ts`, `src/cli/run-cmd.ts`, `docs/reference.md`,
  `README.md`, `docs/index.html`.

**Tests.**
- Parse-time tests: each mode expands to the expected flag set.
- Override tests: `--mode hands-off --harness-autonomy low` resolves to `low` and logs the override.
- Model-independence warning tests: `hands-off` without `--approver-model` or `--approver-models`
still emits the independence warning.

**Definition of done.** `goaly "goal" --mode hands-off` runs an autonomous, baseline-pinned,
independent-approver run with one command.

### 4.2 Automatic stuck remediation (opt-in) ✅ DONE

> Landed as PURE REDUCER policy (`src/orchestrator/remediate.ts`, folded through DECIDE) rather
> than a driver-side loop: the spend ledger lives in `LoopCtx`, so `--resume` replays it exactly
> (invariant #7) and the driver only reports it loudly. `--auto-remediate-stuck` also rides
> `--mode aggressive`.

**Why.** Stuck detection stops the run and asks the operator to resume. For long autonomous runs,
users may want bounded self-recovery.

**What.**
- Add `--auto-remediate-stuck` flag.
- Implement a small, safe remediation policy in the Driver:
  - On first `STUCK_NO_DIFF`: append a canned hint ("try a different approach") and retry once
    without consuming a new iteration.
  - On `STUCK_REPEAT_FAILURE`: raise the repeat threshold once and retry.
  - On `STUCK_HARNESS_CRASH`: raise the crash threshold once and retry.
  - Never auto-remediate `CONTRACT_UNEVALUABLE`; that is an environment failure.
  - Log every remediation loudly and include it in the final summary.
- Cap remediation count per run (e.g., max 3) to prevent runaway.

**Files.**
- Edit: `src/cli/args.ts`, `src/driver/driver.ts`, `src/orchestrator/decide.ts` or new
  `src/driver/remediate.ts`, `docs/reference.md`.

**Tests.**
- Add tests in `src/driver/driver.test.ts` that wire a stuck condition and prove remediation is
  applied and capped.
- Add orchestrator-level tests if new events are introduced.

**Definition of done.** A run with `--auto-remediate-stuck` recovers from a no-diff or repeat
failure at least once without operator intervention.

### 4.3 Document parallel-phases more prominently ✅ DONE

> Landed with two deviations from the sketch: (1) the proposed non-autonomous confirmation warning
> is superseded — the CLI already FAILS CLOSED (`--parallel-phases` requires `--autonomous`), which
> is stricter, and the reference now says so; (2) the UI cannot start a parallel-phases run yet
> (it needs a `--plan-file` with group-tagged waves, which the browser form cannot author), so the
> UI test pins the phased argv path and documents that limit instead.

**Why.** `--parallel-phases` is a major autonomy feature but is marked experimental and buried in
help.

**What.**
- Add a dedicated `docs/reference.md` section with an end-to-end example.
- In non-autonomous mode, print a confirmation warning when `--parallel-phases` is selected:
  "parallel phases can create merge conflicts; the run will pause for your approval after the plan."
- Add an integration test for the UI "start run" path with `--parallel-phases` selected.

**Files.** `src/cli/run-cmd.ts`, `src/ui/start-run.test.ts`, `docs/reference.md`,
`docs/index.html`.

**Definition of done.** A user can find the parallel-phases feature in the reference, understand
its risks, and run it from the UI.

---

## Phase 5 — Project hygiene and docs (P2)

### 5.1 Add `CHANGELOG.md` ✅ DONE

> `CHANGELOG.md` covers v0.1.1 through v0.2.4 plus [Unreleased]; the publish workflow now fails
> before building when the release version has no `## [x.y.z]` entry.

**Why.** There is no release-level summary. With 17 ADRs and rapid feature additions, users and
contributors cannot see what changed, what is experimental, or what broke.

**What.**
- Add `CHANGELOG.md` following [Keep a Changelog](https://keepachangelog.com/) format.
- Seed it from the existing git history (v0.1.0 through v0.2.4) and mark experimental features
(`--parallel-phases`, `--adversarial`, `--candidates` best-of).
- Update the release workflow / Makefile to require a changelog entry before tagging.

**Files.** `CHANGELOG.md`, `.github/workflows/ci.yml` or `Makefile`.

**Definition of done.** `CHANGELOG.md` exists and documents every release with added/changed/
deprecated/removed/security sections.

### 5.2 Add a docs-sync CI check for flags ✅ DONE

> `scripts/check-docs-sync.ts` (`npm run check:docs`, in CI) verifies every USAGE flag and every
> config key appears in `docs/reference.md`. It immediately caught the predicted drift —
> `--intent`/`--rubric` were undocumented in the reference — now fixed.

**Why.** `--intent` and `--rubric` are documented in the CLI `USAGE` string but not obviously in
`docs/reference.md`. This kind of drift is easy with 76 flags.

**What.**
- Add a script (e.g., `scripts/check-docs-sync.mjs`) that:
  - Extracts all `[--flag-name]` strings from `src/cli/args.ts` and `USAGE`.
  - Verifies each appears in `docs/reference.md`.
  - Verifies each config-file key appears in the reference.
- Run the script in CI.

**Files.** `scripts/check-docs-sync.mjs`, `.github/workflows/ci.yml`.

**Tests.** The script itself is a CI gate; add a small unit test for the extractor if it is a
separate module.

**Definition of done.** CI fails when a new CLI flag is added without corresponding reference
 documentation.

### 5.3 Reduce `tsx`/`FORCE_COLOR` noise ✅ DONE

**Why.** Every dev and test run prints:
```text
(node:XXXX) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
```
This hides real warnings.

**What.**
- Audit npm scripts and `Makefile` to set `NO_COLOR=` and `FORCE_COLOR=` consistently.
- Prefer `NO_COLOR=1 npm test` for CI and `FORCE_COLOR=1` for local dev, but avoid both being
set in conflicting ways.
- If the warning comes from a transitive `tsx` behavior, document the workaround and suppress the
warning in test output.

**Files.** `package.json` scripts, `Makefile`, `vitest.config.ts`.

**Definition of done.** `npm test` and `npm run dev` no longer emit the warning under normal use.

### 5.4 Consider remote UI access (optional, post-Phase 1) — DEFERRED

> Decision (2026-08-08): not built. The localhost-only, fail-closed posture is a deliberate
> security property, and a token/cookie auth model deserves its own design review (threat model,
> CSRF/session story, TLS guidance) rather than riding a hygiene phase. Revisit on real demand,
> as its own ADR + PR.

**Why.** The UI binds `127.0.0.1` and refuses non-local origins. This is correct fail-closed
design, but prevents team/remote use.

**What.**
- Add `--ui-allow-remote` with a token/cookie auth model, gated behind explicit opt-in.
- Document the security model in `docs/reference.md`.
- This is intentionally lower priority because it increases attack surface.

**Files.** `src/ui/server.ts`, `src/ui/router.ts`, `src/ui/sessions.ts`, `docs/reference.md`.

**Definition of done.** `goaly ui --ui-allow-remote --ui-token <token>` serves on `0.0.0.0` and
requires the token for state-changing requests.

---

## Dependency graph and sequencing

```
Phase 1.1 (audit) ──────────────────────────────────────────────┐
Phase 1.2 (crash accounting) ────────┐                          │
Phase 1.3 (UI tests) ────────────────┤                          │
Phase 2.1 (FileWorkspace) ───────────┤  all independent vertical slices
Phase 2.2 (doctor/init) ─────────────┤                          │
Phase 3.1 (split args.ts) ───────────┘                          │
Phase 3.2 (config schema) ───────────┐ after 3.1                │
Phase 3.3 (shell completion) ────────┤ after 3.1/3.2            │
Phase 4.1 (profiles/modes) ──────────┤ after 3.1                │
Phase 4.2 (auto-remediate) ──────────┤ after 1.2                │
Phase 4.3 (parallel-phases docs) ────┤                          │
Phase 5.* (docs/hygiene) ────────────┴──────────────────────────┘
```

The only strict ordering is:
- Phase 3.1 (split `args.ts`) should precede flag-heavy additions in 3.2, 3.3, 4.1, 4.2.
- Phase 1.2 (crash accounting) should precede Phase 4.2 (auto-remediate-stuck) because remediation
  semantics depend on whether a crash consumed an iteration.
- Phase 2.1 (non-git workspace) can be done in parallel with everything else because it is
  behind the `Workspace` seam.

---

## Suggested first PRs

1. **"chore: resolve npm audit advisories and gate CI"** — Phase 1.1.
2. **"feat: non-git FileWorkspace behind the Workspace seam"** — Phase 2.1 (largest user-facing
   win).
3. **"refactor: split cli/args.ts into focused flag modules"** — Phase 3.1 (enables later work).
4. **"feat: goaly doctor and goaly init onboarding"** — Phase 2.2.
5. **"feat: autonomy profiles (`--mode`)"** — Phase 4.1.
6. **"docs: add CHANGELOG.md and docs-sync CI check"** — Phase 5.1 + 5.2.

Each PR should be small enough to review in under 30 minutes and must pass the definition of done:
`npm run typecheck`, `npm test`, coverage gate, docs in sync, and no invariant weakened.
