> **Archived.** Shipped as `--workspace-mode git|file|auto`
> ([ADR 0018](../adr/0018-non-git-workspace.md),
> [`docs/reference.md` → "Workspace mode"](../reference.md#workspace-mode---workspace-mode)),
> NOT as the `--no-git` / `--auto-init` flags this plan proposed. The open questions below
> were resolved; kept as a record.

# Plan: Non-Git Workspace Support for goaly

## Goal

Allow `goaly` to run in a directory that is not (and never becomes) a git repository, without weakening the core invariants (frozen contract, two-key DONE, write-ahead log, diff-based review, stuck detection).

## Why it matters

- Current `--auto-init` only hides `git init`; git is still the underlying VCS.
- Non-technical users or users in read-only / non-git environments hit a hard floor.
- A non-git workspace makes goaly usable in CI sandboxes, shared storage, or plain file trees.

## High-level approach

Add a second `Workspace` implementation behind the existing `Workspace` seam. The orchestrator/driver/policy code should not know whether the workspace is git-backed or file-backed. The git-specific concepts (baseline, checkpoint, worktree) map to file-system concepts.

## Seams and mappings

### 1. `Workspace` interface (`src/workspace/workspace.ts`)

Current methods:
- `diffHash(): Promise<DiffHash>`
- `setBaseline(ref: string): void`
- `currentBaseline(): string`
- `setDiffIncludes(paths): void`
- `checkpoint(): Promise<DiffHash>`
- `diff(baseline?): Promise<string>`
- `fileHash(relPath): Promise<string | null>`
- `readFile(relPath): Promise<string | null>`
- `isEmptyOfSource(generatedFiles): Promise<boolean>`
- `run(command, opts): Promise<CommandResult>`

For a non-git workspace:
- `diffHash`: SHA-256 of a deterministic manifest of all tracked files (content-addressed tree).
- `diff`: render a unified-diff-style textual diff between two manifests, including added/deleted/modified files.
- `checkpoint`: snapshot current manifest as the new active baseline.
- `setBaseline`: restore/override the active baseline from a previously stored tree hash.
- `isEmptyOfSource`: check whether any non-doc/non-meta file exists (minus generated verification files).
- `run`: identical behavior; file-backed workspace still runs commands in `cwd`.

### 2. New module: `src/workspace/file-workspace.ts`

Implement a `FileWorkspace` class satisfying `Workspace`.

Responsibilities:
- Maintain an internal manifest: path → { sha256, mtime } for files under the root.
- Exclude `.goaly/` by default (and any configured `excludes`).
- Persist baselines on disk under `.goaly/file-baselines/<tree-hash>/` so resume can reconstruct them.
- Render diffs in a format close enough to `git diff` that the judge/approver prompts don't need to change.
- Respect `.goaly` state dir for checkpoint storage.

Key design points:
- **Path guarding:** same as `GitWorkspace.readFile` — refuse paths that escape the root.
- **Deterministic manifest ordering:** lexicographic path order; stable hashes across platforms.
- **Binary files:** skip content or summarize, mirroring git's binary-file behavior.
- **Symlinks:** follow them like git does by default, or skip them conservatively.

### 3. Composition root: choose the workspace implementation

In `src/cli/compose.ts` (or wherever `GitWorkspace` is currently constructed):
- If `--no-git` is passed, use `FileWorkspace`.
- If `--workspace` points to a git repo (detected via `git rev-parse --is-inside-work-tree`), default to `GitWorkspace`.
- If `--workspace` is not a git repo and `--no-git` is not passed, keep current auto-init behavior (create git repo).
- `--no-git` and `--worktree` are mutually exclusive: worktrees are a git concept; fail closed with a clear message.

### 4. Baseline / checkpoint persistence

For `FileWorkspace`:
- `checkpoint()` writes the current manifest to `.goaly/file-baselines/<tree-hash>/manifest.jsonl` and returns the tree hash as `DiffHash`.
- `setBaseline(hash)` loads that manifest if it exists, else fails closed.
- On resume, the log header stores the baseline hash; replay calls `setBaseline`.

This keeps the run-log format identical: the baseline is still a `DiffHash` string, regardless of git vs. file backing.

### 5. Diff format

Render a textual diff in `diff -u` style:
- Modified file: `--- a/<path>`, `+++ b/<path>`, hunk headers.
- Added file: `--- /dev/null`, `+++ b/<path>`.
- Deleted file: `--- a/<path>`, `+++ /dev/null`.

Keep the output similar enough to `git diff` that the LLM reviewers consume it the same way.

### 6. Stuck detection

No changes to the orchestrator. It still compares `prevDiffHash` to `diffHash`. The hashes come from `FileWorkspace.diffHash()` instead of git tree hashes.

### 7. Worktrees

`--worktree` requires git. With `--no-git`, `--worktree` is a usage error.

### 8. UI / CLI changes

- New flag: `--no-git` (per-invocation, not persisted in `.goalyrc`).
- Update `preflightRun` to skip the git repo check when `--no-git` is set.
- Update USAGE, README, reference.md, landing page.
- `goaly worktree` commands still require git; error clearly if `--no-git` was used.

### 9. Testing strategy (test-first)

Add `src/workspace/file-workspace.test.ts` covering:
1. `diffHash` stable with no changes, changes after modifying a file.
2. `.goaly/` excluded from the manifest.
3. `diff` renders added/modified/deleted files.
4. `checkpoint` advances baseline; subsequent diffs are empty against new baseline.
5. `setBaseline` restores a prior checkpoint.
6. `isEmptyOfSource` true/false with source files and doc/meta allowlist.
7. `run()` still executes commands in the workspace root.

Add CLI tests:
1. `--no-git` in a bare directory succeeds without git binary.
2. `--no-git` with `--worktree` fails closed.
3. `--no-git` with `--baseline <hash>` resolves against persisted file baselines.
4. Resume a `--no-git` run reconstructs the baseline.

Add composition test:
1. Non-git workspace + no `--no-git` → auto-init still creates git.
2. Non-git workspace + `--no-git` → `FileWorkspace` used.
3. Git workspace → `GitWorkspace` used.

### 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| File manifest grows slow on huge repos | Cap diff scope to tracked paths; consider streaming sha256. |
| Diff output differs subtly from git diff | Keep `---/+++` header format identical; add tests matching judge/approver expectations. |
| Checkpoint storage grows unbounded | Manifest files are small; still, consider pruning old checkpoints at run end. |
| External tools expect git inside verify command | `--no-git` only changes goaly's diff workspace; the agent can still run git inside commands if it wants. |
| Resume with a missing baseline manifest | Fail closed; log the missing hash and abort. |

### 11. Invariant checks

None of the eight invariants are violated:
- Pure reducer stays pure.
- Contract freeze is unchanged.
- Two-key DONE unchanged.
- Fail-closed behavior maintained.
- Parsing at seams unchanged.
- Write-ahead log format unchanged.
- Stuck detection stays pure.
- Only the workspace seam gains an implementation.

### 12. Migration / compatibility

- Default behavior is unchanged unless user passes `--no-git`.
- Existing git-backed runs and logs are byte-for-byte compatible.
- `--auto-init` and `--no-git` are orthogonal: one says "bootstrap with git", the other says "never use git at all".

### 13. Open questions

1. Should `--no-git` be allowed with `--generate`? Yes — verification files are registered in `.goaly` or excluded from the manifest just like git excludes.
2. Should we support an optional `.goalyignore` file for file workspace excludes? Could be a follow-up; start with command-line `--diff-ignore` only.
3. Do we need file-locking for concurrent runs? Same as git workspace: run-lock already lives under `.goaly/run-<id>/lock`.

---

This is a multi-file, medium-size change. Recommended order: domain interface first, then `FileWorkspace`, then composition switch, then CLI flag/preflight, then tests, then docs.
