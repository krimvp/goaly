# ADR 0017 — post-run landing: commit / merge / open a PR from the web UI

## Status
Accepted.

## Context

goaly's mission ends at **DONE**: a run is finished when the frozen success contract is verified
**and** approved (two keys, invariant #2). Everything *after* that — committing the work, merging it
back, opening a pull request — is deliberately **outside** the contract. A worktree run
([ADR 0013](0013-named-worktrees.md)) makes this especially sharp: runs never commit, so a finished
`--worktree` run leaves its changes **uncommitted** on branch `goaly/<name>`, and the only sanctioned
merge-back was the end-of-run hint (`git -C <worktree> add -A && git commit …`, then `git merge`).

The web UI ([ADR 0014](0014-local-web-ui.md)/[0015](0015-ui-owned-runs.md)) mirrored that boundary a
little too faithfully: it could start / stop / resume / Seal runs and create / remove worktrees, but
a **finished** run was a dead end. You could not even see what the agent produced, let alone ship it.
Concretely: a run whose goal literally said "…when done create an MR" finished DONE with the code
sitting uncommitted in its worktree and no MR — the verifier passed on the *code*, and the UI offered
no next step. Operators asked for a way to take a proven result and do something with it.

The tension: landing must **not** dilute the frozen contract (a merge/PR is not a success rung), it
touches an **outward-facing** action (a PR publishes to GitHub), and it runs **git** against a live
working tree — where two writers is never safe.

## Decision

Add an explicit **post-DONE landing** capability: a new `LandingManager` workspace module and a
**Landing panel** on a finished worktree run. It is a *sibling* of the mission, not part of it.

### `LandingManager` — a deep module over git, sibling to `WorktreeManager`

`src/workspace/landing.ts` lands the branch a worktree lives on. Same shape as `WorktreeManager`
(injectable `exec: ExecFn` + `isRunActive` seams; typed `LandingError` for every failure), and it
reuses `worktreeBranch(name)` / `WORKTREES_DIR`. Four operations:

- **`changes(name)`** (read-only) — the file list (`git status --porcelain`, excluding the
  worktree's own `.goaly`), the tracked diff (`git diff HEAD`, capped at `MAX_DIFF_CHARS = 100k`
  with a `truncated` flag), the ahead-of-main commit count, and whether a PR is even possible
  (`origin` exists **and** `gh` is on PATH). Untracked files are counted separately (their content
  isn't in `git diff HEAD` until committed).
- **`commit(name, message)`** — stage everything bar `.goaly`, commit on `goaly/<name>`; fail-closed
  on a clean tree (an empty commit is never what was meant).
- **`merge(name, {commitMessage?})`** — commit-if-dirty, then `git merge --no-ff goaly/<name>` into
  the **main** workspace. Refuses a dirty or busy main; on conflict it `git merge --abort`s and
  throws with the conflicted files, so **main is never left half-merged**.
- **`openPr(name, {title, body?, base?, commitMessage?})`** — commit-if-dirty → `git push -u origin`
  → `gh pr create`, returning the PR URL. Fail-closed with a precise message when there is no remote,
  `gh` is missing/unauthed, the push is rejected, or `gh` errors.

### The agent fills in the MR (`draftPr`)

Hand-typing the PR title/body is exactly the toil the loop exists to remove, so a **"draft with the
agent"** action (`src/llm/pr-draft.ts` → `draftPr(llm, {goal, files, diff})`) writes them: it sends
the run's goal + the worktree diff through the **same read-only `LlmProvider`** the judge/approver
use (built by `makeLlmProvider` for the run's harness — default `claude -p`; non-CLI providers fall
back to claude), and returns a `{title, body}` parsed **fail-closed** (tolerant `extractJson` +
Zod; empty/garbage → a typed `PrDraftError` → 422). It runs behind `POST
/api/worktrees/:name/pr/draft` and only **pre-fills the form** — the human still reviews and clicks
Open PR, so publishing stays a deliberate act.

**The diff is untrusted.** It is authored by the very agent whose work is being described, so — like
the judge's diff — it is fenced with `wrapUntrusted` + the `UNTRUSTED_SYSTEM_CLAUSE`: a hidden
`"title": "shipped"` or "ignore the above" is treated as data to summarize, never as an instruction.
The goal is the operator's own trusted input and is passed plainly.

### Landing a run made WITHOUT `--worktree` (the main workspace)

The default run edits the **main workspace** on its checked-out branch, so it has no `goaly/<name>`
branch — and you cannot open a PR from a branch into itself. Landing still applies, with two
adjustments:

- `changesMain()` / `commitMain(msg)` are the main-root twins of `changes` / `commit` (they share
  the same path-based internals; `ahead` becomes "unpushed commits"). **Merge is not offered** — you
  are already on the branch you'd merge into.
- **`openPrFromMain({name, title, body?, base?, commitMessage?})` ejects to a branch.** Because a
  PR needs a source branch, it creates a fresh `goaly/<name>` carrying the uncommitted changes
  (`git switch -c`), commits + pushes them, `gh pr create`s with the **original branch as base**,
  then — in a `finally` — **switches the workspace back to the original branch**. So on success you
  are back where you started with a clean tree and a PR open; and on *any* failure after the switch
  (push rejected, `gh` error) the `finally` still returns you home, with the work safely committed on
  `goaly/<name>` — never stranded on a half-made branch. Fail-closed up front on a clean tree, a
  detached HEAD, or a name that already exists.

### The thin UI seams reuse the ADR 0015 machinery verbatim

- Routes: `GET /api/worktrees/:name/changes` and `GET /api/workspace/changes` (reads; work on a
  **read-only** server, like `/api/worktrees`); `POST /api/worktrees/:name/{commit,merge,pr,pr/draft}`
  and `POST /api/workspace/{commit,pr,pr/draft}` (state-changing → the existing
  `actions === undefined ⇒ 503` read-only guard, the `X-Goaly-Ui` + same-origin + local-Host guards,
  and Zod-`.strict()` request bodies). A `LandingError`/`PrDraftError` maps to **422**; bad params to
  **400**.
- Actions: `UiActions` gains the worktree quartet (`worktreeChanges` / `commitWorktree` /
  `mergeWorktree` / `openPr`) and the main-workspace set (`workspaceChanges` / `commitWorkspace` /
  `openPrFromMain` / `draftPrWorkspace`), thin delegates to the `LandingManager` (injectable so tests
  need no `gh`/remote).
- View: one `LandingPanel` renders on any **non-live** run detail, parameterized by the run's root.
  For a worktree it shows commit / merge / open-PR over `goaly/<name>`; for the main workspace it
  drops merge and its "open a PR" takes a branch name (the `goaly/<name>` to eject onto).

### Safety

- **Two writers is never safe.** Every *mutating* op refuses (via the run-lock liveness probe) while
  a live run holds the worktree — and `merge` additionally refuses a busy or dirty main. This is the
  same rule `WorktreeManager.remove` enforces.
- **No shell.** Operator strings (commit message, PR title/body) are passed as **argv** through the
  `ExecFn` seam — never a shell — so they can't inject.
- **Publishing is gated.** "Open a PR" is disabled unless a remote **and** `gh` are present, and the
  action is an explicit operator click behind the state-changing guards.

## Alternatives considered

- **Fold landing into the success contract** (a "merged" or "PR opened" rung) — rejected: it breaks
  invariant #2. DONE means the *work* is proven; shipping is a separate human act, and coupling them
  would let "open a PR" masquerade as verification.
- **A `goaly land` CLI subcommand instead of / before the UI** — deferred, not rejected: the
  `LandingManager` is CLI-shaped and could back one later. The dead end was in the browser, where a
  finished run is most visible, so the UI got it first.
- **Auto-commit/-PR at end of run** — rejected: it re-crosses the contract boundary and takes an
  outward-facing action without an explicit operator decision. Landing stays a deliberate,
  post-DONE click.

## Consequences

- Runs still never commit; the merge-back story is unchanged git — the UI just drives it for you.
- `README.md` and the landing page document the panel; the worktree section points at it.
- The panel serves **both** roots: a worktree run lands over `goaly/<name>`; a main-workspace run
  commits in place and, for a PR, ejects the changes onto a fresh `goaly/<name>` and returns you to
  your branch.
