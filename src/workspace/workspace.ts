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
  /** Run a shell command in the workspace root. */
  run(command: string): Promise<CommandResult>;
}
