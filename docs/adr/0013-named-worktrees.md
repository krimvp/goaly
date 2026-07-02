# ADR 0013 — named worktrees: run goaly on an isolated copy of the repo

## Status
Accepted.

## Context

A goaly run edits the operator's working tree in place. That is the right default for "fix my repo",
but it makes two common situations awkward:

1. **The operator keeps working while goaly runs.** The agent's edits, the verifier's runs, and the
   operator's own edits interleave in one tree — diffs get noisy and stuck-detection can be confused
   by human edits landing mid-iteration.
2. **More than one run at a time.** The per-run lock prevents two drivers on one *run directory*,
   but nothing stops two runs from editing one *tree* — because that was never safe to begin with.

goaly already had worktree machinery — `GitWorktreeHost` (issue #85, best-of-N) — but deliberately
ephemeral: tmpdir paths, detached HEADs, torn down every iteration. What was missing was the
*persistent, named* counterpart a whole run (and a human) can live in, plus the small management
surface around it.

The tension to resolve: how does work get *back* from an isolated copy? Any automatic merge/promote
step would put goaly in the business of rewriting the operator's primary tree — a hard-to-reverse
effect with real conflict cases — for little gain over what git already does well.

## Decision

### Named, persistent, branch-based worktrees under the state dir

`goaly worktree create|list|remove` manages worktrees at **`.goaly/worktrees/<name>`** on branch
**`goaly/<name>`** (created off `HEAD` or `--base <ref>`). Living inside the already git-ignored
`.goaly` state dir keeps them out of `git status`, self-contained, and enumerable without a registry
— the registration is git's own (`git worktree list --porcelain`, filtered to the managed prefix).
Names are validated fail-closed as one safe path-AND-branch component
(`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`, no `..`, no trailing `.`/`.lock`) — the same string is used as a
directory name and a ref component, so the schema must satisfy both.

Accepted consequence, documented loudly: `git clean -dfx` on the main tree deletes the checkouts.
Committed work survives on the `goaly/<name>` branch; `worktree list` surfaces the orphaned
registration as `PRUNABLE` instead of hiding it.

### `--worktree [<name>]` re-roots the run with ONE rewrite

The run path in `main()` keys everything — state dir, run lock, harness cwd, `GitWorkspace`, diff
scope, `--resume`/`--from-run` log reads — off `parsed.workspace`. So "run in a worktree" is a
single early rewrite: ensure the worktree, then `parsed = { ...parsed, workspace: worktreePath }`.
No seam changes, no new plumbing through compose or the driver; the reducer is untouched. Runs made
inside a worktree store their logs under `<worktree>/.goaly/`, so run state travels with the tree it
describes ("runs are per-workspace" keeps one meaning). Resume therefore needs the same
`--worktree <name>` — the startup banner prints the exact command.

### Merge-back is plain git — deliberately not goaly's job

Runs never commit (an existing invariant of the loop), so a finished worktree run leaves its changes
uncommitted on `goaly/<name>`. goaly prints the two-step hint (commit inside the worktree, then
`git merge goaly/<name>`) and **keeps the branch by default on remove** so the hint stays actionable.
`--delete-branch` opts out; an unmerged branch then needs `--force` (git's own `-d` refusal is the
gate). No auto-merge, no promote-into-main: the one place this could destroy operator work is left
to the tool with real conflict handling.

### Fail-closed safety ladder on remove

1. A **live goaly run** inside the worktree refuses removal — always, even `--force` (an agent is
   editing that tree; the liveness probe is the run-lock pid check `runs watch` already uses).
2. **Uncommitted changes** refuse without `--force`, naming the commit commands that keep the work.
3. Everything else follows the `GitWorktreeHost` teardown discipline (remove → rm-rf fallback →
   prune, never a throw on cleanup).

## Alternatives considered

- **Sibling directory (`../<repo>-<name>`)** — avoids nesting a checkout in the main tree but
  scatters state, needs its own registry, and survives nothing that `.goaly/worktrees` doesn't; the
  `git clean` caveat is documented instead.
- **Generalizing `GitWorktreeHost`** — its contract (tmpdir, detached, promote-tree) is the
  tournament's, not this feature's; forcing both shapes through one class would blur two lifecycles.
  The new `WorktreeManager` is a sibling on the same `ExecFn` seam.
- **Auto-merge back on DONE** — rejected as a hard-to-reverse write to the operator's primary tree
  with real conflict cases; plain git is strictly better here.

## Consequences

- Parallel runs get a safe idiom: one worktree per run (the UI work in ADR 0014/0015 builds on it).
- `runs list` in the main workspace does NOT show worktree runs (per-workspace state is the point);
  `goaly runs list --workspace .goaly/worktrees/<name>` does, and `worktree list` shows the count.
- Worktree runs pay the usual linked-worktree costs (a second checkout on disk; `node_modules` etc.
  are not shared) — setup commands run per worktree like any fresh clone.
