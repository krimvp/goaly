---
name: work-on-issue
description: >-
  Pick up and resolve a goaly GitHub issue the right way. Verifies the issue's claim BEFORE writing
  code — replicate a bug, or confirm a feature/enhancement is actually wanted and pointed in the
  intended direction (a valid outcome is "not planned"; don't build for the sake of building). Then
  fixes/builds test-first: a bug fix ships with a regression test that reproduces it; a feature ships
  with tests that pin the new behavior so it can't regress. Use when the user says to work on / fix /
  implement / pick up an issue or PR for this repo.
---

# Work on a goaly issue

The bar in this repo is correctness under adversarial self-interest, so the workflow front-loads
*verification of the claim* and *test-first* implementation. Read [`AGENTS.md`](../../../AGENTS.md)
(the eight invariants + definition of done) before touching code.

## Step 1 — load & classify

`gh issue view <n>` (add `--comments`). Identify the type (bug / feature / enhancement / harness /
discussion) and the seam(s) it touches.

## Step 2 — verify the claim (the gate before any code)

Do not start coding until the issue is verified. This gate can legitimately **end** the work.

- **Bug** → **replicate it first** (same discipline as the `log-issue` skill: `fake` harness +
  `--verify-cmd` + `--autonomous` for orchestration bugs, a throwaway dir, redact secrets/ids).
  - Reproduced → you now have the exact failing behavior to fix and to lock in a test.
  - **Can't reproduce** → do **not** "fix" blindly. Comment on the issue with what you tried and ask
    for the missing repro (version, command, environment), or close as `invalid`/needs-info with a
    rationale. A bug you can't reproduce isn't ready to fix.

- **Feature / enhancement** → **confirm the behavior is actually wanted and the direction is right.**
  This is an explicit checkpoint, not a rubber stamp:
  - Does it fit goaly's mission (deterministic, harness-agnostic, frozen-contract,
    anti-reward-hacking)? Does it respect the eight invariants?
  - If the direction is unclear or seems off, **ask the user/maintainer before building.** Use
    `AskUserQuestion` to confirm scope/direction when there's a real fork.
  - A valid outcome is **"don't build it"** — defer or close as `wontfix` / not-planned (or convert
    to a `discussion`) with a clear reason. We do not build for the sake of building.

- **Invariant check up-front.** If the issue *as written* would weaken an invariant (e.g. a green
  slipping past the verifier ladder, the contract changing after Seal, DONE on one key, an adapter
  that throws, an unparsed seam), surface it now and reshape the scope so the invariant holds. The
  fix is "add a test / change the design", never "relax the invariant".

## Step 3 — plan & implement test-first

Follow the repo's TDD order and conventions (see `AGENTS.md`). Prove policy with fakes before
spawning any subprocess.

- **Bug fix:** write a **failing test that reproduces the bug** (red) → make it pass (green) →
  refactor. That regression test is the deliverable that keeps the bug from coming back.
- **Feature / enhancement:** write tests that **specify and pin the new behavior** first, then
  implement until green. The tests are the guarantee against future regression.
- Honor the conventions: keep `src/orchestrator/` pure & synchronous (emit a `Command`, don't do
  IO); parse external data at the seam with Zod and **fail-closed**; make `exec`/`llm` injectable; no
  `console.log` in library code; small files/functions; immutability.

## Step 4 — definition of done (non-negotiable)

- `npm run typecheck` clean **and** `npm test` green.
- New behavior covered by the test(s) from Step 3; none of the eight invariants weakened.
- If the change alters the architecture, the public/embeddable API, or user-facing functionality:
  update [`README.md`](../../../README.md) **and** the landing page
  [`docs/index.html`](../../../docs/index.html) in the same change — and
  [`docs/adding-a-harness.md`](../../../docs/adding-a-harness.md) if the harness-authoring pattern
  changed. This is a gate, not optional.

## Step 5 — ship

- Branch off `main` (never commit directly to `main`); commit only when the user asks.
- Conventional commits (`feat:`, `fix:`, `enhance:`→`refactor:`/`feat:`, `docs:`, `test:`, `chore:`).
  End commit messages with the required `Co-Authored-By` trailer.
- Open a PR using [`.github/PULL_REQUEST_TEMPLATE.md`](../../../.github/PULL_REQUEST_TEMPLATE.md);
  link the issue (`Fixes #<n>`). A PR that touches the reducer must explain how purity and the
  two-key invariant are preserved.

## Related

- **`log-issue`** — the filing side; shares the bug-replication discipline.
- **`investigate-harness`** — use it when the issue is a new harness adapter.
