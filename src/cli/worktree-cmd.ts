import { WorktreeManager, WorktreeError, type WorktreeInfo } from '../workspace/worktree-manager';
import type { ExecFn } from '../workspace/git-workspace';

/**
 * The `goaly worktree` subcommand: light, named worktree management so a run can execute on an
 * isolated copy of the repo (`goaly run --worktree <name>`) and the work merges back with plain git.
 */
export type WorktreeCommand =
  | { readonly kind: 'create'; readonly name: string; readonly base: string | undefined }
  | { readonly kind: 'list' }
  | {
      readonly kind: 'remove';
      readonly name: string;
      readonly force: boolean;
      readonly deleteBranch: boolean;
    };

/**
 * Render the `goaly worktree` subcommands. A pure presentation layer over {@link WorktreeManager}:
 * results go through injected `out`/`err` sinks (no `console.log` in library code) and a
 * fail-closed {@link WorktreeError} becomes a clear message + exit 2. Returns the exit code.
 */
export async function runWorktree(
  cmd: WorktreeCommand,
  workspace: string,
  out: (s: string) => void,
  err: (s: string) => void,
  exec?: ExecFn,
): Promise<number> {
  const manager = new WorktreeManager({ root: workspace, ...(exec !== undefined ? { exec } : {}) });
  try {
    if (cmd.kind === 'create') {
      const info = await manager.create(cmd.name, cmd.base);
      out(
        `created worktree '${info.name}' at ${info.path} (branch ${info.branch})\n` +
          `run in it with: goaly "<goal>" --worktree ${info.name}\n`,
      );
      return 0;
    }
    if (cmd.kind === 'list') {
      const items = await manager.list();
      if (items.length === 0) {
        out(`No worktrees under ${manager.pathFor('')} — create one with: goaly worktree create <name>\n`);
        return 0;
      }
      out(`${renderWorktreeTable(items)}\n`);
      return 0;
    }
    const kept = !cmd.deleteBranch;
    await manager.remove(cmd.name, { force: cmd.force, deleteBranch: cmd.deleteBranch });
    out(`removed worktree '${cmd.name}'\n`);
    if (kept) out(`branch goaly/${cmd.name} was kept — merge it with: git merge goaly/${cmd.name}\n`);
    return 0;
  } catch (e) {
    if (e instanceof WorktreeError) {
      err(`goaly: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

export function renderWorktreeTable(items: readonly WorktreeInfo[]): string {
  const headers = ['NAME', 'BRANCH', 'HEAD', 'DIRTY', 'RUNS', 'PATH'];
  const rows = items.map((w) => [
    w.name,
    w.branch,
    w.head,
    w.prunable ? 'PRUNABLE' : w.dirty ? 'yes' : 'no',
    String(w.runs),
    w.path,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const pad = (cells: string[]): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ').trimEnd();
  return [pad(headers), ...rows.map(pad)].join('\n');
}
