import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId } from '../domain/ids';
import type { RunExtension } from '../domain/events';
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
} from '../testing/fakes';

const runId = RunId.parse('run-extend');
const contract = makeFakeContract({ goal: 'extend me' });

/** Drive a fresh run to FAILED at maxIterations=1, returning its log. */
async function failAtCap(): Promise<InMemoryRunLog> {
  const workspace = new FakeWorkspace('0000000');
  const runlog = new InMemoryRunLog();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: '0000001' }], workspace),
    makeLadder: () => new FakeVerifier([failVerdict('still red')]),
    approver: new FakeApprover([]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
  const outcome = await drive(deps, makeConfig({ goal: 'extend me', maxIterations: 1 }), runId);
  expect(outcome.status).toBe('FAILED');
  expect(outcome.reason).toContain('maxIterations');
  return runlog;
}

function resumeDeps(runlog: InMemoryRunLog, harness: FakeHarness, workspace: FakeWorkspace): DriverDeps {
  return {
    compiler: new FakeCompiler(new Error('compile must not run on resume')),
    seal: new FakeSealGate({ kind: 'reject', reason: 'gate must not run on resume' }),
    harness,
    makeLadder: () => new FakeVerifier([passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    sleep: async () => {},
    runlog,
  };
}

describe('drive() — resume with an operator extension (RUN_EXTENDED, ADR 0012)', () => {
  it('revives a FAILED-at-cap run, steers the next prompt with the note, and reaches DONE', async () => {
    const runlog = await failAtCap();

    const ws = new FakeWorkspace('0000001');
    const harness = new FakeHarness([{ postHash: '0000002' }], ws);
    const extend: RunExtension = { maxIterations: 3, note: 'focus on the parser edge case' };
    const outcome = await drive(resumeDeps(runlog, harness, ws), makeConfig(), runId, {
      resume: true,
      extend,
    });

    expect(outcome.status).toBe('DONE');
    expect(outcome.iterations).toBe(2); // iteration 1 replayed; iteration 2 is the revived turn

    // The note reached the worker — appended to the resumed turn's prompt, clearly labeled.
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]).toContain('Operator note');
    expect(harness.prompts[0]).toContain('focus on the parser edge case');
    // The extension is persisted write-ahead — auditable, and later replays fold identically.
    const stored = await runlog.read();
    const marker = stored!.entries.find((e) => e.event.tag === 'RUN_EXTENDED');
    expect(marker).toBeDefined();
    expect(marker!.event.tag === 'RUN_EXTENDED' && marker!.event.maxIterations).toBe(3);
  });

  it('a later PLAIN resume keeps the logged extension (no need to repeat the flags)', async () => {
    const runlog = await failAtCap();

    // First resume: extend the cap but crash before the next turn completes (no scripts → throw).
    const ws1 = new FakeWorkspace('0000001');
    const crashing = new FakeHarness([{ throwError: 'boom mid-turn' }], ws1);
    await drive(resumeDeps(runlog, crashing, ws1), makeConfig(), runId, {
      resume: true,
      extend: { maxIterations: 3 },
    });

    // Second resume, NO flags: the logged RUN_EXTENDED still governs — the run continues to DONE.
    const ws2 = new FakeWorkspace('0000002');
    const harness = new FakeHarness([{ postHash: '0000003' }], ws2);
    const outcome = await drive(resumeDeps(runlog, harness, ws2), makeConfig(), runId, {
      resume: true,
    });
    expect(outcome.status).toBe('DONE');
  });

  it('an extension that does not un-terminate the run leaves the terminal outcome standing', async () => {
    const runlog = await failAtCap();

    // A note alone cannot revive a FAILED-at-cap run (the cap still binds) — fail-closed, no loop.
    const ws = new FakeWorkspace('0000001');
    const harness = new FakeHarness([], ws);
    const outcome = await drive(resumeDeps(runlog, harness, ws), makeConfig(), runId, {
      resume: true,
      extend: { note: 'this alone cannot help' },
    });
    expect(outcome.status).toBe('FAILED');
    expect(harness.prompts).toHaveLength(0); // no agent turn ran
  });

  it('a plain resume of a terminal run remains a no-op (unchanged semantics)', async () => {
    const runlog = await failAtCap();
    const ws = new FakeWorkspace('0000001');
    const harness = new FakeHarness([], ws);
    const outcome = await drive(resumeDeps(runlog, harness, ws), makeConfig(), runId, {
      resume: true,
    });
    expect(outcome.status).toBe('FAILED');
    expect(harness.prompts).toHaveLength(0);
    // And nothing was appended to the log.
    const stored = await runlog.read();
    expect(stored!.entries.some((e) => e.event.tag === 'RUN_EXTENDED')).toBe(false);
  });
});
