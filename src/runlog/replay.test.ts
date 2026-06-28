import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from '../driver/driver';
import { RunId, DiffHash, SessionId } from '../domain/ids';
import type { RunLogEntry } from './runlog';
import type { OrchestratorEvent } from '../domain/events';
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
import { replay } from './replay';

const runId = RunId.parse('run-replay');
const contract = makeFakeContract({ goal: 'replayed goal' });

async function driveAndStore(): Promise<InMemoryRunLog> {
  const workspace = new FakeWorkspace('0000000');
  const runlog = new InMemoryRunLog();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
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

  // ---- session inheritance (Capability C) — resume == replay stays exact -----

  it('reconstructs the SEEDED first RUN_AGENT from config.seedSessionId', () => {
    const mk = (event: OrchestratorEvent): RunLogEntry => ({
      runId,
      seq: 0,
      ts: 0,
      contractHash: null,
      event,
      stateTagAfter: 'x',
    });
    const config = makeConfig({ goal: 'g', seedSessionId: 'prior-sess' as never });
    const { state, commands } = replay(config, [
      mk({ tag: 'CONTRACT_COMPILED', contract }),
      mk({ tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
    ]);
    // The reducer replayed the inherited seed onto the first turn's command.
    expect(state.tag).toBe('RUNNING_AGENT');
    expect(commands[0]).toMatchObject({ tag: 'RUN_AGENT', sessionId: 'prior-sess' });
  });

  it('overwrites the seed with the REAL returned session id after turn 1', () => {
    const mk = (event: OrchestratorEvent): RunLogEntry => ({
      runId,
      seq: 0,
      ts: 0,
      contractHash: null,
      event,
      stateTagAfter: 'x',
    });
    const config = makeConfig({ goal: 'g', seedSessionId: 'prior-sess' as never });
    const { state } = replay(config, [
      mk({ tag: 'CONTRACT_COMPILED', contract }),
      mk({ tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
      mk({
        tag: 'AGENT_RAN',
        run: { output: '', sessionId: SessionId.parse('real-sess'), status: 'completed' },
        prevDiffHash: DiffHash.parse('0000000'),
        diffHash: DiffHash.parse('0000001'),
        budget: { exceeded: false },
      }),
    ]);
    expect(state.tag).toBe('VERIFYING');
    if (state.tag === 'VERIFYING') expect(state.ctx.sessionId).toBe('real-sess');
  });

  // ---- diff-baseline checkpoints (issue #47) ------------------------------

  it('skips a CHECKPOINTED entry in the reducer fold but reconstructs the baseline from it', async () => {
    const runlog = await driveAndStore();
    const stored = (await runlog.read())!;

    // The Driver-computed terminal state, with NO checkpoint in the stream.
    const withoutCheckpoint = replay(stored.header.config, stored.entries);
    expect(withoutCheckpoint.state.tag).toBe('DONE');
    expect(withoutCheckpoint.baseline).toBeNull();

    // Splice a CHECKPOINTED marker into the middle of the stream (after the first AGENT_RAN). It must
    // NOT disturb the reducer fold (the reducer never sees it) — the terminal state is identical —
    // and the latest tree must surface as the reconstructed baseline.
    const tree = DiffHash.parse('a'.repeat(40));
    const insertAt = stored.entries.findIndex((e) => e.event.tag === 'AGENT_RAN') + 1;
    const marker: RunLogEntry = {
      runId,
      seq: 999,
      ts: 1,
      contractHash: contract.contractHash,
      event: { tag: 'CHECKPOINTED', tree },
      stateTagAfter: 'VERIFYING',
    };
    const spliced = [...stored.entries.slice(0, insertAt), marker, ...stored.entries.slice(insertAt)];

    const withCheckpoint = replay(stored.header.config, spliced);
    expect(withCheckpoint.state).toEqual(withoutCheckpoint.state); // reducer unaffected
    expect(withCheckpoint.baseline).toBe(tree);
  });

  it('keeps only the LAST checkpoint tree when several are logged', () => {
    const mk = (tree: string): RunLogEntry => ({
      runId,
      seq: 0,
      ts: 0,
      contractHash: null,
      event: { tag: 'CHECKPOINTED', tree: DiffHash.parse(tree) },
      stateTagAfter: 'COMPILING',
    });
    const { baseline } = replay(makeConfig(), [mk('b'.repeat(40)), mk('c'.repeat(40))]);
    expect(baseline).toBe('c'.repeat(40));
  });
});
