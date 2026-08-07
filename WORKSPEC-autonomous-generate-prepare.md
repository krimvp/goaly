# Work spec — make the prepare phase robust for autonomous `--generate` from-scratch runs

> **Status:** scoped / ready to implement. Discovered empirically (see §1). Self-contained: a fresh
> session can implement from this doc alone.
> **One-line:** goaly's one-time *prepare phase* (Fix #1 setup + Fix #2 pre-flight soundness) assumes
> an **existing** project; on a **from-scratch `--generate --autonomous`** run it kills the run at
> iteration 0 — before the agent writes a single line — via `SETUP_FAILED` or `CONTRACT_UNSOUND`. Make
> it from-scratch-aware so autonomous generation actually gets to code.
> **Why it matters:** autonomous `--generate` is the headline mode for the goaly-code / trained-model
> arc. Today it is fragile exactly where it should be strongest.

---

## 1. The evidence (what was observed)

A 9-model bake-off ran the **same hard from-scratch goal** — "build a Go (stdlib-only) MCP server for
a co-op Minesweeper game + live web UI" — two ways:

- **Round A** — hand-written deterministic `--verify-cmd` (a `verify.sh` that builds + runs + probes
  the server), no `--generate`, no setup. **Result: 7/9 DONE.** (opus, sonnet, haiku, kimi, qwen,
  deepseek-v4-pro, gpt-oss all built working servers; glm-5.2 + devstral were still running when an
  unrelated reboot interrupted them.)
- **Round B** — `--generate --autonomous` (goal only; goaly's compiler authors the verification +
  judge/approver grade it), bumped iterations/timeouts, each model self-consistent (claude harness →
  claude LLM steps; Ollama harnesses → `--llm-provider openai` with the same model).
  **Result so far: 0 DONE.** The failure spread:

| model | Round B outcome | mechanism |
|---|---|---|
| deepseek-v4-pro | FAILED · `SETUP_FAILED` (it 0) | compiler authored setup `go mod download`; exits 1 on empty tree → fatal |
| haiku | FAILED · `SETUP_FAILED` (it 0) | same `go mod download` |
| qwen3-coder:480b | FAILED · `CONTRACT_UNSOUND` (it 0) | authored rung `go build && go vet && run server`; red on empty tree → soundness classifier ruled it broken |
| devstral-2:123b | FAILED · `CONTRACT_UNSOUND` (it 0) | authored `go build && run server`; same misclassification |
| glm-5.2 | ABORTED · `no-diff` (it 1) | cleared prepare, but the **agent wrote no code** on iter 1 (see §6 — out of scope) |
| opus / sonnet / kimi / gpt-oss | (in flight at time of writing) | — |

Verbatim failure reasons (for the implementer):
- `SETUP_FAILED: the workspace setup command failed before any agent turn — `go mod download` exited 1`
- `CONTRACT_UNSOUND: the frozen verification could not run against the prepared tree … The verification
  failed due to missing standard library packages and an unresolved package import, indicating the Go
  environment or module setup is broken rather than the implementation being incomplete.`

The models are *capable* (Round A proves it). The fragility is **specific to the autonomous-generate
prepare phase**, not raw ability.

---

## 2. Root cause (grounded in the code)

