import type { DiffHash } from '../domain/ids';

/** Result of running a shell command in the workspace. */
export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  /**
   * True when goaly itself KILLED the command for exceeding its timeout — a fact goaly owns, not a
   * guess from the exit code. A timed-out verify command never produced a real pass/fail, so the
   * verifier flags the verdict could-not-evaluate ({@link import('../domain/verdict').Verdict.evaluable})
   * rather than a genuine red. Absent ⇒ the command exited on its own. Optional so non-timeout
   * producers (and fakes) need not set it.
   */
  timedOut?: boolean;
  /**
   * True when goaly could not even START the command (the spawn itself threw — e.g. the shell is
   * missing). Like {@link timedOut}, a fact goaly owns: the command never ran, so the verifier flags
   * could-not-evaluate, not a real red. Distinct from a command that ran and exited non-zero (a
   * genuine failure). Absent ⇒ the command was started. Optional.
   */
  spawnFailed?: boolean;
};

/**
 * One isolated git worktree linked off the canonical repo (issue #85, best-of-N). Each best-of-N
 * candidate gets its own — a real, separate working directory checked out at the baseline tree, so K
 * worker attempts never see each other's edits. `scope` is a {@link Workspace} rooted at this worktree
 * (the harness runs in `root`; the frozen ladder scores against `scope`). The handle is owned by the
 * Driver's tournament and torn down on EVERY exit path (the {@link WorktreeHost.remove} call).
 */
export type Worktree = {
  /** Absolute filesystem path of the linked worktree (the candidate's harness cwd). */
  readonly root: string;
  /** A {@link Workspace} rooted at {@link root}, so the frozen ladder scores this candidate's tree. */
  readonly scope: Workspace;
};

/**
 * The worktree lifecycle seam (issue #85): create K isolated worktrees off a baseline tree, promote a
 * winning tree into the canonical workspace, and tear worktrees down. Lives on the workspace side (the
 * Driver/effect seam) so NONE of it touches the pure reducer. Fakeable end-to-end (the fake never
 * spawns git); the git implementation uses `git worktree add --detach <wt> <treeish>`.
 */
export interface WorktreeHost {
  /**
   * True when the repo has a resolvable HEAD (a committed root). Best-of-N needs one: `git worktree`
   * cannot check out an unborn branch's tree, so a `--candidates > 1` run on a HEAD-less repo refuses
   * to start (fail-closed, the worktree floor). Fail-safe to `false` on any error.
   */
  headResolves(): Promise<boolean>;
  /**
   * Create an isolated worktree checked out at `treeish` (a git tree SHA / ref — the current baseline).
   * Returns the handle; the caller MUST {@link removeWorktree} it on every exit path. Throws
   * fail-closed on a git failure, which the tournament scores as that candidate's hard red.
   */
  addWorktree(treeish: string): Promise<Worktree>;
  /** Tear down a worktree created by {@link addWorktree}. Never throws (best-effort cleanup). */
  removeWorktree(worktree: Worktree): Promise<void>;
  /**
   * Promote a winning candidate's tree (a git tree SHA produced inside its worktree) into the canonical
   * workspace — make the canonical working tree match it — WITHOUT a user-visible commit, so the next
   * iteration continues from the winner's edits. Fail-closed: throws on a git failure (the tournament
   * surfaces it to the outer loop, never a silent half-applied tree).
   */
  promoteTree(treeish: string): Promise<void>;
}

/**
 * The workspace seam — harness-independent. `diffHash` and verifier `run` live OUTSIDE
 * every adapter (ARCHITECTURE "Why adding a harness is trivial"), so stuck-detection and
 * verification work identically on any harness for free.
 */
