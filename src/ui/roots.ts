import { join } from 'node:path';
import { STATE_DIR } from '../cli/compose';
import { WorktreeManager } from '../workspace/worktree-manager';
import type { RootRef } from './api-schema';

/** One place runs can live: the main workspace or a goaly-managed worktree checkout. */
export type RunRoot = {
  ref: RootRef;
  /** The checkout path (the run's `--workspace`). */
  path: string;
  /** Where its run logs live: `<path>/.goaly`. */
  stateDir: string;
};

/**
 * Enumerate every root the UI reads runs from: the main workspace plus each managed worktree
 * (prunable ones excluded — their checkout, and thus their state dir, is gone). Fail-soft: a
 * workspace that is not a git repo (or has no worktrees) yields just the main root, so the UI
 * still serves run history anywhere `goaly run` ever ran.
 */
export async function enumerateRoots(
  workspaceRoot: string,
  listWorktrees: () => Promise<Array<{ name: string; path: string; prunable: boolean }>> = () =>
    new WorktreeManager({ root: workspaceRoot }).list(),
): Promise<RunRoot[]> {
  const roots: RunRoot[] = [
    { ref: { kind: 'main' }, path: workspaceRoot, stateDir: join(workspaceRoot, STATE_DIR) },
  ];
  try {
    for (const wt of await listWorktrees()) {
      if (wt.prunable) continue;
      roots.push({
        ref: { kind: 'worktree', name: wt.name },
        path: wt.path,
        stateDir: join(wt.path, STATE_DIR),
      });
    }
  } catch {
    // Not a git repo / git absent: worktrees simply don't apply. The main root still serves.
  }
  return roots;
}
