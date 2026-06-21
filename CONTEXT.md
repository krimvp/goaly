# CONTEXT — Ubiquitous Language

The shared vocabulary of the goal-orchestration layer. One term, one meaning. Each entry
lists what the term is **not**, because the cheapest bugs to prevent are vocabulary bugs.

- **Goal** — the natural-language objective for one run. _avoid:_ a test; a prompt.
- **Contract** (`CompiledContract`) — the **frozen** definition of "done": an ordered ladder
  of rungs + a rubric + a `contractHash`. Authored once, approved at Gate A, never rewritten.
  _avoid:_ the goal; the config; something the worker can edit mid-loop.
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
- **Gate A** — the contract gate: a human (default) or auto-accept (`--autonomous`) approves
  the frozen contract **once** before the loop. _avoid:_ per-iteration approval.
- **Gate B** — the result gate: the independent **Approver**, every iteration, **veto-only**.
  _avoid:_ Gate A; a promoter (it can never turn a red into a green).
- **Two Keys** — DONE requires both keys to turn: the frozen verifier passes **and** the
  approver doesn't veto. _avoid:_ "tests pass ⇒ done".
- **Harness** — a coding agent run headlessly (Claude Code, Codex, …). _avoid:_ the model; the
  agent; the orchestrator.
- **Adapter** — the one-method `run(prompt, sessionId?)` wrapper over a harness. _avoid:_ a
  place where verification or diffing happens (those live in the Workspace).
- **Driver** — the imperative effect interpreter: performs Commands, feeds Events back,
  persists write-ahead. The only thing that touches a clock, budget, process, or disk.
  _avoid:_ the place where policy lives.
- **Orchestrator** — the pure reducer `step(state, event) -> [state, Command[]]`. Holds no
  adapters, returns no Promise. _avoid:_ anything that calls an LLM or reads a clock.
- **DECIDE** — the pure truth table mapping (ladder verdict, approval, stuck, iteration) to
  CONTINUE / DONE / FAILED / ABORTED. _avoid:_ a place that runs effects.
- **diffHash** — a non-mutating content hash of the working tree, computed by the **Workspace**
  (not the adapter). Drives stuck detection. _avoid:_ a commit; an adapter responsibility.
- **Stuck** — a pre-`maxIterations` bail with a reason: no-diff, repeat-failure, oscillation,
  or budget. _avoid:_ a normal failure (that's FAILED).
- **Autonomous** — the flag that moves **Gate A only** (auto-accept). It skips the human pause,
  never the freeze. _avoid:_ "the agent rewrites its own test"; skipping verification.
- **Command** — data describing an effect the Driver must perform. Never persisted.
- **Event** — the resolved result of a Command, fed to the reducer. Persisted write-ahead.
- **Run Log** — the append-only, write-ahead event stream; the source of truth for replay and
  resume. _avoid:_ a debug log.
