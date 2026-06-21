import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from '../driver/driver';
import { RunId } from '../domain/ids';
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
  makeFakeContract,
  makeConfig,
  passVerdict,
  failVerdict,
  approve,
} from '../testing/fakes';
import { replay } from './replay';

const runId = RunId.parse('run-replay');
const contract = makeFakeContract({ goal: 'replayed goal' });

async function driveAndStore(): Promise<InMemoryRunLog> {
  const workspace = new FakeWorkspace('0000000');
  const runlog = new InMemoryRunLog();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    gateA: new FakeGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: '0000001' }, { postHash: '0000002' }], workspace),
    makeLadder: () => new FakeVerifier([failVerdict('red'), passVerdict('green')]),
    approver: new FakeApprover([approve()]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
  await drive(deps, makeConfig({ goal: 'replayed goal', maxIterations: 5 }), runId);
  return runlog;
}

describe('replay()', () => {
  it('reconstructs the Driver-computed terminal state from the event stream', async () => {
    const runlog = await driveAndStore();
    const stored = await runlog.read();
    expect(stored).not.toBeNull();

    const { state, contract: replayedContract, contractHash } = replay(
      stored!.header.config,
      stored!.entries,
    );

    // Same final state the Driver reached, byte-for-byte on the frozen contract.
    expect(state.tag).toBe('DONE');
    expect(replayedContract).toEqual(contract);
    expect(contractHash).toBe(contract.contractHash);
  });

  it('is pure — folding the same stream twice yields equal state', async () => {
    const runlog = await driveAndStore();
    const stored = await runlog.read();
    const a = replay(stored!.header.config, stored!.entries);
    const b = replay(stored!.header.config, stored!.entries);
    expect(a.state).toEqual(b.state);
    expect(a.contractHash).toBe(b.contractHash);
  });

  it('returns the seed COMPILING state for an empty stream', () => {
    const { state, contract: c, contractHash } = replay(makeConfig(), []);
    expect(state.tag).toBe('COMPILING');
    expect(c).toBeNull();
    expect(contractHash).toBeNull();
  });
});
