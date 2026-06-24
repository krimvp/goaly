import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId } from '../domain/ids';
import type { Verifier } from '../verify/verifier';
import type { RunLogEntry } from '../runlog/runlog';
import {
  FakeHarness,
  FakeVerifier,
  FakeApprover,
  FakeCompiler,
  FakeSealGate,
  FakePlanner,
  FakePlanGate,
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

const runId = RunId.parse('run-phased');
const contract = makeFakeContract({ goal: 'phase contract' });
const plan = makeFakePlan({ phases: [{ goal: 'phase one' }, { goal: 'phase two' }] });

/** A passing ladder, fresh per phase (the driver rebuilds it from each phase's contract). */
function passingLadder(): () => Verifier {
  return () => new FakeVerifier([passVerdict()]);
}

function baseDeps(workspace: FakeWorkspace, runlog: InMemoryRunLog): Omit<DriverDeps, 'makeLadder'> {
  return {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    planner: new FakePlanner(plan),
    planGate: new FakePlanGate({ kind: 'approve' }),
    // 3 changing runs: phase one, phase two, acceptance — distinct hashes so no-diff never trips.
    harness: new FakeHarness(
      [{ postHash: '0000a01' }, { postHash: '0000a02' }, { postHash: '0000a03' }],
      workspace,
    ),
    approver: new FakeApprover([approve()]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
}

describe('drive() — a phased run end-to-end (issue #48)', () => {
  it('runs PLAN → per-phase contracts → cumulative ACCEPT to DONE, checkpointing between phases', async () => {
    const ws = new FakeWorkspace('0000000');
    const runlog = new InMemoryRunLog();
    const planner = new FakePlanner(plan);
    const compiler = new FakeCompiler(contract);
    const harness = new FakeHarness(
      [{ postHash: '0000a01' }, { postHash: '0000a02' }, { postHash: '0000a03' }],
      ws,
    );
    const deps: DriverDeps = {
      ...baseDeps(ws, runlog),
      planner,
      compiler,
      harness,
      makeLadder: passingLadder(),
    };
    const outcome = await drive(deps, makeConfig({ phased: true, goal: 'big goal' }), runId);

    expect(outcome.status).toBe('DONE');
    // The planner authored the plan exactly once (no re-plan on the happy path).
    expect(planner.configs).toHaveLength(1);
    // 2 sub-goals + 1 acceptance = 3 contracts compiled and 3 agent turns run.
    expect(compiler.configs).toHaveLength(3);
    expect(harness.prompts).toHaveLength(3);
    // The acceptance phase compiled against the ORIGINAL goal (not a sub-goal).
    expect(compiler.configs[2]!.goal).toBe('big goal');
    // A checkpoint was taken after each of the two sub-goal phases (NOT after acceptance).
    const checkpoints = runlog.entries.filter((e) => e.event.tag === 'PHASE_ADVANCED');
    expect(checkpoints).toHaveLength(2);
    // The plan was logged (frozen + auditable) and never re-authored.
    expect(runlog.entries.filter((e) => e.event.tag === 'PLAN_COMPILED')).toHaveLength(1);
  });

  it('the between-phase checkpoint scopes each phase: phase N+1 diffs against phase N’s snapshot', async () => {
    const ws = new FakeWorkspace('0000000');
    const runlog = new InMemoryRunLog();
    const deps: DriverDeps = { ...baseDeps(ws, runlog), makeLadder: passingLadder() };
    await drive(deps, makeConfig({ phased: true }), runId);
    // Each checkpoint adopted the post-phase tree as the new diff baseline (issue #47) — so the next
    // phase's diff() excludes the previous phase's committed-to-baseline work. Two sub-goal phases ⇒
    // two baselines adopted, the snapshots taken after phase one and phase two ran.
    expect(ws.baselineCalls).toEqual(['0000a01', '0000a02']);
  });

  it('all phases pass but acceptance FAILS ⇒ whole run FAILED (decomposition cannot green a broken whole)', async () => {
    const ws = new FakeWorkspace('0000000');
    const runlog = new InMemoryRunLog();
    // The sub-goal ladders pass; the acceptance ladder (3rd verify call) fails — with maxIterations 1
    // the acceptance phase exhausts its budget and the WHOLE run fails.
    let verifyCount = 0;
    const makeLadder = (): Verifier => ({
      async verify() {
        verifyCount += 1;
        return verifyCount <= 2 ? passVerdict() : failVerdict('acceptance: end-to-end broken');
      },
    });
    const deps: DriverDeps = { ...baseDeps(ws, runlog), makeLadder };
    const outcome = await drive(deps, makeConfig({ phased: true, maxIterations: 1, goal: 'whole goal' }), runId);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('acceptance phase');
  });

  it('a planner error is a typed, fail-closed FAILED (never a skipped decomposition)', async () => {
    const ws = new FakeWorkspace('0000000');
    const runlog = new InMemoryRunLog();
    const deps: DriverDeps = {
      ...baseDeps(ws, runlog),
      planner: new FakePlanner(new Error('LLM produced no JSON')),
      makeLadder: passingLadder(),
    };
    const outcome = await drive(deps, makeConfig({ phased: true }), runId);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('LLM produced no JSON');
  });

  it('a plan exceeding --max-phases is a fail-closed PLAN_FAILED', async () => {
    const ws = new FakeWorkspace('0000000');
    const runlog = new InMemoryRunLog();
    const bigPlan = makeFakePlan({ phases: [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }] });
    const deps: DriverDeps = {
      ...baseDeps(ws, runlog),
      planner: new FakePlanner(bigPlan),
      makeLadder: passingLadder(),
    };
    const outcome = await drive(deps, makeConfig({ phased: true, maxPhases: 2 }), runId);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('exceeding --max-phases');
  });

  it('--resume re-enters mid-plan without repeating completed phases, reconstructing the baseline', async () => {
    // 1. Drive a full phased run, capturing the whole event log.
    const ws = new FakeWorkspace('0000000');
    const log = new InMemoryRunLog();
    await drive({ ...baseDeps(ws, log), makeLadder: passingLadder() }, makeConfig({ phased: true }), runId);
    expect(log.entries.some((e) => e.event.tag === 'PHASE_ADVANCED')).toBe(true);

    // 2. Truncate the log to just after phase 0's checkpoint (phase 1 not yet compiled), as if the
    //    process had crashed there.
    const firstAdvance = log.entries.findIndex((e) => e.event.tag === 'PHASE_ADVANCED');
    const prefix: RunLogEntry[] = log.entries.slice(0, firstAdvance + 1);
    const resumeLog = new InMemoryRunLog();
    resumeLog.header = log.header;
    resumeLog.entries = prefix;
    const phase0Tree = (() => {
      const e = prefix[firstAdvance]!;
      return e.event.tag === 'PHASE_ADVANCED' ? e.event.tree : '';
    })();

    // 3. Resume with a planner that THROWS if called (the plan is done — re-planning would be a bug)
    //    and a fresh harness scripted for ONLY the remaining work (phase 1 + acceptance = 2 runs).
    const ws2 = new FakeWorkspace('0000a01');
    const harness2 = new FakeHarness([{ postHash: '0000a02' }, { postHash: '0000a03' }], ws2);
    const resumeDeps: DriverDeps = {
      compiler: new FakeCompiler(contract),
      seal: new FakeSealGate({ kind: 'approve' }),
      planner: new FakePlanner(new Error('must not re-plan a frozen plan on resume')),
      planGate: new FakePlanGate({ kind: 'reject', reason: 'must not re-seal' }),
      harness: harness2,
      makeLadder: passingLadder(),
      approver: new FakeApprover([approve()]),
      workspace: ws2,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog: resumeLog,
    };
    const outcome = await drive(resumeDeps, makeConfig({ phased: true }), runId, { resume: true });

    expect(outcome.status).toBe('DONE');
    // Phase 0 was NOT repeated: only phase 1 + acceptance ran on resume (2 turns, not 3).
    expect(harness2.prompts).toHaveLength(2);
    // The FIRST baseline adopted on resume was phase 0's logged checkpoint (reconstructed from the
    // log); phase 1 then took its own checkpoint, advancing it further.
    expect(ws2.baselineCalls[0]).toBe(phase0Tree);
  });
});