Everything happens in `prepareWorkspace()` (`src/driver/prepare.ts`), which the Driver runs once
**after Seal, before iteration 1**, against the **initial** working tree. For an existing repo that's
correct. For a from-scratch `--generate` build the initial tree is essentially empty (a seed
`README` + the compiler's authored `generatedFiles`), so:

1. **Setup is fatal-on-failure regardless of provenance.** `runSetup()` (`prepare.ts:143`) returns
   `status:'setup-failed'` on any non-zero exit. Under `--generate` the **compiler authored** the
   setup (`go mod download`) — `src/compile/agent-compiler.ts` instructs it to put deps prep "in
   `setup` (e.g. `npm ci`, `pip install -r requirements.txt`, `go mod download`)". That command
   presupposes scaffolding (`go.mod`) that does not exist yet, so it exits 1 and the run dies before
   the agent can `go mod init`. A *user-supplied* `--setup-cmd` failing fatally is correct; a
   *compiler-guessed* one is not.

2. **The soundness preflight runs on an empty tree and misreads "no scaffold yet" as "broken
   verifier".** `preflightDeterministic()` (`prepare.ts:173`) runs the authored deterministic rung
   once; on an empty tree `go build ./...` is red. It then calls `classifyPreflightSoundness()`
   (`src/driver/preflight-soundness.ts`). That classifier's `SYSTEM_PROMPT` lists *"a missing
   tool/dependency that prevents the checks from ever executing"* as `brokenVerification=true`. Go's
   "package not in std / unresolved import" errors (caused by a **missing module**, not a missing
   tool) match that clause, so it ruled the contract broken → `CONTRACT_UNSOUND` → abort at iteration
   0. But a missing dependency **manifest** the implementation is expected to create (`go.mod`) is
   **agent-fixable**, unlike a defect inside the frozen verification files.

**Meta-cause:** the prepare phase has no notion of "from-scratch." On an empty tree there is nothing
to bootstrap and nothing sound to pre-flight — the bar is red *by definition* and the agent must
scaffold first.

No flag-only workaround exists: `--no-setup` would rescue the two `SETUP_FAILED` cases but **not** the
two `CONTRACT_UNSOUND` ones (the preflight has no disable flag).

---

## 3. The fix (two changes, both invariant-preserving)

### Fix A — authored setup is best-effort (non-fatal); user setup stays fatal

- **Provenance.** Today `CompiledContract.setup` (`src/domain/contract.ts:60`) is a bare string with
  no authored-vs-user flag. The `PREPARE_WORKSPACE` command (`src/domain/events.ts`, `Command` union)
  already carries `installMissingTools: boolean` as pure wiring — **mirror that**: add
  `setupAuthored: boolean` to the `PREPARE_WORKSPACE` command, derived in the **pure reducer**
  (`src/orchestrator/step.ts`) when it emits the command. Derivation: `setupAuthored =
  contract.setup !== undefined && <user did NOT supply --setup-cmd>`. Confirm `RunConfig`
  (`src/domain/config.ts`) exposes the user's setup intent; if it doesn't, thread a thin
  `userSetup?: boolean`/keep the raw user setup separately at the compile seam. **Do not** add
  provenance to the frozen contract if it can be derived as wiring — keep the contract = "what done
  means," and provenance = "how to prepare" (avoids `contractHash` churn).
- **Behavior.** In `prepareWorkspace`/`runSetup`: when setup fails **and** `setupAuthored === true`,
  **log loudly (warn)** and return `{ status: 'proceed' }` instead of `setup-failed`. Thread the
  failed command into the agent's first prompt as a hint (reuse the `installTools` threading pattern —
  add an optional `setupHint?: string` to the `proceed` variant of `PreparedOutcome`,
  `src/domain/events.ts:53`, surfaced in the first prompt the way `installTools` is). When
  `setupAuthored === false` (user `--setup-cmd`), keep today's fatal `setup-failed`.
- **Invariants:** contract still frozen; `--autonomous` still only moves Seal; the two keys still gate
  DONE; fail-closed preserved for user setup. An authored-setup failure now degrades to *proceed* —
  the agent + the fail-closed ladder still govern correctness, so no wrong-green is possible.

### Fix B — don't (mis)abort the soundness preflight on a from-scratch tree

- **B1 (structural, primary).** In `preflightDeterministic()`, before running the rung/classifier,
  detect a **from-scratch** tree and return `{ status: 'proceed' }` (a red is definitionally
  "implementation missing"). Needs an emptiness signal — see §4. This is the robust gate.
