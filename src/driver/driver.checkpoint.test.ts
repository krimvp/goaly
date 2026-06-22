import { describe, it, expect } from 'vitest';
import { drive, recordCheckpoint, type DriverDeps } from './driver';
import { RunId, DiffHash } from '../domain/ids';
import type { RunLogEntry } from '../runlog/runlog';
import {
  FakeHarness,
  FakeVerifier,
  FakeApprover,
  FakeCompiler,
  FakeGate,
  FakeWorkspace,
  ManualClock,
  ManualBudgetMeter,
  InMemoryRunLog,
  recordingLogger,
  makeFakeContract,
  makeConfig,
  passVerdict,
  approve,
} from '../testing/fakes';

const runId = RunId.parse('run-ckpt');
const contract = makeFakeContract({ goal: 'checkpoint goal' });

/** Drive a single-iteration pass→approve run to DONE and return the populated in-memory log. */
async function driveToDone(workspace: FakeWorkspace, runlog: InMemoryRunLog): Promise<void> {
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    gateA: new FakeGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: '0000abc' }], workspace),
    makeLadder: () => new FakeVerifier([passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
  const outcome = await drive(deps, makeConfig({ goal: 'checkpoint goal' }), runId);
  expect(outcome.status).toBe('DONE');
}

describe('recordCheckpoint() — the internal-checkpoint primitive (issue #47)', () => {
  it('snapshots the tree, records a CHECKPOINTED event write-ahead, and advances the baseline', async () => {
    const ws = new FakeWorkspace('abc1234');
    const runlog = new InMemoryRunLog();
    await runlog.writeHeader({ runId, startedAt: 0, config: makeConfig() });
    const { logger, records } = recordingLogger();

    const res = await recordCheckpoint(
      { workspace: ws, runlog, clock: new ManualClock(7), logger },
      runId,
      4,
      contract.contractHash,
      'VERIFYING',
    );

    // It snapshots the current tree and returns it as the baseline handle, advancing seq by one.
    expect(res.tree).toBe('abc1234');
    expect(res.seq).toBe(5);
    // The workspace adopted the snapshot as its new diff baseline (no user-visible commit).
    expect(ws.baseline).toBe('abc1234');

    // A single CHECKPOINTED entry is appended, carrying the tree SHA and the Driver's clock/seq.
    const entries = (await runlog.read())!.entries;
    const ckpt = entries.find((e) => e.event.tag === 'CHECKPOINTED');
    expect(ckpt).toBeDefined();
    expect(ckpt!.event).toEqual({ tag: 'CHECKPOINTED', tree: 'abc1234' });
    expect(ckpt!.seq).toBe(5);
    expect(ckpt!.ts).toBe(7);
    expect(ckpt!.contractHash).toBe(contract.contractHash);
    expect(records.some((r) => r.msg === 'checkpoint recorded')).toBe(true);
  });

  it('propagates a snapshot failure (fail-closed) rather than logging an empty baseline', async () => {
    const ws = new FakeWorkspace('0000000');
    // Force checkpoint() to throw — a failed write-tree must surface, never a silent empty tree.
    ws.checkpoint = async () => {
      throw new Error('write-tree exploded');
    };
    const runlog = new InMemoryRunLog();
    await runlog.writeHeader({ runId, startedAt: 0, config: makeConfig() });
    await expect(
      recordCheckpoint({ workspace: ws, runlog, clock: new ManualClock() }, runId, 0, null, 'VERIFYING'),
    ).rejects.toThrow('write-tree exploded');
    // Nothing was appended (the snapshot never produced a tree to record).
    expect((await runlog.read())!.entries).toHaveLength(0);
  });
});

describe('drive() — resume reconstructs the diff baseline from the log', () => {
  it('re-points the workspace baseline at the last logged checkpoint on --resume', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(new FakeWorkspace('0000abc'), log);

    // Splice an internal checkpoint into the persisted stream, right after the AGENT_RAN — exactly
    // where the Driver/#46 policy would take one. resume must reconstruct it.
    const tree = DiffHash.parse('d'.repeat(40));
    const at = log.entries.findIndex((e) => e.event.tag === 'AGENT_RAN') + 1;
    const marker: RunLogEntry = {
      runId,
      seq: log.entries.length + 1,
      ts: 1,
      contractHash: contract.contractHash,
      event: { tag: 'CHECKPOINTED', tree },
      stateTagAfter: 'VERIFYING',
    };
    log.entries.splice(at, 0, marker);

    // Resume with a FRESH workspace: every other dep throws if touched (a terminal log re-runs
    // nothing), so the only observable effect is the baseline reconstruction.
    const ws2 = new FakeWorkspace('0000abc');
    const resumeDeps: DriverDeps = {
      compiler: new FakeCompiler(new Error('must not run')),
      gateA: new FakeGate({ kind: 'reject', reason: 'must not run' }),
      harness: new FakeHarness([{ throwError: 'must not run' }], ws2),
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([]),
      workspace: ws2,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog: log,
    };
    const outcome = await drive(resumeDeps, makeConfig({ goal: 'checkpoint goal' }), runId, {
      resume: true,
    });

    expect(outcome.status).toBe('DONE');
    // The reconstructed baseline equals the tree from the last CHECKPOINTED event.
    expect(ws2.baseline).toBe('d'.repeat(40));
  });

  it('leaves the baseline at its default when the log has no checkpoint', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(new FakeWorkspace('0000abc'), log);

    const ws2 = new FakeWorkspace('0000abc');
    const resumeDeps: DriverDeps = {
      compiler: new FakeCompiler(new Error('must not run')),
      gateA: new FakeGate({ kind: 'reject', reason: 'must not run' }),
      harness: new FakeHarness([{ throwError: 'must not run' }], ws2),
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([]),
      workspace: ws2,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog: log,
    };
    await drive(resumeDeps, makeConfig({ goal: 'checkpoint goal' }), runId, { resume: true });
    // No CHECKPOINTED in the log ⇒ setBaseline was never called (baseline stays HEAD).
    expect(ws2.baselineCalls).toEqual([]);
  });
});