export interface Workspace {
  /** Non-mutating content hash of the working tree (tracked changes + untracked files). */
  diffHash(): Promise<DiffHash>;
  /**
   * The working-tree diff as text, for the judge and the approver's Sign-off input. Defaults to the
   * active baseline (see {@link setBaseline}/{@link checkpoint}). Pass an explicit `baseline` (a git
   * ref or tree SHA) to diff against it instead — used by delta-verify (issue #49) to pin the terminal
   * approver to the run's START baseline (the cumulative guard) even while internal checkpoints have
   * advanced the active baseline so the per-iteration judge sees only the delta.
   */
  diff(baseline?: string): Promise<string>;
  /** The currently-active diff baseline (a git ref or tree SHA; default `HEAD`). Read-only. */
  currentBaseline(): string;
  /**
   * Snapshot the current working tree into a baseline handle (a git tree object) WITHOUT writing a
   * user-visible commit, moving HEAD/the branch, or touching the user's index — then make subsequent
   * {@link diff} compare against it. Returns the baseline handle (a tree SHA) so the Driver can record
   * it write-ahead and `--resume` can re-point the baseline by replaying the log. This is the
   * "internal checkpoint" primitive: it lets goaly keep a run's diff small across a multi-step build
   * without mutating the user's git history (issue #47). The no-op tree hash ({@link diffHash}) is
   * unaffected — the baseline changes only what `diff()` is computed *against*.
   */
  checkpoint(): Promise<DiffHash>;
  /**
   * Set what {@link diff} compares against (a git ref or tree SHA; default `HEAD`). The caller is
   * responsible for having validated that the ref resolves (the CLI does so fail-closed before the
   * run starts); a baseline that fails to resolve at diff time falls back like a missing HEAD.
   */
  setBaseline(ref: string): void;
  /**
   * Register workspace-relative paths that {@link diff} must ALWAYS surface (rendered as added-file
   * diffs) even when git hides them. The compiler-authored verification files (`generatedFiles`) are
   * registered in `.git/info/exclude` (issue #52) so they never pollute the user's `git status` — but
   * `diff()` lists untracked files with `--exclude-standard`, which *honors* that exclude, so the
   * authored bar would vanish from the very diff the two LLM keys review. Since the judge/approver
   * rubric is *about* those files ("all assertions in foo.test.mjs pass"), their absence reads as
   * "no tests were written" → a false veto the worker cannot fix without tripping the integrity guard
   * (an unwinnable deadlock). Forcing them back into `diff()` keeps the authored bar visible to the
   * keys while still hidden from the user's git. Idempotent; replaces any prior set.
   */
  setDiffIncludes(paths: readonly string[]): void;
  /**
   * Run a shell command in the workspace root. An optional `timeoutMs` kills the command (SIGKILL)
   * after that many ms and reports it as a non-zero exit, so a hung verify command fails closed
   * instead of stalling the loop forever.
   */
  run(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult>;
  /**
   * sha256 (hex) of the content of a workspace file, or `null` when it is absent or escapes the
   * workspace root. Used by the generated-files guard to detect tampering with the frozen, authored
   * verification. A `null` is treated fail-closed (a missing pinned file is a FAIL).
   */
  fileHash(relPath: string): Promise<string | null>;
  /**
   * True when the tree has no implementation source yet — only docs + the compiler's authored files.
   * The from-scratch signal the prepare phase uses (Fix B1) to skip the soundness pre-flight: on an
   * empty tree the deterministic bar is red *by definition* (the agent must scaffold first), so a red
   * there means "implementation missing," never "broken verifier." `generatedFiles` are the
   * compiler-authored verification paths to subtract (they are not implementation). Conservative: it
   * returns `true` only when ZERO candidate source files remain after subtracting `generatedFiles`
   * and a small doc/meta allowlist (README*, LICENSE*, *.md, .git*), so an existing project is never
   * mistaken for from-scratch (which would wrongly skip a legitimate soundness check). Fail-safe to
   * `false` (not from-scratch) on any error, so a glitch never skips the check.
   */
  isEmptyOfSource(generatedFiles: readonly string[]): Promise<boolean>;
}
