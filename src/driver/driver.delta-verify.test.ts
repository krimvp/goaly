import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId } from '../domain/ids';
import type { Verifier } from '../verify/verifier';
import type { Workspace } from '../workspace/workspace';
import type { Verdict, ApprovalVerdict } from '../domain/verdict';
import {
  FakeHarness,
  FakeApprover,
  FakeCompiler,
  FakeSealGate,
  FakePlanner,
  FakePlanGate,
  FakeWorkspace,
  ManualClock,
  ManualBudgetMeter,
  InMemoryRunLog,
  recordingLogger,
  makeFakeContract,
  makeFakePlan,
  makeConfig,
  passVerdict,
  failVerdict,
  approve,
  veto,
} from '../testing/fakes';

const runId = RunId.parse('run-delta');
const contract = makeFakeContract({ goal: 'delta goal' });

/**
 * A verifier that records the workspace's ACTIVE baseline at each verify call — the judge's
 * per-iteration view. It also exercises the real `workspace.diff()` path (which follows that
 * baseline), so the FakeWorkspace records which baseline the "judge" diffed against.
 */
class RecordingVerifier implements Verifier {
  readonly baselines: string[] = [];
  #i = 0;
  constructor(private readonly verdicts: Verdict[]) {}
  async verify(workspace: Workspace): Promise<Verdict> {
    this.baselines.push(workspace.currentBaseline());
    await workspace.diff();
    const v = this.verdicts[Math.min(this.#i, this.verdicts.length - 1)]!;
    this.#i += 1;
    return v;
  }
}

type Built = {
  deps: DriverDeps;
  ws: FakeWorkspace;
  verifier: RecordingVerifier;
  approver: FakeApprover;
  runlog: InMemoryRunLog;
  records: ReturnType<typeof recordingLogger>['records'];
};

/** Wire a driver with a recording verifier + scripted harness/approver and an in-memory log. */
function build(opts: {
  ws: FakeWorkspace;
  verdicts: Verdict[];
  approvals: ApprovalVerdict[];
  harness: ConstructorParameters<typeof FakeHarness>[0];
}): Built {
  const verifier = new RecordingVerifier(opts.verdicts);
  const approver = new FakeApprover(opts.approvals);
  const runlog = new InMemoryRunLog();
  const { logger, records } = recordingLogger();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness(opts.harness, opts.ws),
    makeLadder: () => verifier,
    approver,
    workspace: opts.ws,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
    logger,
  };
  return { deps, ws: opts.ws, verifier, approver, runlog, records };
}

describe('drive() — per-iteration delta diffs for the judge (issue #49)', () => {
  it('checkpoints after a failed iteration so the next judge sees the advanced (delta) baseline', async () => {
    const ws = new FakeWorkspace('0000000');
    const { deps, verifier, runlog } = build({
      ws,
      verdicts: [failVerdict(), passVerdict()],
      approvals: [approve()],
      // iter1 changes the tree to 1111111 (then we checkpoint at that tree), iter2 to 2222222.
      harness: [{ postHash: '1111111' }, { postHash: '2222222' }],
    });

    const outcome = await drive(deps, makeConfig({ goal: 'delta goal', deltaVerify: true }), runId);
    expect(outcome.status).toBe('DONE');

    // Iteration 1's judge ran against the run-start baseline (HEAD); iteration 2's judge ran against
    // the checkpoint taken after iteration 1 — i.e. it sees only iteration 2's delta.
    expect(verifier.baselines).toEqual(['HEAD', '1111111']);

    // The checkpoint was recorded write-ahead so a resumed run frames the same delta (#47/#7).
    const entries = (await runlog.read())!.entries;
    const ckpts = entries.filter((e) => e.event.tag === 'CHECKPOINTED');
    expect(ckpts).toHaveLength(1);
    expect(ckpts[0]!.event).toEqual({ tag: 'CHECKPOINTED', tree: '1111111' });
  });

  it('pins the terminal approver to the run-START baseline even after checkpoints advanced it (the cumulative guard)', async () => {
    const ws = new FakeWorkspace('0000000');
    // Distinct diff text per baseline so we can PROVE which one the approver received.
    ws.setDiffFor('HEAD', 'CUMULATIVE-since-run-start');
    ws.setDiffFor('1111111', 'only-iter2-delta');
    const { deps, approver } = build({
      ws,
      verdicts: [failVerdict(), passVerdict()],
      approvals: [approve()],
      harness: [{ postHash: '1111111' }, { postHash: '2222222' }],
    });

    await drive(deps, makeConfig({ goal: 'delta goal', deltaVerify: true }), runId);

    // Sign-off ran once (iteration 2). Despite the active baseline having advanced to 1111111, the
    // approver reviewed the CUMULATIVE diff against the run-start baseline — no unreviewed bytes.
    expect(approver.inputs).toHaveLength(1);
    expect(approver.inputs[0]!.diff).toBe('CUMULATIVE-since-run-start');
    expect(ws.diffBaselines).toContain('HEAD'); // the approver's diff resolved to the run-start baseline
  });

  it('rejects a change smeared across iterations: each delta passes the judge but the cumulative approver vetoes', async () => {
    const ws = new FakeWorkspace('0000000');
    ws.setDiffFor('HEAD', 'CUMULATIVE-violates-rubric');
    const { deps, approver, runlog } = build({
      ws,
      // Every per-iteration judge PASSES — no single delta looks bad.
      verdicts: [passVerdict(), passVerdict()],
      // But the approver, reviewing the cumulative change, vetoes every time.
      approvals: [veto('cumulative violation'), veto('cumulative violation')],
      harness: [{ postHash: '1111111' }, { postHash: '2222222' }],
    });

    const outcome = await drive(
      deps,
      makeConfig({ goal: 'delta goal', deltaVerify: true, maxIterations: 2 }),
      runId,
    );

    // The run never reaches DONE — the terminal cumulative key caught what the per-delta judge missed.
    expect(outcome.status).not.toBe('DONE');
    // Both Sign-off calls saw the full cumulative diff (against run-start), never the small delta.
    expect(approver.inputs.length).toBeGreaterThanOrEqual(1);
    expect(approver.inputs.every((i) => i.diff === 'CUMULATIVE-violates-rubric')).toBe(true);
    // Delta-verify was genuinely active (a checkpoint was taken between the iterations).
    expect((await runlog.read())!.entries.some((e) => e.event.tag === 'CHECKPOINTED')).toBe(true);
  });

  it('fails closed when a checkpoint throws: no crash, no CHECKPOINTED, judge falls back to the full diff', async () => {
    const ws = new FakeWorkspace('0000000');
    // Force the internal checkpoint to explode (e.g. a git write-tree failure).
    ws.checkpoint = async () => {
      throw new Error('write-tree exploded');
    };
    const { deps, verifier, runlog, records } = build({
      ws,
      verdicts: [failVerdict(), passVerdict()],
      approvals: [approve()],
      harness: [{ postHash: '1111111' }, { postHash: '2222222' }],
    });

    const outcome = await drive(deps, makeConfig({ goal: 'delta goal', deltaVerify: true }), runId);

    // The run still resolves terminally (the failed checkpoint is swallowed, not fatal).
    expect(outcome.status).toBe('DONE');
    // No baseline was advanced → iteration 2's judge fell back to the full diff (HEAD), never empty.
    expect(verifier.baselines).toEqual(['HEAD', 'HEAD']);
    // Nothing was logged as a checkpoint, and the fallback was surfaced as a warning.
    expect((await runlog.read())!.entries.some((e) => e.event.tag === 'CHECKPOINTED')).toBe(false);
    expect(
      records.some((r) => r.msg === 'delta-verify checkpoint failed; judge will see the full diff this iteration'),
    ).toBe(true);
  });

  it('rolls the baseline back when the CHECKPOINTED append throws (checkpoint advanced it first)', async () => {
    const ws = new FakeWorkspace('0000000');
    const { deps, verifier, runlog, records } = build({
      ws,
      verdicts: [failVerdict(), passVerdict()],
      approvals: [approve()],
      harness: [{ postHash: '1111111' }, { postHash: '2222222' }],
    });
    // The checkpoint snapshot SUCCEEDS (advancing the active baseline to 1111111), but persisting the
    // CHECKPOINTED marker throws — the crash window the rollback guards. Other appends still succeed so
    // the run can reach DONE.
    const realAppend = runlog.append.bind(runlog);
    runlog.append = async (entry) => {
      if (entry.event.tag === 'CHECKPOINTED') throw new Error('append exploded');
      return realAppend(entry);
    };

    const outcome = await drive(deps, makeConfig({ goal: 'delta goal', deltaVerify: true }), runId);

    expect(outcome.status).toBe('DONE');
    // checkpoint() advanced the baseline to 1111111, then the failed append rolled it back to HEAD —
    // so iteration 2's judge saw the FULL diff (HEAD), not the unlogged delta (the fail-closed promise).
    expect(ws.baselineCalls).toEqual(['1111111', 'HEAD']);
    expect(verifier.baselines).toEqual(['HEAD', 'HEAD']);
    // The append never landed → no CHECKPOINTED in the log, so a resume reconstructs the same HEAD
    // baseline the live run rolled back to (no live-vs-replay divergence).
    expect((await runlog.read())!.entries.some((e) => e.event.tag === 'CHECKPOINTED')).toBe(false);
    expect(
      records.some((r) => r.msg === 'delta-verify checkpoint failed; judge will see the full diff this iteration'),
    ).toBe(true);
  });

  it('is a no-op when the flag is off: no checkpoints, approver diff unchanged (default-mode parity)', async () => {
    const ws = new FakeWorkspace('0000000');
    ws.setDiffFor('HEAD', 'default-diff');
    const { deps, verifier, approver, runlog } = build({
      ws,
      verdicts: [failVerdict(), passVerdict()],
      approvals: [approve()],
      harness: [{ postHash: '1111111' }, { postHash: '2222222' }],
    });

    // No deltaVerify ⇒ default false.
    const outcome = await drive(deps, makeConfig({ goal: 'delta goal' }), runId);
    expect(outcome.status).toBe('DONE');

    // No checkpoints taken; the active baseline never advances (both judges see HEAD).
    expect((await runlog.read())!.entries.some((e) => e.event.tag === 'CHECKPOINTED')).toBe(false);
    expect(ws.baselineCalls).toEqual([]);
    expect(verifier.baselines).toEqual(['HEAD', 'HEAD']);
    // The approver diffs against the active (default) baseline exactly as before.
    expect(approver.inputs[0]!.diff).toBe('default-diff');
  });
});

describe('drive() — --delta-verify composes with --phased (issue #49)', () => {
  it('per-iteration deltas feed the judge WITHIN a phase, while the approver stays pinned to each phase start', async () => {
    const ws = new FakeWorkspace('0000000');
    // Per-baseline diff text so we can prove exactly which baseline each Sign-off reviewed.
    ws.setDiffFor('HEAD', 'cum-phase0'); // phase 0 (sub-goal one) start = run start
    ws.setDiffFor('aaaa001', 'DELTA-within-phase0'); // the per-iteration checkpoint inside phase 0
    ws.setDiffFor('aaaa002', 'cum-phase1'); // phase 1 (sub-goal two) start
    ws.setDiffFor('aaaa003', 'cum-accept'); // acceptance phase start

    // One shared "judge": phase 0 takes TWO iterations (fail → pass) so a delta checkpoint lands
    // inside it; phases 1 and acceptance pass first try. Records the baseline each verify saw.
    const judge = new RecordingVerifier([
      failVerdict(),
      passVerdict(),
      passVerdict(),
      passVerdict(),
    ]);

    const runlog = new InMemoryRunLog();
    const deps: DriverDeps = {
      compiler: new FakeCompiler(makeFakeContract({ goal: 'phase contract' })),
      seal: new FakeSealGate({ kind: 'approve' }),
      planner: new FakePlanner(makeFakePlan({ phases: [{ goal: 'one' }, { goal: 'two' }] })),
      planGate: new FakePlanGate({ kind: 'approve' }),
      // 4 agent turns: phase0-iter1, phase0-iter2, phase1, acceptance — all distinct tree hashes.
      harness: new FakeHarness(
        [{ postHash: 'aaaa001' }, { postHash: 'aaaa002' }, { postHash: 'aaaa003' }, { postHash: 'aaaa004' }],
        ws,
      ),
      makeLadder: () => judge,
      approver: new FakeApprover([]),
      workspace: ws,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog,
    };

    const approver = deps.approver as FakeApprover;
    const outcome = await drive(
      deps,
      makeConfig({ phased: true, deltaVerify: true, goal: 'big goal' }),
      runId,
    );
    expect(outcome.status).toBe('DONE');

    // The JUDGE saw the per-iteration delta inside phase 0: iteration 2 ran against the checkpoint
    // taken after iteration 1 (aaaa001), not the phase start.
    expect(judge.baselines).toEqual(['HEAD', 'aaaa001', 'aaaa002', 'aaaa003']);

    // The APPROVER stayed cumulative per phase: it reviewed each phase's WHOLE diff (against that
    // phase's start), and NEVER the shrunken within-phase delta.
    expect(approver.inputs.map((i) => i.diff)).toEqual(['cum-phase0', 'cum-phase1', 'cum-accept']);
    expect(approver.inputs.some((i) => i.diff === 'DELTA-within-phase0')).toBe(false);

    // Delta-verify was genuinely active inside the phase: a per-iteration CHECKPOINTED (tree aaaa001)
    // sits alongside the two between-phase PHASE_ADVANCED markers.
    const entries = (await runlog.read())!.entries;
    expect(entries.some((e) => e.event.tag === 'CHECKPOINTED' && e.event.tree === 'aaaa001')).toBe(true);
    expect(entries.filter((e) => e.event.tag === 'PHASE_ADVANCED')).toHaveLength(2);
  });
});
