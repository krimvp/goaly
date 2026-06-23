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
  /** The working-tree diff as text, for the approver's Sign-off input. */
  diff(): Promise<string>;
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
}