- **B2 (classifier refinement, complementary).** Tighten the `SYSTEM_PROMPT` in
  `preflight-soundness.ts`: a **missing dependency manifest/module the implementation is expected to
  create** (`go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `tsconfig`, …) is
  `brokenVerification=false` (agent-fixable). Reserve `true` for defects **inside the frozen
  verification files themselves** (a syntax/collection/import error in an authored test). Add an
  explicit worked example to the prompt. B2 alone is LLM-dependent; ship B1 + B2 together.
- **Invariants:** the preflight is already advisory / fail-open (`prepare.ts:188-193`, and the
  fail-OPEN design note in `preflight-soundness.ts`). Skipping on from-scratch only ever *proceeds* —
  the real ladder runs fail-closed every iteration and a genuinely broken frozen verifier is still
  caught generically by `STUCK_REPEATED_FAILURE`. So B1 cannot turn a real defect into a green.

---

## 4. Detecting "from-scratch" (shared signal for B1)

Add a small, conservative, language-agnostic capability to the `Workspace` seam
(`src/workspace/workspace.ts` + `git-workspace.ts` + the `FakeWorkspace` in `src/testing/fakes.ts`):

```ts
// True when the tree has no implementation source yet — only docs + the compiler's authored files.
isEmptyOfSource(generatedFiles: readonly string[]): Promise<boolean>;
```

- **GitWorkspace** impl: list candidate files via `git ls-files --cached --others --exclude-standard`
  (respecting the existing excludes, e.g. `.goaly`), then subtract: `generatedFiles`, and a small doc
  allowlist (`README*`, `LICENSE*`, `*.md`, `.git*`, `.goaly`). If **nothing** remains → from-scratch.
- Be **conservative**: only return `true` when there are *zero* candidate source files, so an existing
  project is never mistaken for from-scratch (which would wrongly skip a legitimate soundness check).
- Reuse for Fix A is optional — A's provenance fix already handles the setup case; B genuinely needs
  this signal.

---

## 5. Files to touch (checklist)

- `src/driver/prepare.ts` — `runSetup` provenance-aware (Fix A); `preflightDeterministic` from-scratch
  guard (Fix B1).
- `src/driver/preflight-soundness.ts` — `SYSTEM_PROMPT` refinement + example (Fix B2).
- `src/domain/events.ts` — `PREPARE_WORKSPACE` command gains `setupAuthored: boolean`; `PreparedOutcome`
  `proceed` variant optionally gains `setupHint?: string`.
- `src/orchestrator/step.ts` (+ `decide.ts` if relevant) — emit `setupAuthored` on `PREPARE_WORKSPACE`,
  derived purely from config + contract. **Keep the reducer pure/synchronous (invariant #1).**
- `src/domain/config.ts` — confirm/expose the user-supplied-setup signal for the derivation.
- `src/workspace/workspace.ts`, `git-workspace.ts`, `src/testing/fakes.ts` — `isEmptyOfSource()`.
- `src/driver/driver.ts` — thread `setupAuthored` into `PrepareDeps`/`prepareWorkspace`; first-prompt
  hint wiring (alongside `installTools`).
- Compose/CLI only if a new flag is wanted (NOT required — no new flag needed).

---

## 6. Out of scope (document, do NOT fix here)

The **`no-diff` abort** (glm-5.2: cleared prepare, but the agent produced no implementation on
iteration 1 → no-diff stuck abort). That is model/harness-loop behavior, not the prepare phase, and
the no-diff detector behaved correctly. *Possible* follow-up (separate investigation): consider a
one-turn grace for a first-iteration no-diff under from-scratch `--generate` (mirroring issue #54's
fresh-veto exemption) — **only** if it can be done without weakening stuck detection. Leave it out of
this change.

---

## 7. Test plan (TDD — prove with fakes, zero network)

- **`src/driver/prepare.test.ts`**
  - authored setup fails + `setupAuthored:true` → `proceed` (not `setup-failed`); assert the warn log
    and the threaded `setupHint`.
  - user setup (`setupAuthored:false`) fails → still `setup-failed` (regression).
  - from-scratch tree (`isEmptyOfSource → true`) + red deterministic rung → `proceed` **without**
    calling the classifier (assert the injected `FakeLlm` was **not** invoked).
  - existing project (`isEmptyOfSource → false`) + red rung + classifier `broken:true` → still
    `contract-unsound` (regression).
  - existing project + red rung + classifier `broken:false` → `proceed` (regression).
- **`src/driver/preflight-soundness.test.ts`** — feed a "missing go.mod / package not in std" detail →
  `broken:false` (B2); feed a real authored-test syntax/import error → `broken:true` (regression).
- **`src/workspace/git-workspace.test.ts`** — `isEmptyOfSource` true on a README-only / generated-only
  tree; false once a real `*.go`/`*.ts` source file exists.
- **Integration** (`compose` + `drive`, fake harness + fake LLM): a from-scratch `--generate
  --autonomous` config whose authored contract has BOTH a setup and a build/test deterministic rung
  reaches the loop (no iteration-0 death) and a fake harness that writes a passing file drives it to
  DONE.
- Gates: `npm run typecheck` clean, `npm test` green, `npm run coverage` ≥ 80% (lines/branches/funcs).

---

## 8. Acceptance criteria

1. A from-scratch `--generate --autonomous` run whose compiler authors a `go mod download` (or any)
   setup **and** a `go build`-style deterministic rung **does not die at iteration 0** — it proceeds
   to the agent loop. (Re-running the §1 Round-B bake-off should eliminate the `SETUP_FAILED` and
   `CONTRACT_UNSOUND` iteration-0 deaths; capable models should then reach DONE or fail honestly
   *inside* the loop.)
2. A user `--setup-cmd` that fails still aborts `SETUP_FAILED` (fatal, unchanged).
3. Existing-project preflight still catches a genuinely broken frozen verifier (`CONTRACT_UNSOUND`).
4. All eight invariants intact; no wrong-greens introduced; reducer stays pure.

---

## 9. Docs to update (definition-of-done gate, per `AGENTS.md` → "Keep the docs in sync")

- `README.md` — the prepare-phase description (setup + pre-flight), and a note that under `--generate`
  an authored setup is best-effort while `--setup-cmd` is enforced; mention from-scratch behavior.
- `docs/index.html` — if it depicts the prepare/setup/pre-flight step, reflect the new behavior.
- `AGENTS.md` — only if the invariant notes around fail-closed/prepare need a clarifying line.
- **ADR** — add `docs/adr/00NN-prepare-from-scratch.md`: the decision that the prepare phase is
  from-scratch-aware (authored setup non-fatal; soundness preflight skipped on an empty tree), with
  the invariant-preservation argument.

---

## 10. Supporting references

- Prepare orchestration: `src/driver/prepare.ts` (`prepareWorkspace`, `runSetup:143`,
  `preflightDeterministic:173`, classifier gate `:200-216`).
- Soundness classifier + its fail-OPEN design + the offending `brokenVerification=true` clause:
  `src/driver/preflight-soundness.ts` (`SYSTEM_PROMPT`).
- Contract `setup` field + `generatedFiles`: `src/domain/contract.ts:52-78`.
- Compiler setup instruction ("put deps prep in setup … go mod download"): `src/compile/agent-compiler.ts`.
- `PreparedOutcome` (`proceed`/`setup-failed`/`contract-unsound`/`tools-missing`) + `PREPARE_WORKSPACE`
  command (`installMissingTools` pattern to mirror): `src/domain/events.ts`.
- The `--no-setup` flag and the existing setup hint (exit 127): `src/cli/args.ts`, `prepare.ts:133`.
