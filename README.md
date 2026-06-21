# goalorch

A **harness-agnostic goal-orchestration layer**: run a coding agent repeatedly until a goal is
*verifiably* achieved, with a deterministic thin layer in control and a **frozen** success
criterion the agent can't weaken mid-loop.

> The anti-reward-hacking core: "until the goal is achieved" must not collapse into "until the
> agent weakens its own test." goalorch compiles the success contract **once**, freezes it, and
> requires **two independent keys** — a frozen verifier *and* an independent approver — before
> declaring a run DONE.

See [`DESIGN.md`](DESIGN.md) (what & why), [`ARCHITECTURE.md`](ARCHITECTURE.md) (how),
[`CONTEXT.md`](CONTEXT.md) (glossary), and [`docs/adr/`](docs/adr) (decisions).

## How it works

```
COMPILE_VERIFIER → [Gate A: contract approval] → loop {
    RUN_AGENT → verifier ladder → [Gate B: result approval] → DECIDE
} → DONE | FAILED | ABORTED
```

- The **control flow has zero LLM calls.** A pure reducer `step(state, event) -> [state, Command[]]`
  owns all policy; an imperative Driver performs the effects it requests. Everything stochastic
  (running the agent, judging, approving) hides behind boolean/value interfaces at four real seams.
- The **verifier ladder** runs cheapest-and-hardest-to-game first: deterministic checks (exit codes,
  tests) before any LLM judge, short-circuiting on the first deterministic fail. A rung that errors is
  **fail-closed** — a malformed grader is never a green.
- **Two keys for DONE:** the frozen verifier passes *and* the independent approver (Gate B, veto-only)
  doesn't veto.
- **Stuck detection** bails before `maxIterations` with a reason: no-diff, repeat-failure, oscillation,
  budget.
- **Write-ahead run log** under `.goalorch/<runId>/` makes every run replayable and **resumable**.

## Install

Install it as a standalone CLI (builds `dist/`, then puts `goalorch` on your PATH):

```bash
make install        # == npm install -g .  (the `prepare` hook bundles dist/ first)
goalorch help
```

Or build a redistributable tarball, or install from source by hand:

```bash
npm install         # install deps (also bundles dist/ via the `prepare` hook)
npm run build       # bundle the standalone CLI + type declarations into dist/
npm install -g .    # put `goalorch` on your PATH
make pack           # -> goalorch-<version>.tgz, installable with `npm i -g ./goalorch-*.tgz`
```

Requires Node ≥ 20 and `git`. The default adapters shell out to the `claude` / `codex` / `droid`
CLIs; the LLM judge/approver use a CLI-backed provider by default.

> Add `.goalorch/` to your target repo's `.gitignore`. (goalorch also excludes it from its own
> tree-hash, so its run logs never pollute stuck-detection regardless.)

## Usage

```bash
# Point at an existing test command; a human approves the frozen contract once:
goalorch run --goal "make the parser handle empty input" --verify-cmd "npm test"

# Let the agent author the verification, and run unattended (contract still frozen + logged loudly):
goalorch run --goal "add a /health endpoint returning 200" --generate --autonomous

# Choose a harness, cap iterations, set a budget, resume a crashed run:
goalorch run --goal "..." --verify-cmd "pytest -q" --harness codex --max-iterations 8 \
             --budget-tokens 500000 --workspace ./myrepo
goalorch run --goal "..." --resume run-<id> --workspace ./myrepo
```

`goalorch help` lists every flag. Exit codes: `0` DONE, `1` FAILED/ABORTED, `2` usage error.

### Adding a harness

A new harness is **one file** implementing one method:

```ts
interface HarnessAdapter {
  readonly name: string;
  run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult>;
}
```

`diffHash` and verifier execution live in the shared `Workspace`, not the adapter — so stuck-detection
and verification work on any harness for free.

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

## Embedding

The library works headless; the CLI is a thin caller. Import from the package root:

```ts
import { drive, composeDeps, freezeContract, type DriverDeps } from 'goalorch';
```
