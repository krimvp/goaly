import type { DiffHash } from '../domain/ids';

/** Result of running a shell command in the workspace. */
export type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

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
