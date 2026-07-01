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
import { replay, extendedRunConfig } from './replay';

const runId = RunId.parse('run-replay');
const contract = makeFakeContract({ goal: 'replayed goal' });

/** A RUN_EXTENDED marker entry (ADR 0012) appended after `seq` prior entries. */
function extensionEntry(
  seq: number,
  fields: Partial<Extract<OrchestratorEvent, { tag: 'RUN_EXTENDED' }>>,
): RunLogEntry {
  return {
    runId,
    seq,
    ts: 1_700_000_000_000 + seq,
    contractHash: contract.contractHash,
    event: { tag: 'RUN_EXTENDED', ...fields },
    stateTagAfter: 'RUNNING_AGENT',
  };
}

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

  it('skips CANDIDATE_RAN / CANDIDATE_SELECTED markers in the reducer fold (best-of-N, issue #85)', async () => {
    const runlog = await driveAndStore();
    const stored = (await runlog.read())!;
    const baseline = replay(stored.header.config, stored.entries);

    // Splice best-of-N markers into the stream (after the first AGENT_RAN). Like CHECKPOINTED they are
    // Driver-side only — the reducer must NEVER fold them, so the terminal state stays identical.
    const insertAt = stored.entries.findIndex((e) => e.event.tag === 'AGENT_RAN') + 1;
    const ran: OrchestratorEvent = {
      tag: 'CANDIDATE_RAN',
      iteration: 1,
      index: 0,
      tree: DiffHash.parse('a'.repeat(40)),
      budget: { exceeded: false },
      pass: true,
      run: { output: '', sessionId: SessionId.parse('s'), status: 'completed' },
    };
    const selected: OrchestratorEvent = {
      tag: 'CANDIDATE_SELECTED',
      iteration: 1,
      winner: 0,
      tree: DiffHash.parse('a'.repeat(40)),
    };
    const mk = (event: OrchestratorEvent): RunLogEntry => ({
      runId,
      seq: 999,
      ts: 1,
      contractHash: contract.contractHash,
      event,
      stateTagAfter: 'RUNNING_AGENT',
    });
    const spliced = [
      ...stored.entries.slice(0, insertAt),
      mk(ran),
      mk(selected),
      ...stored.entries.slice(insertAt),
    ];

    const withMarkers = replay(stored.header.config, spliced);
    expect(withMarkers.state).toEqual(baseline.state); // reducer unaffected — it never folds them
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

// ---- operator extension markers (RUN_EXTENDED, ADR 0012) --------------------

/** Drive a run that FAILS at its iteration cap, returning the stored log. */
async function driveToIterationCap(maxIterations: number): Promise<InMemoryRunLog> {
  const workspace = new FakeWorkspace('0000000');
  const runlog = new InMemoryRunLog();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: '0000001' }, { postHash: '0000002' }], workspace),
    makeLadder: () => new FakeVerifier([failVerdict('red 1'), failVerdict('red 2')]),
    approver: new FakeApprover([]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
  const outcome = await drive(deps, makeConfig({ goal: 'replayed goal', maxIterations }), runId);
  expect(outcome.status).toBe('FAILED');
  return runlog;
}

describe('replay() — RUN_EXTENDED (operator extension, ADR 0012)', () => {
  it('extendedRunConfig applies overlays in order (later wins)', () => {
    const cfg = extendedRunConfig(makeConfig({ maxIterations: 5 }), [
      extensionEntry(1, { maxIterations: 10, budgetTokens: 1000 }),
      extensionEntry(2, { maxIterations: 20, stuck: { noDiff: false } }),
    ]);
    expect(cfg.maxIterations).toBe(20);
    expect(cfg.budget.tokens).toBe(1000);
    expect(cfg.stuckPolicy.noDiff).toBe(false);
    expect(cfg.stuckPolicy.oscillation).toBe(true); // untouched fields keep their values
  });

  it('a raised maxIterations UN-TERMINATES a FAILED-at-cap fold (the run continues)', async () => {
    const runlog = await driveToIterationCap(1);
    const stored = await runlog.read();

    // Without the extension the fold is terminal at the old cap.
    const before = replay(stored!.header.config, stored!.entries);
    expect(before.state.tag).toBe('FAILED');

    // With it, the fold continues into the next iteration: the resumed run has a next command.
    const after = replay(stored!.header.config, [
      ...stored!.entries,
      extensionEntry(stored!.entries.length + 1, { maxIterations: 3 }),
    ]);
    expect(after.state.tag).toBe('RUNNING_AGENT');
    expect(after.commands[0]?.tag).toBe('RUN_AGENT');
  });

  it('a raised token budget re-judges persisted exceeded flags (a budget abort revives)', async () => {
    // Hand-build a minimal loop log whose AGENT_RAN snapshot exceeded the OLD 100-token cap.
    const cfg = makeConfig({ goal: 'replayed goal', maxIterations: 5 });
    const base: RunLogEntry[] = [
      {
        runId, seq: 1, ts: 1, contractHash: contract.contractHash,
        event: { tag: 'CONTRACT_COMPILED', contract },
        stateTagAfter: 'AWAIT_SEAL',
      },
      {
        runId, seq: 2, ts: 2, contractHash: contract.contractHash,
        event: { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } },
        stateTagAfter: 'RUNNING_AGENT',
      },
      {
        runId, seq: 3, ts: 3, contractHash: contract.contractHash,
        event: {
          tag: 'AGENT_RAN',
          run: { output: 'worked', sessionId: SessionId.parse('s1'), status: 'completed', tokensUsed: 150 },
          prevDiffHash: DiffHash.parse('0000000'),
          diffHash: DiffHash.parse('0000001'),
          budget: { tokensSpent: 150, exceeded: true }, // over the old cap
        },
        stateTagAfter: 'VERIFYING',
      },
      {
        runId, seq: 4, ts: 4, contractHash: contract.contractHash,
        event: { tag: 'VERIFIED', verdict: { pass: false, confidence: 1, detail: 'red' } },
        stateTagAfter: 'ABORTED',
      },
    ];
    const before = replay(cfg, base);
    expect(before.state.tag).toBe('ABORTED');

    const after = replay(cfg, [...base, extensionEntry(5, { budgetTokens: 1000 })]);
    expect(after.state.tag).toBe('RUNNING_AGENT'); // exceeded re-judged vs the new cap → continue
  });

  it('surfaces a pending note until an agent turn consumes it', async () => {
    const runlog = await driveToIterationCap(1);
    const stored = await runlog.read();

    const pending = replay(stored!.header.config, [
      ...stored!.entries,
      extensionEntry(stored!.entries.length + 1, { maxIterations: 3, note: 'try the other approach' }),
    ]);
    expect(pending.pendingNote).toBe('try the other approach');

    // A note that PRECEDES a logged agent turn was seen by that turn — no longer pending.
    const consumed = replay(stored!.header.config, [
      extensionEntry(0, { note: 'try the other approach' }),
      ...stored!.entries,
    ]);
    expect(consumed.pendingNote).toBeNull();
  });
});
