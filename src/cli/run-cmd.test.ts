import { describe, it, expect } from 'vitest';
import { RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';
import { runExitCode } from './run-cmd';

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
