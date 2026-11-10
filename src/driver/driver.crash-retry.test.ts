import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { HARNESS_CRASH_BACKOFF_MS } from './perform';
import { SystemBudgetMeter } from './budget';
import type { BudgetMeter } from './budget';
import { RunId } from '../domain/ids';
import {
  FakeHarness,
  FakeVerifier,
  FakeApprover,
  FakeCompiler,
  FakeSealGate,
  FakeWorkspace,
  ManualClock,
  ManualBudgetMeter,
  InMemoryRunLog,
  makeFakeContract,
  makeConfig,
  passVerdict,
  failVerdict,
  approve,
  recordingLogger,
  type FakeRunScript,
} from '../testing/fakes';
import type { Logger } from '../log/logger';

const runId = RunId.parse('run-crash-retry');
const crash: FakeRunScript = { status: 'crashed', output: 'API Error: 529 overloaded' };

function wire(opts: {
  scripts: FakeRunScript[];
  clock?: ManualClock;
  budget?: BudgetMeter;
  interrupted?: () => boolean;
  logger?: Logger;
}): { deps: DriverDeps; harness: FakeHarness; slept: number[] } {
  const workspace = new FakeWorkspace('0000000', 'a fake diff');
  const harness = new FakeHarness(opts.scripts, workspace);
  const clock = opts.clock ?? new ManualClock();
  const slept: number[] = [];
  const deps: DriverDeps = {
    compiler: new FakeCompiler(makeFakeContract({ goal: 'g' })),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness,
    makeLadder: () => new FakeVerifier([passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace,
    clock,
    budget: opts.budget ?? new ManualBudgetMeter(false),
    sleep: async (ms) => {
      slept.push(ms);
      clock.advance(ms);
    },
    runlog: new InMemoryRunLog(),
    ...(opts.interrupted !== undefined ? { interrupted: opts.interrupted } : {}),
    ...(opts.logger !== undefined ? { logger: opts.logger } : {}),
  };
  return { deps, harness, slept };
}

const total = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe('drive() — patient retry of a crashed agent turn', () => {
  it('waits for minutes with a growing backoff, and a later success never reaches the stuck streak', async () => {
    const crashes = HARNESS_CRASH_BACKOFF_MS.length - 1;
    const { logger, records } = recordingLogger('debug');
    const { deps, harness, slept } = wire({
      scripts: [...Array<FakeRunScript>(crashes).fill(crash), { postHash: '0000001' }],
      logger,
    });

    const outcome = await drive(deps, makeConfig({ maxIterations: 1 }), runId);

    expect(outcome.status).toBe('DONE');
    expect(harness.prompts).toHaveLength(crashes + 1);
    expect(total(slept)).toBe(total(HARNESS_CRASH_BACKOFF_MS.slice(0, crashes)));
    expect(total(HARNESS_CRASH_BACKOFF_MS)).toBeGreaterThanOrEqual(5 * 60_000);
    const waits = records.filter((r) => r.level === 'warn' && r.msg.includes('waiting'));
    expect(waits).toHaveLength(crashes);
    expect(waits[0]?.fields).toMatchObject({ retry: 1, of: HARNESS_CRASH_BACKOFF_MS.length });
    expect(String(waits[0]?.fields?.['output'])).toContain('529 overloaded');
  });

  it('counts the turn as crashed only after the last retry also crashes', async () => {
    const perTurn = HARNESS_CRASH_BACKOFF_MS.length + 1;
    const { deps, harness } = wire({ scripts: Array<FakeRunScript>(perTurn * 2).fill(crash) });
    deps.makeLadder = () => new FakeVerifier([failVerdict('red')]);

    const outcome = await drive(deps, makeConfig({ maxIterations: 10 }), runId);

    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('STUCK_HARNESS_CRASH');
    expect(harness.prompts).toHaveLength(perTurn * 2);
  });

  it('stops waiting at once on an interrupt (Ctrl-C), with no further attempt', async () => {
    let stop = false;
    const { deps, harness, slept } = wire({
      scripts: Array<FakeRunScript>(20).fill(crash),
      interrupted: () => stop,
    });
    deps.sleep = async (ms) => {
      slept.push(ms);
      stop = true;
    };

    const outcome = await drive(deps, makeConfig({ maxIterations: 10 }), runId);

    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('interrupted by user');
    expect(harness.prompts).toHaveLength(1);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeLessThanOrEqual(1000);
  });

  it('stops waiting when the wall-clock budget runs out during the wait', async () => {
    const clock = new ManualClock();
    const budget = new SystemBudgetMeter({ wallClockMs: 30_000 }, clock);
    const { deps, harness, slept } = wire({
      scripts: Array<FakeRunScript>(20).fill(crash),
      clock,
      budget,
    });
    deps.makeLadder = () => new FakeVerifier([failVerdict('red')]);

    const outcome = await drive(deps, makeConfig({ maxIterations: 10, budget: { wallClockMs: 30_000 } }), runId);

    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toMatch(/budget/i);
    expect(total(slept)).toBe(30_000);
    expect(harness.prompts.length).toBeLessThan(HARNESS_CRASH_BACKOFF_MS.length + 1);
  });

  it('a timed-out turn is never retried', async () => {
    const { deps, harness, slept } = wire({
      scripts: [{ status: 'timeout', output: 'killed at the cap', postHash: '0000001' }],
    });
    deps.makeLadder = () => new FakeVerifier([failVerdict('red')]);

    await drive(deps, makeConfig({ maxIterations: 1 }), runId);

    expect(harness.prompts).toHaveLength(1);
    expect(slept).toHaveLength(0);
  });
});
