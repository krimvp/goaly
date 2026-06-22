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
  /** The working-tree diff as text, for the approver's Gate B input. */
  diff(): Promise<string>;
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
