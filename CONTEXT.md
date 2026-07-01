# CONTEXT — Ubiquitous Language

The shared vocabulary of the goal-orchestration layer. One term, one meaning. Each entry
lists what the term is **not**, because the cheapest bugs to prevent are vocabulary bugs.

> This is the terse **contributor** reference (noun-by-noun, with anti-definitions). For a
> **plain-language** walkthrough of the same concepts and the cross-cutting idioms — fail-closed,
> fail-open, reward-hacking, the two keys, write-ahead, stuck detection — with links to read more,
> see the **[Glossary appendix in the README](README.md#appendix-glossary)**.

- **Goal** — the natural-language objective for one run. _avoid:_ a test; a prompt.
- **Contract** (`CompiledContract`) — the **frozen** definition of "done": an ordered ladder
  of rungs + a rubric + a `contractHash`. Authored once, approved at Seal, never rewritten.
  _avoid:_ the goal; the config; something the worker can edit mid-loop.
- **Config views** — `RunConfig` is one flat object read by LIFETIME through four `Pick<>` views, so
  each seam is handed only what it may read: **ContractInput** (authored once into the frozen Contract:
  goal/verifier/smoke/setupCmd/noSetup/rubric/judge — the compiler takes only this), **GatePolicy**
  (pre-loop human-gated bounds: autonomous + the Seal/compile/plan revise caps), **LoopPolicy** (the
  reducer's operational policy: maxIterations/stuckPolicy/budget/phased/maxPhases/installMissingTools),
  **DriverWiring** (diffIgnore/deltaVerify — never the contract, never the reducer's decision). The four
  partition the config with no orphan. _avoid:_ reading a loop/wiring knob from the compiler; hashing a
  wiring field into the contract.
- **Verifier** — anything satisfying `verify(workspace, goal, rubric) -> Verdict`. Could be an
  exit code, a test run, an LLM quorum, or the Ladder itself. _avoid:_ the approver (separate
  seam); the harness.
- **Rubric** — the frozen judging criteria for the LLM-judge portion. _avoid:_ free-form
  "looks good"; anything regenerated per iteration.
- **Verdict** — `{ pass, confidence, detail }`. The state machine cannot tell which kind of
  verifier produced it. _avoid:_ an approval; a raw exit code.
- **Ladder** — the composite Verifier: rungs run cheapest-and-hardest-to-game first
  (deterministic before judge), short-circuiting on the first deterministic fail. A rung that
  errors is **fail-closed** (`pass:false`). _avoid:_ a list the orchestrator iterates itself.
- **Seal** — the contract gate: a human (default) or auto-accept (`--autonomous`) approves
  the frozen contract **once** before the loop. _avoid:_ per-iteration approval.
- **Sign-off** — the result gate: the independent **Approver**, every iteration, **veto-only**.
  _avoid:_ Seal; a promoter (it can never turn a red into a green).
- **Two Keys** — DONE requires both keys to turn: the frozen verifier passes **and** the
  approver doesn't veto. _avoid:_ "tests pass ⇒ done".
- **Harness** — a coding agent run headlessly (Claude Code, Codex, …). _avoid:_ the model; the
  agent; the orchestrator.
- **Adapter** — the one-method `run(prompt, sessionId?)` wrapper over a harness. _avoid:_ a
  place where verification or diffing happens (those live in the Workspace).
- **Codec** (`AgentCliCodec`) — one deep module per coding-agent CLI holding all of its quirks in one
  place: its two argv dialects (`harnessArgs` write-mode + `readonlyArgs` read-only), its
  `fieldExtractor`/`streamExtractor`, its `promptOnStdin` flag, and its `classify` status policy. The
  single `codecFor(cli)` registry is the **one** name→codec map; **both** roles a CLI plays — the
  write-role Adapter (`AgentCliHarness`) and the read-only `LlmProvider` (`AgentCliLlmProvider`) —
  resolve through it, so a new CLI is one codec module + one registry entry. _avoid:_ the Adapter (a
  codec is what the generic adapter wraps, not a second adapter); a per-CLI wrapper in `compose`.
- **Driver** — the imperative effect interpreter: performs Commands, feeds Events back,
  persists write-ahead. The only thing that touches a clock, budget, process, or disk.
  _avoid:_ the place where policy lives.
- **Orchestrator** — the pure reducer `step(state, event) -> [state, Command[]]`. Holds no
  adapters, returns no Promise. _avoid:_ anything that calls an LLM or reads a clock.
- **DECIDE** — the pure truth table mapping (ladder verdict, approval, stuck, iteration) to
  CONTINUE / DONE / FAILED / ABORTED. _avoid:_ a place that runs effects.
- **diffHash** — a non-mutating content hash of the working tree, computed by the **Workspace**
  (not the adapter). Drives stuck detection. _avoid:_ a commit; an adapter responsibility.
- **Baseline** — the Driver-side module that owns the run's two diff baselines and the delta-verify
  checkpoint policy — "which diff does each key see, and when do we snapshot". The JUDGE/active
  baseline lives in the Workspace (advanced by `checkpoint()`); the APPROVER/cumulative baseline is held
  here, pinned to the run/phase start so Sign-off reviews the WHOLE change even when per-iteration
  checkpoints shrank the judge's diff. `--delta-verify` is read here (Driver wiring), never the reducer.
  _avoid:_ threading baselines through the loop by hand; letting the approver's diff scope vary silently.
- **Stuck** — a pre-`maxIterations` bail with a typed `{ kind, message }` reason — `kind` ∈
  `no-diff | repeat | oscillation | crash | unevaluable | budget` (`STUCK_HARNESS_CRASH` /
  `STUCK_REPEATED_FAILURE` / `CONTRACT_UNEVALUABLE` in the message). `unevaluable` fires on a streak of
  could-not-evaluate verdicts (`Verdict.evaluable === false`: the verify command couldn't run or the
  judge errored/overflowed) — a verification-environment failure, never mistaken for a code red and
  never discarding a possibly-correct tree. `detectStuck` is pure over the `LoopCtx` histories; **DECIDE** keys the one
  reason-specific excuse off `kind` (a `no-diff` abort is excused by a fresh, unseen Sign-off veto —
  the in-flight half it holds the verdict for). _avoid:_ a normal failure (that's FAILED); putting the
  fresh-veto excuse inside `detectStuck` (it needs the verdict, so it lives in DECIDE).
- **Autonomous** — the flag that moves **Seal only** (auto-accept). It skips the human pause,
  never the freeze. _avoid:_ "the agent rewrites its own test"; skipping verification.
- **Command** — data describing an effect the Driver must perform. Never persisted.
- **Event** — the resolved result of a Command, fed to the reducer. Persisted write-ahead.
- **Run Log** — the append-only, write-ahead event stream; the source of truth for replay and
  resume. _avoid:_ a debug log.
- **SandboxProfile** — the mechanism-agnostic per-seam isolation profile (`{ workspace, denyDirs,
  network: 'isolated' | 'proxied' | 'open', env?, proxy? }`), resolved ONCE (`resolveProfile`) at the
  composition edge. A **Launcher** (`bwrap`/`firejail`/`container`/`none`) only *translates* it into
  its own flag dialect — it decides no policy. _avoid:_ putting per-`$HOME`/network/proxy policy
  inside a launcher; it lives in the profile.
