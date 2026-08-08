# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Upgraded `vitest` to `^3.2.7`, `@vitest/coverage-v8` to `^3.2.7`, and `esbuild` to `^0.28.1` to
  resolve `npm audit` advisories (moderate/high/critical in the previous toolchain).
- Added an `npm audit --audit-level moderate` step to CI so new advisories fail the build.

### Fixed
- A harness crash (after the Driver's retry is exhausted) no longer consumes an iteration under
  `--max-iterations`. Stuck detection still records the crash streak, and the budget still accounts
  for the abandoned attempt, but a transient crash cannot single-handedly exhaust a tight iteration
  cap.

### Added
- A **real dependency DAG for phased plans** (issue #123). A `SubGoal` may now name itself with a
  stable, plan-local `id` and declare exactly what it needs with `dependsOn`, so "C needs A and B,
  D needs only A" is expressible — previously independence was positional (`--parallel-phases`
  grouped *consecutive* phases sharing a `group` number), so reordering a plan silently changed its
  concurrency semantics. The graph is validated at parse time and **fail-closed** at every plan seam
  (planner, `--plan-file`, freeze, run-log read): a duplicate id, an unknown id, a self-reference, a
  cycle, or a forward edge is a typed plan-parse failure, never a silently linearized plan. Phases
  are listed dependencies-first (a topological order), which keeps the sequential walk and the
  unmerged-wave downgrade sound by construction. Scheduling is a new PURE function —
  `(frozen plan, completed phases) -> ready frontier` (`src/domain/plan-graph.ts`) — so the wave
  machinery now fans out the plan's current **topological frontier**, recomputed after every merge
  and reconstructed from the log on `--resume` (no completed phase repeats). `group` is kept as
  sugar that lowers to the same edges (a contiguous band ⇒ each member depends on everything before
  the band), and a test proves pre-existing frozen plans keep byte-identical semantics and their
  exact `planHash`. `id`/`dependsOn` join `canonicalPlanString` — and therefore `planHash` — only
  when set, so the graph is frozen like the rest of the plan. The final cumulative-acceptance phase
  on the ORIGINAL goal still runs after all phases, unchanged.
- The **defect corpus** — goaly's first CROSS-RUN feedback loop (issue #122). When a run's in-loop
  adjudication rules a frozen bar `CONTRACT_DEFECTIVE`, one compact, Zod-schema'd record is appended
  to `~/.goaly/defects.jsonl` (overridable with `--defect-corpus <path>`): the adjudicator's
  GENERALIZED anti-pattern and assertion shape, the language/test-runner derived from the FROZEN
  contract, and `contractHash` + `runId` for provenance — never source, never the diff, never the
  failure text. Later `--generate` runs inject the entries relevant to that workspace's
  language/runner into the contract-authoring prompt as a bounded "known false-red patterns — do not
  author these" section, and log which patterns were injected. The safeguards are STRUCTURAL: only an
  adjudicated defective verdict can mint an appendable record (nothing else type-checks against the
  append), the record builder has no input through which worker-supplied text could arrive, and the
  strict schema has NO field for iterations, duration, spend or severity — "this was hard" is
  inexpressible, so it can never become "author an easier bar". Fail-OPEN in every direction (a
  missing/corrupt/unparseable corpus, or a failed write, degrades to exactly the previous behavior),
  and a corpus-influenced contract still faces the critics, Seal, the pre-flight negative control,
  the frozen ladder and both keys. `goaly config defects list|clear` inspects/resets it;
  `--no-defect-corpus` opts out. Local only — nothing is uploaded or fetched.
- `--recontract` successor runs (issue #117): recovery from a `CONTRACT_DEFECTIVE` bar that keeps the
  tree. `goaly --from-run <runId> --recontract` — printed verbatim by the abort — starts a NEW run
  over the predecessor's working tree, inherits its FROZEN goal, and re-runs COMPILE with the defect
  report as authoring feedback (the same free-text channel a Seal "revise" uses), then freezes a NEW
  contract with a NEW `contractHash` under a NEW `runId`. No contract is ever mutated: invariant #2
  is strengthened — one run owns exactly one bar for its whole life and evolution happens BETWEEN
  runs, with provenance (`predecessorRunId`, `predecessorContractHash`, the adjudication verdict and
  the chain depth) recorded in the successor's log header and rendered by `goaly runs show`.
  Guarded: only a write-ahead, Zod-parsed `CONTRACT_ADJUDICATED { defective: true }` event can reach
  it (so the worker can never trigger it, and no worker-supplied text feeds the re-authoring — the
  adjudicator's report is itself fenced as untrusted data); a re-authored bar that ALREADY passes on
  the inherited tree faces a new fail-open pre-flight negative control before a worker token is spent
  (a weakened bar aborts `CONTRACT_UNSOUND`); and `--max-recontracts` (default 1) bounds the chain
  from the run log, so the cap holds across the chain rather than per process.
- In-loop contract-fault adjudication (`CONTRACT_DEFECTIVE`, issue #116). Contract soundness was
  otherwise classified exactly once, at t=0, on a tree with no implementation in it — the moment of
  least evidence, where an unsatisfiable frozen assertion and an honest "not written yet" red are
  indistinguishable. Now, when a `repeat-failure` streak is about to abort AND the repeated
  signature names one of the contract's frozen authored files AND the worker has demonstrably
  changed the tree, the run makes ONE read-only LLM call asking whether any correct implementation
  could pass that check. A confident "no" relabels the abort as `CONTRACT_DEFECTIVE` — naming the
  frozen file and stating that the implementation may be correct and the tree is worth keeping —
  instead of pointing at `--stuck-repeat-threshold`, which cannot help. Everything else (no
  adjudicator, an LLM error, an unparseable verdict, any uncertainty) keeps today's repeat-failure
  abort byte-for-byte. Bounded to once per run, write-ahead logged as a Zod-parsed
  `CONTRACT_ADJUDICATED` event so `--resume` reuses the verdict and never re-calls the model, and
  metered against `--budget-tokens`. Diagnosis only: the path can never reach DONE, never produces
  a green, and never re-authors the frozen contract. The reducer stays pure — DECIDE emits an
  `ADJUDICATE_CONTRACT` command and the Driver performs the call.
- Compile-time positive control (`--contract-dry-run`, on by default under `--generate`): before the
  contract is frozen, the compiler also authors a throwaway reference implementation, materializes
  it in a scratch copy of the workspace beside the authored verification files, and runs the
  contract's deterministic rungs there. Green freezes the contract unchanged; red refuses the freeze
  and feeds the failure into the existing bounded re-author loop (`--max-compile-retries`). The
  reference implementation is written only to the scratch copy, which is destroyed on every exit
  path — it never reaches the workspace, the run diff, or any worker prompt, and never appears in
  the re-author feedback. Fail-open on any infrastructure error (no LLM, scratch failure, a setup
  that cannot run there, a timed-out or unstartable rung), so it can only reject a defective bar or
  step aside. Judge rungs are out of scope; a user-supplied `--verify-cmd` is never dry-run.
- Named presets: a `"presets"` block in any config layer defines your own flag bundles, selected
  per run with `--preset <name>` or persistently via a top-level `"preset"` selection (announced
  on every run; `--preset none` disables it for one invocation). One language- and
  toolchain-neutral preset ships built in — `default` (`{ "mode": "hands-off" }`, verification
  via the `--generate` fallback, so it works in any repo) — and a config layer may redefine it
  wholesale. Presets expand at parse time like `--mode` — implied default < config base keys <
  chosen preset < `--mode` < explicit CLI flags, every expansion and override logged — and may
  themselves set `mode`. `goaly config presets [--names]` lists the resolved set (built-in
  included); shell completion completes `--preset` values live; `goalyrc.schema.json` covers the
  new keys; `goaly config validate` reports presets alongside settings.

### Changed
- **A bare `goaly "<goal>"` now runs hands-off.** When a run chooses neither a preset nor a mode,
  the built-in `default` preset applies implicitly — the contract is still compiled, frozen, and
  logged, but auto-accepted at Seal, with `--harness-autonomy medium` and `--delta-verify`. The
  implied tier is the weakest there is: it fills gaps only (any config-file key or explicit flag
  wins), never injects `candidates` (goal-directive delegation keeps working), and is announced
  on every run with its off-switches. Opt out per run with `--preset none`, per tree with
  `"preset": "none"`, or pin the old interactive behavior with `--mode review` / `"mode":
  "review"` in `.goalyrc`.
- Non-git workspace support via `--workspace-mode git|file|auto` (default `auto`). File mode uses a
  content-addressed manifest and stores baseline snapshots under `.goaly/baselines/`, so goaly can
  run in a plain directory without `git init`. See ADR 0018.
- `goaly doctor`: a read-only environment report (Node floor, git + workspace mode, harness CLIs
  on PATH, `.goalyrc` presence/validity, optional `--base-url` endpoint probe) with one actionable
  line per check.
- `goaly init`: writes a starter `.goalyrc` (harness, autonomy, model, verify-cmd) — interactive
  on a TTY, headless with flags or `--yes`; runs doctor first, validates through the same schema
  every run parses, never overwrites without `--force`.
- A JSON Schema for `.goalyrc` (`goalyrc.schema.json`, generated from the Zod shape by
  `npm run gen:schema`, shipped in the tarball and `dist/`) for editor auto-completion, plus
  `goaly config validate <path>` for the fail-closed run-path verdict. A drift test keeps the
  schema in lock-step with the code.
- `goaly completion bash|zsh|fish`: tab-completion scripts covering every subcommand and every
  documented flag, extracted from the `goaly help` contract so they cannot lag the docs.
  Install: `source <(goaly completion bash)`.
- Autonomy profiles: `--mode review|hands-off|aggressive` (also a `.goalyrc` key) expands at parse
  time into explicit flags — `review` keeps a human at every gate (and drops a persisted
  `autonomous`), `hands-off` is autonomous-but-conservative, `aggressive` adds adversarial review,
  best-of-3, and stuck self-recovery. Explicit flags override profile defaults with a logged notice.
- `--auto-remediate-stuck` (default off; part of `--mode aggressive`): bounded stuck self-recovery
  in the pure reducer — a no-diff turn gets a canned change-your-approach hint and its iteration
  refunded, a repeat-failure or harness-crash streak gets exactly one extra attempt; max 3 per run,
  never for `CONTRACT_UNEVALUABLE`/budget/oscillation; every spend is logged loudly and counted in
  the abort reason.
- Two new CI gates: a file-size gate (`npm run check:sizes` — the 800-line limit, with a
  shrink-only ratchet for three grandfathered files) and a docs-sync gate (`npm run check:docs` —
  every documented flag and config key must appear in `docs/reference.md`). The publish workflow
  now refuses to release a version with no `CHANGELOG.md` entry.

### Changed
- `src/cli/args.ts` was split into focused modules: the `USAGE` text lives in `src/cli/usage.ts`
  and the flag-group parsers in `src/cli/flags/` (tokenizer, harness/model, budget/limits,
  review-panel, sandbox, misc, subcommands). Public imports from `args.ts` are unchanged. A new
  CI gate (`scripts/check-file-sizes.mjs`) enforces the 800-line file limit with a shrink-only
  ratchet for the three pre-existing oversized files.
- The browser UI (`src/ui/web/`) is now covered by real DOM tests (happy-dom): the API client's
  CSRF header and error paths, the SSE subscription lifecycle, the session inspector's
  tool-pairing and filters, the dashboard/worktrees views, the launch console's request shape,
  and the Seal modal's gate answering.
- The `fake` harness is no longer shown in public help/error hints; it remains available as a
  test-only stub.
- `npm run dev` / `npm test` / `npm run coverage` now unset `NO_COLOR` when `FORCE_COLOR` is set,
  removing the `tsx`/`vitest` color-conflict warning that hid real diagnostics.

## [0.2.4] - 2026-08-07

### Added
- Cooperative parallel phases (`--parallel-phases`, experimental).
- Named worktrees (`goaly worktree create/list/remove`).
- Local web UI (`goaly ui`).
- Natural-language parallel delegation onto best-of-N tournaments.
- `--llm-provider` default follows `--harness` so `--generate` uses the tool the user picked.

### Changed
- Simplified README + reference split.

## [0.2.3] - 2026-07-10

### Added
- Auto-pin the review baseline when harness autonomy is raised, so agent commits stay visible to
  both keys.
- Web UI redesigned as a control center: mission dashboard, live pipeline, session inspector.

### Fixed
- Eight issues found driving a real from-scratch build.

## [0.2.2] - 2026-07-05

### Added
- Adversarial review (`--adversarial`, experimental): plan critics, contract red-team, and a
  refuter rung on every green ladder.
- Sign-off approver panels (`--approver-quorum`, `--approver-models`, `--approver-lenses`).
- Small-model compiler steering: detected workspace facts, pre-freeze load lint, actionable
  usage-gate feedback.

### Changed
- Authoring revise rounds resume the author's own CLI session; approver/refuter panels early-exit
  once the outcome is settled.

### Security
- Never trust the ambient `CLAUDE_CODE_SESSION_ID` as a resumable session; goaly mints its own
  session per authoring lifecycle.

## [0.2.1] - 2026-06-28

### Added
- `--explain`: a plain-language run narrator, plus a glossary appendix in the docs.
- Follow-ups: `--from-run`, `--inherit-session`, and `goaly runs resume-cmd`.

### Fixed
- Catch a non-compiling frozen verifier on a from-scratch tree before the loop starts.

## [0.2.0] - 2026-06-27

### Added
- `goaly-code`: the first non-codec harness — goaly's own agent loop against any OpenAI-compatible
  endpoint.
- Training pipeline slices 2–3: labeled trajectories, SFT dataset, eval bench (experimental).

## [0.1.3] - 2026-06-23

### Added
- Workspace checkpoints + configurable diff baseline (`--baseline`).
- Harness idle-timeout (`--harness-idle-timeout-ms`) and the artifact-running smoke rung
  (`--smoke`).
- Rubric guardrails, compile retries, git-exclude hygiene, veto-safe no-diff detection.

### Fixed
- Run the agent CLI inside `--workspace`; show untracked file content in diffs.

## [0.1.2] - 2026-06-21

### Added
- Selectable models per step (`--model`, `--llm-model`, `--judge-model`, …).

### Fixed
- The codex harness adapter against the current codex CLI.

## [0.1.1] - 2026-06-21

### Added
- Initial public release: harness-agnostic goal orchestration with a frozen success contract,
  two-key DONE (verifier + approver), a pure synchronous reducer, a write-ahead run log, and
  interactive contract revision at the Seal. GitHub-driven npm releases; MIT license.
