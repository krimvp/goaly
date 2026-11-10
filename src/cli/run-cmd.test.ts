import { describe, it, expect } from 'vitest';
import { RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { executeRun, runExitCode } from './run-cmd';
import { parseArgs } from './args';
import { STATE_DIR } from './compose';
import { acquireRunLock } from '../runlog/lock';

const base = { iterations: 3, contractHash: null, runId: RunId.parse('run-x') } as const;

describe('runExitCode', () => {
  it('exits 130 only for a run the interrupt stopped (it is resumable)', () => {
    const interrupted: RunOutcome = {
      ...base,
      status: 'ABORTED',
      reason: 'interrupted by user — resume this run with: --resume run-x',
    };
    expect(runExitCode(interrupted)).toBe(130);
  });

  it('a run that reached its own terminal state while a stop was pending exits 0 or 1, not 130', () => {
    expect(runExitCode({ ...base, status: 'DONE' })).toBe(0);
    expect(runExitCode({ ...base, status: 'FAILED', reason: 'reached maxIterations (3)' })).toBe(1);
    expect(runExitCode({ ...base, status: 'ABORTED', reason: 'repeat-failure (STUCK_REPEATED_FAILURE)' })).toBe(1);
  });
});

describe('executeRun — one live run per working tree', () => {
  // A red verify command and one iteration: if the guard ever failed, the run would still never
  // reach the approver, so this test never calls a real model.
  const argv = (dir: string, extra: string[] = []): string[] => [
    'run', 'g', '--verify-cmd', 'false', '--max-iterations', '1', '--harness', 'fake',
    '--workspace', dir, '--workspace-mode', 'file', '--autonomous', ...extra,
  ];

  async function run(dir: string, extra: string[] = []): Promise<{ code: number; err: string }> {
    const parsed = await parseArgs(argv(dir, extra), undefined, async () => ({ overlay: {}, sources: [] }));
    let err = '';
    const result = await executeRun(parsed, { out: () => {}, err: (s) => (err += s) });
    return { code: result.code, err };
  }

  it('refuses a second run while another live process drives a run in the same tree', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'goaly-one-live-run-'));
    try {
      // The parent process is alive and is not this process: it stands in for a run in a terminal.
      const other = await acquireRunLock(path.join(dir, STATE_DIR, 'run-live'), { pid: process.ppid });
      const refused = await run(dir);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain('run-live');
      expect(refused.err).toContain('goaly runs watch run-live');
      expect(refused.err).toContain('--worktree');
      expect((await readdir(path.join(dir, STATE_DIR))).sort()).toEqual(['run-live']);

      await other.release();
      expect((await run(dir)).code).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
