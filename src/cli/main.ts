import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseArgs, USAGE, UsageError, type UiCommand } from './args';
import { startUiServer } from '../ui/server';
import { STATE_DIR } from './compose';
import { runRuns } from './runs';
import { runWorktree } from './worktree-cmd';
import { WorktreeManager, WorktreeError } from '../workspace/worktree-manager';
import { executeRun } from './run-cmd';

// The run path lives in run-cmd.ts (`executeRun`) so the goaly-ui server drives runs through the
// SAME guards, lock, composition, and reporting (ADR 0015). Its helpers stay part of this module's
// public surface for tests and embedders.
export { executeRun, formatOutcome, nextStepHint, makeInterruptController, type RunIo, type RunResult } from './run-cmd';

/**
 * CLI entry. Returns a process exit code (0 = DONE, 1 = FAILED/ABORTED, 2 = usage error,
 * 130 = interrupted) so the thin bin launcher stays trivial and `main` is unit-testable.
 */
export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = await parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }

  if (parsed.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (parsed.command === 'runs' && parsed.runs !== undefined) {
    const stateDir = path.join(parsed.workspace, STATE_DIR);
    return runRuns(
      parsed.runs,
      stateDir,
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  }

  if (parsed.command === 'worktree' && parsed.worktree !== undefined) {
    return runWorktree(
      parsed.worktree,
      parsed.workspace,
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  }

  if (parsed.command === 'ui' && parsed.ui !== undefined) {
    return runUi(parsed.ui, parsed.workspace);
  }

  // --worktree: re-root the ENTIRE run at a managed worktree BEFORE anything reads
  // `parsed.workspace` (baseline validation, --from-run/--resume log reads, preflight, state dir,
  // run lock, composeDeps) — one rewrite here and every downstream consumer composes against the
  // worktree, so the main tree is never touched.
  let worktree: { name: string; mergeHint: string } | undefined;
  if (parsed.worktreeRun !== undefined) {
    if (parsed.worktreeRun === true && parsed.resumeRunId !== undefined) {
      process.stderr.write(
        'goaly: --resume needs the NAMED worktree the run lives in — pass --worktree <name> ' +
          '(find it with: goaly worktree list)\n',
      );
      return 2;
    }
    const name =
      parsed.worktreeRun === true ? `wt-${randomUUID().slice(0, 8)}` : parsed.worktreeRun;
    const manager = new WorktreeManager({ root: parsed.workspace });
    try {
      const info = await manager.ensure(name);
      process.stderr.write(
        `goaly: running in worktree '${name}' at ${info.path} (branch ${info.branch})\n`,
      );
      worktree = { name, mergeHint: manager.mergeHint(name) };
      parsed = { ...parsed, workspace: info.path, worktreeRun: name };
    } catch (e) {
      if (e instanceof WorktreeError) {
        process.stderr.write(`goaly: ${e.message}\n`);
        return 2;
      }
      throw e;
    }
  }

  const result = await executeRun(parsed, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  });
  // A worktree run never commits — tell the operator how to bring the work back to the main tree.
  if (worktree !== undefined && result.outcome !== undefined && result.outcome.iterations > 0) {
    process.stdout.write(`\n${worktree.mergeHint}\n`);
  }
  return result.code;
}

/**
 * `goaly ui`: start the local web server and stay up until Ctrl-C/SIGTERM. Reads are served off
 * the write-ahead logs; UI-owned runs (ADR 0015) run in-process and stay resumable if the server
 * dies, so stopping it is always safe.
 */
async function runUi(ui: UiCommand, workspace: string): Promise<number> {
  let server;
  try {
    server = await startUiServer({
      workspaceRoot: workspace,
      ...(ui.port !== undefined ? { port: ui.port } : {}),
    });
  } catch (e) {
    process.stderr.write(`goaly ui: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  process.stderr.write(
    `goaly ui listening on ${server.url} (workspace: ${workspace})\nPress Ctrl-C to stop.\n`,
  );
  return new Promise<number>((resolve) => {
    const stop = (): void => {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      void server.close().then(() => resolve(0));
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
