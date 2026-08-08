# ADR 0018 — Non-Git Workspace Support

## Status

Accepted

## Context

goaly has always required a git repository: `GitWorkspace` uses git plumbing to compute a
content-addressed tree hash, render diffs, checkpoint baselines, and exclude the state dir. This is
a hard floor for users who do not use git, who run in CI sandboxes without a repo, or who want to
try goaly on a plain file tree.

## Decision

Add a second `Workspace` implementation — `FileWorkspace` — behind the existing `Workspace` seam.
The orchestrator, driver, verifier, and approver code cannot tell which implementation they are
talking to. The CLI exposes `--workspace-mode git|file|auto` (default `auto`).

### Semantics

| Concept | GitWorkspace | FileWorkspace |
|---|---|---|
| `diffHash()` | git empty-tree / tree hash | sha256 of deterministic manifest |
| `diff(baseline?)` | `git diff` + untracked files | textual diff against stored manifest |
| `checkpoint()` | `git write-tree` (no commit) | store manifest under `.goaly/baselines/<hash>.json` |
| `setBaseline(ref)` | git ref/tree SHA | manifest hash stored in `.goaly/baselines/` |
| `run()` | sandboxed shell | sandboxed shell (same seam) |
| `.goaly` exclusion | via git exclude + constructor excludes | constructor excludes |

### Invariant preservation

- **Frozen contract**: unchanged; the contract still hashes the same fields regardless of workspace
  implementation.
- **Two-key DONE**: unchanged; the ladder and approver use the same `Workspace` interface.
- **Write-ahead log**: unchanged; `FileRunLog` is workspace-agnostic.
- **Stuck detection**: unchanged; `diffHash` and `runStatusHistory` are produced by the same
  interface.
- **No user-visible git history**: file-mode stores baseline manifests inside `.goaly/baselines/`,
  which is excluded from the manifest, so it never pollutes the user's tree.

### Boundaries

- Worktrees and best-of-N require git plumbing and are refused in file mode with a clear message.
- `--baseline` in file mode is a manifest hash (recorded by a prior `checkpoint`), not a git ref.
- Harness autonomy auto-pinning (which pins to the run-start HEAD SHA) is a git concept and is
  skipped in file mode.

## Consequences

- goaly now runs in plain directories without `git init`.
- New code must target the `Workspace` interface, not `GitWorkspace` directly.
- Tests must cover both implementations or document which behavior is implementation-specific.
- The CLI preflight skips the git check in `auto`/`file` mode; `git` mode still enforces it.
