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
  makeFakePlan,
  makeConfig,
  passVerdict,
  failVerdict,
  approve,
} from '../testing/fakes';
import { replay, extendedRunConfig, applyRunExtension, resumeStreakRelief } from './replay';

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

// ---- phased DAG resume (issue #123) ----------------------------------------

describe('replay() — the phase FRONTIER is reconstructed from the log (issue #123)', () => {
  /** A: root. B: root. C: needs A+B. D: needs only A. */
  const dag = makeFakePlan({
    phases: [
      { goal: 'A', id: 'a', dependsOn: [] },
      { goal: 'B', id: 'b', dependsOn: [] },
      { goal: 'C', id: 'c', dependsOn: ['a', 'b'] },
      { goal: 'D', id: 'd', dependsOn: ['a'] },
    ],
  });
  const tree = DiffHash.parse('0'.repeat(40));
  const phasedConfig = makeConfig({ phased: true, parallelPhases: true, autonomous: true });

  const mk = (event: OrchestratorEvent): RunLogEntry => ({
    runId,
    seq: 0,
    ts: 0,
    contractHash: null,
    event,
    stateTagAfter: 'RUNNING_WAVE',
  });

  it('resumes on the NEXT frontier and repeats no completed phase', () => {
    const { state, plan } = replay(phasedConfig, [
      mk({ tag: 'PLAN_COMPILED', plan: dag }),
      mk({ tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } }),
      mk({
        tag: 'WAVE_RAN',
        outcomes: [
          { kind: 'merged', index: 0 },
          { kind: 'merged', index: 1 },
        ],
        tree,
      }),
    ]);
    expect(plan?.planHash).toBe(dag.planHash);
    expect(state.tag).toBe('RUNNING_WAVE');
    // The completed roots are NOT re-offered; the frontier is exactly the newly-unblocked phases.
    if (state.tag === 'RUNNING_WAVE') expect(state.indices).toEqual([2, 3]);
  });

  it('a partially-merged frontier resumes on the unmerged member alone', () => {
    const { state } = replay(phasedConfig, [
      mk({ tag: 'PLAN_COMPILED', plan: dag }),
      mk({ tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } }),
      mk({
        tag: 'WAVE_RAN',
        outcomes: [
          { kind: 'merged', index: 0 },
          { kind: 'unmerged', index: 1, reason: 'merge conflict' },
        ],
        tree,
      }),
    ]);
    expect(state.tag).toBe('COMPILING');
    if (state.tag === 'COMPILING') {
      expect(state.config.goal).toBe('B');
      expect(state.phase).toMatchObject({ index: 1, skip: [0] });
    }
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

  it('a candidates extension overlays the best-of-N fan-out (NL delegation at resume)', () => {
    const cfg = extendedRunConfig(makeConfig({ maxIterations: 5 }), [
      extensionEntry(1, { candidates: 4, note: 'try 4 parallel attempts' }),
    ]);
    expect(cfg.candidates).toBe(4);
    expect(cfg.maxIterations).toBe(5); // untouched fields keep their values
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

/**
 * Streak relief on `--resume`. The counted stuck detectors re-derive their streaks by replaying the
 * log, so a run that ABORTED at the harness-crash threshold re-aborted on the very first fold —
 * before the harness got a single turn, no matter what the operator had just fixed. goaly's own
 * remediation already said to work around it by hand (`--resume … --stuck-crash-threshold 4`);
 * this computes that instead of asking for it.
 */
describe('resumeStreakRelief', () => {
  /** One log entry, with `stateTagAfter` controlling whether the run reads as terminal. */
  function e(seq: number, event: OrchestratorEvent, stateTagAfter = 'RUNNING_AGENT'): RunLogEntry {
    return {
      runId,
      seq,
      ts: 1_700_000_000_000 + seq,
      contractHash: contract.contractHash,
      event,
      stateTagAfter: stateTagAfter as RunLogEntry['stateTagAfter'],
    };
  }

  const budget = { exceeded: false };
  const dh = (h: string): DiffHash => DiffHash.parse(h);
  const ran = (status: 'crashed' | 'completed', i: number): OrchestratorEvent => ({
    tag: 'AGENT_RAN',
    run: {
      output: 'out',
      sessionId: SessionId.parse('s-1'),
      status,
    },
    prevDiffHash: dh(String(i).padStart(7, '0')),
    diffHash: dh(String(i + 1).padStart(7, '0')),
    budget,
  });
  const verified = (v: { pass: boolean; detail: string; evaluable?: boolean }): OrchestratorEvent => ({
    tag: 'VERIFIED',
    verdict: { confidence: 1, ...v },
  });

  const config = makeConfig({ goal: 'g' });

  it('raises the crash threshold by the streak the log banked', () => {
    const entries = [e(1, ran('crashed', 1)), e(2, ran('crashed', 2), 'ABORTED')];
    // Default threshold 2 + a 2-long trailing streak: the resumed run must crash twice more.
    expect(resumeStreakRelief(config, entries)).toEqual({ harnessCrashThreshold: 4 });
  });

  it('measures only the TRAILING streak (a completed turn breaks it)', () => {
    const entries = [
      e(1, ran('crashed', 1)),
      e(2, ran('completed', 2)),
      e(3, ran('crashed', 3), 'ABORTED'),
    ];
    expect(resumeStreakRelief(config, entries)).toEqual({ harnessCrashThreshold: 3 });
  });

  it('does nothing for a run that did not ABORT', () => {
    const entries = [e(1, ran('crashed', 1)), e(2, ran('crashed', 2), 'RUNNING_AGENT')];
    expect(resumeStreakRelief(config, entries)).toEqual({});
  });

  it('does nothing for an ABORTED run with no banked streak (e.g. a budget abort)', () => {
    const entries = [e(1, ran('completed', 1)), e(2, verified({ pass: true, detail: 'ok' }), 'ABORTED')];
    expect(resumeStreakRelief(config, entries)).toEqual({});
  });

  it('relieves the contract-unevaluable streak', () => {
    const entries = [
      e(1, verified({ pass: false, detail: 'cannot run', evaluable: false })),
      e(2, verified({ pass: false, detail: 'cannot run', evaluable: false }), 'ABORTED'),
    ];
    // Both counters see this: the same two entries are also two identical failures.
    expect(resumeStreakRelief(config, entries)).toMatchObject({ unevaluableThreshold: 4 });
  });

  it('relieves the repeat-failure streak on the NORMALIZED signature', () => {
    // Identical but for a timestamp — exactly what `normalizeDetail` scrubs, and what the detector
    // counts as a repeat. Relief must measure the same thing the detector does.
    const entries = [
      e(1, verified({ pass: false, detail: 'FAIL at 2026-01-01T00:00:00Z in parser.ts' })),
      e(2, verified({ pass: false, detail: 'FAIL at 2026-01-01T00:00:01Z in parser.ts' })),
      e(3, verified({ pass: false, detail: 'FAIL at 2026-01-01T00:00:02Z in parser.ts' }), 'ABORTED'),
    ];
    expect(resumeStreakRelief(config, entries)).toEqual({ repeatFailureThreshold: 6 });
  });

  it('does not compound across repeated resumes (measured off the ORIGINAL thresholds)', () => {
    const entries = [e(1, ran('crashed', 1)), e(2, ran('crashed', 2), 'ABORTED')];
    // Even with a prior relief already logged as a RUN_EXTENDED overlay, the next relief is
    // computed from the HEADER config — so it re-measures rather than stacking bump on bump.
    const withPriorRelief = [
      extensionEntry(3, { stuck: { harnessCrashThreshold: 4 } }),
      ...entries.map((x) => ({ ...x, seq: x.seq + 3 })),
    ];
    expect(resumeStreakRelief(config, withPriorRelief)).toEqual({ harnessCrashThreshold: 4 });
  });

  it('is applied through the ordinary RUN_EXTENDED overlay path (auditable, overridable)', () => {
    const relief = resumeStreakRelief(config, [
      e(1, ran('crashed', 1)),
      e(2, ran('crashed', 2), 'ABORTED'),
    ]);
    const extended = applyRunExtension(config, { stuck: relief });
    expect(extended.stuckPolicy.harnessCrashThreshold).toBe(4);
    // The frozen contract is untouched — an extension can only move operational knobs.
    expect(extended.goal).toBe(config.goal);
    expect(extended.verifier).toEqual(config.verifier);
  });
});

/**
 * Replay compatibility for the timeout-no-diff detector (issue #119). The detector converts a
 * decision that PREVIOUSLY returned CONTINUE into a terminal ABORTED, so a run log written before
 * it existed — one that recorded a timeout+no-diff streak mid-log and then kept iterating — would
 * fold to ABORTED in the middle and then THROW on the next entry ("step() called on terminal state
 * ABORTED"), permanently bricking `--resume` and `runs show/list` for that run.
 *
 * The fix is tail-sensitivity: a mid-log fold keeps the pre-#119 semantics (the timeout no-diff
 * excuse stays unbounded), and only the LAST folded decision can trip the abort — which is exactly
 * where a post-#119 log records it, since the trip is terminal.
 */
describe('replay() — the timeout-no-diff trip is TAIL-SENSITIVE (issue #119 back-compat)', () => {
  const config = makeConfig({ goal: 'g', maxIterations: 20 });
  const dh = (h: string): DiffHash => DiffHash.parse(h.padStart(7, '0'));

  function e(seq: number, event: OrchestratorEvent, stateTagAfter = 'RUNNING_AGENT'): RunLogEntry {
    return { runId, seq, ts: 1_700_000_000_000 + seq, contractHash: contract.contractHash, event, stateTagAfter };
  }

  /** One agent turn: `status`, moving the tree from `prev` to `post` (equal ⇒ no-diff). */
  const ran = (status: 'completed' | 'timeout', prev: string, post: string): OrchestratorEvent => ({
    tag: 'AGENT_RAN',
    run: { output: 'out', sessionId: SessionId.parse('s-1'), status },
    prevDiffHash: dh(prev),
    diffHash: dh(post),
    budget: { exceeded: false },
  });
  const verified = (detail: string): OrchestratorEvent => ({
    tag: 'VERIFIED',
    verdict: { pass: false, confidence: 1, detail },
  });

  /** Compile + Seal, then N iterations of (AGENT_RAN, VERIFIED). */
  function log(turns: readonly { status: 'completed' | 'timeout'; prev: string; post: string }[]) {
    const entries: RunLogEntry[] = [
      e(1, { tag: 'CONTRACT_COMPILED', contract }, 'AWAIT_SEAL'),
      e(2, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
    ];
    turns.forEach((t, i) => {
      entries.push(e(entries.length + 1, ran(t.status, t.prev, t.post), 'VERIFYING'));
      entries.push(e(entries.length + 1, verified(`red ${i + 1}`), 'RUNNING_AGENT'));
    });
    return entries;
  }

  /**
   * The pre-branch log the finding describes: iterations 3 and 4 both timed out with an unchanged
   * tree (a 2-long timeout-no-diff streak at the default threshold), and the run then CONTINUED to
   * iteration 5. Folding it must not blow up mid-log — the run stays resumable.
   */
  const preBranchLog = log([
    { status: 'completed', prev: '0', post: '1' },
    { status: 'completed', prev: '1', post: '2' },
    { status: 'timeout', prev: '2', post: '2' },
    { status: 'timeout', prev: '2', post: '2' },
    { status: 'completed', prev: '2', post: '3' },
  ]);

  it('replays a pre-branch log with a MID-LOG timeout+no-diff streak instead of throwing', () => {
    const result = replay(config, preBranchLog);
    // Neither a throw nor a bogus terminal state: the run is mid-loop and resumable.
    expect(result.state.tag).toBe('RUNNING_AGENT');
    expect(result.commands[0]?.tag).toBe('RUN_AGENT');
  });

  it('a resumed run keeps the live threshold — the streak still aborts at the TAIL', () => {
    // The same history, but the log ENDS on the second timeout+no-diff iteration: that decision IS
    // the tail, so the detector must still fire (issue #119 is not weakened).
    const tailLog = log([
      { status: 'completed', prev: '0', post: '1' },
      { status: 'completed', prev: '1', post: '2' },
      { status: 'timeout', prev: '2', post: '2' },
      { status: 'timeout', prev: '2', post: '2' },
    ]);
    const result = replay(config, tailLog);
    expect(result.state.tag).toBe('ABORTED');
    if (result.state.tag === 'ABORTED') {
      expect(result.state.reason).toContain('STUCK_TIMEOUT_NO_DIFF');
    }
  });

  it('leaves the resumed ctx carrying the REAL threshold (relief is fold-local, not persisted)', () => {
    const result = replay(config, preBranchLog);
    if (result.state.tag !== 'RUNNING_AGENT') throw new Error('expected RUNNING_AGENT');
    expect(result.state.ctx.config.stuckPolicy.timeoutNoDiffThreshold).toBe(
      config.stuckPolicy.timeoutNoDiffThreshold,
    );
  });

  it('still honours a RUN_EXTENDED overlay of the threshold at the tail', () => {
    const raised = [
      ...log([
        { status: 'completed', prev: '0', post: '1' },
        { status: 'completed', prev: '1', post: '2' },
        { status: 'timeout', prev: '2', post: '2' },
        { status: 'timeout', prev: '2', post: '2' },
      ]),
    ];
    const withOverlay = [extensionEntry(0, { stuck: { timeoutNoDiffThreshold: 3 } }), ...raised];
    // A raised threshold means the 2-long streak no longer trips — the run continues.
    expect(replay(config, withOverlay).state.tag).toBe('RUNNING_AGENT');
  });
});
