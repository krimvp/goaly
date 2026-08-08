import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId } from '../domain/ids';
import { RunLogHeader } from '../runlog/runlog';
import type { DegradedMode } from '../domain/degraded';
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
  approve,
} from '../testing/fakes';

/**
 * Issue #125: a fully-collapsed model configuration is recorded as a TYPED degraded-mode flag in the
 * run-log header — the durable half of the fix, so a DONE from a self-judged run stays labelled
 * long after the startup WARN scrolled off (or was never watched, which is what `--autonomous` means).
 */

const runId = RunId.parse('run-degraded');
const contract = makeFakeContract({ goal: 'labelled goal' });

async function driveToDone(runlog: InMemoryRunLog, degraded?: DegradedMode): Promise<void> {
  const workspace = new FakeWorkspace('0000abc');
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: '0000abc' }], workspace),
    makeLadder: () => new FakeVerifier([passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
  const outcome = await drive(deps, makeConfig({ goal: 'labelled goal' }), runId, {
    harness: 'claude',
    ...(degraded !== undefined ? { degraded } : {}),
  });
  // The label never gates: a self-judged run still reaches DONE through both keys.
  expect(outcome.status).toBe('DONE');
}

describe('drive() — the degraded-mode label in the run-log header (issue #125)', () => {
  it('records the typed self-judged label on a fresh run', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log, { kind: 'self-judged', generate: true, autonomous: true });
    const header = (await log.read())!.header;
    expect(header.degraded).toEqual({ kind: 'self-judged', generate: true, autonomous: true });
    // It survives the header's Zod round-trip (invariant #6: the log is parsed on read).
    expect(RunLogHeader.parse(JSON.parse(JSON.stringify(header))).degraded?.kind).toBe('self-judged');
  });

  it('omits the field entirely when the run is not degraded (old logs still parse)', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log);
    const header = (await log.read())!.header;
    expect(header.degraded).toBeUndefined();
    expect('degraded' in header).toBe(false);
  });

  it('carries the shared model when one was named', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log, {
      kind: 'self-judged',
      model: 'one-model',
      generate: false,
      autonomous: true,
    });
    expect((await log.read())!.header.degraded?.model).toBe('one-model');
  });
});
