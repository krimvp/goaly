import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId } from '../domain/ids';
import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import {
  FakeHarness,
  FakeVerifier,
  FakeApprover,
  FakeCompiler,
  FakeGate,
  FakePlanner,
  FakePlanGate,
  FakeWorkspace,
  ManualClock,
  ManualBudgetMeter,
  InMemoryRunLog,
  makeFakeContract,
  makeConfig,
  makePlan,
  passVerdict,
  failVerdict,
  approve,
  type FakeRunScript,
} from '../testing/fakes';

const runId = RunId.parse('run-phased');

/** A frozen contract whose goal (and thus hash) is distinct per phase. */
const contractFor = (goal: string): CompiledContract => makeFakeContract({ goal });

// A two-sub-goal plan; the run executes phase0, phase1, then the cumulative acceptance phase.
const plan = makePlan('build the parser', 'wire it into the CLI');
const ACCEPTANCE_GOAL = 'the whole feature';

/** Per-phase contracts the FakeCompiler hands back, in execution order (acceptance last). */
const phaseContracts = [
  contractFor('build the parser'),
  contractFor('wire it into the CLI'),
  contractFor(ACCEPTANCE_GOAL),
];

type PhasedWiring = {
  config?: RunConfig;
  scripts: FakeRunScript[];
  /** A ladder factory keyed on the contract's goal, so acceptance can pass or fail independently. */
  ladderFor?: (goal: string) => FakeVerifier;
  approvals?: ReturnType<typeof approve>[];
  workspace?: FakeWorkspace;
  runlog?: InMemoryRunLog;
  budget?: ManualBudgetMeter;
};

function wirePhased(w: PhasedWiring): {
  deps: DriverDeps;
  workspace: FakeWorkspace;
  runlog: InMemoryRunLog;
  planner: FakePlanner;
} {
  const workspace = w.workspace ?? new FakeWorkspace('0000000', 'a fake diff');
  const harness = new FakeHarness(w.scripts, workspace);
  const runlog = w.runlog ?? new InMemoryRunLog();
  const planner = new FakePlanner(plan);
  const ladderFor = w.ladderFor ?? (() => new FakeVerifier([passVerdict()]));
  const deps: DriverDeps = {
    compiler: new FakeCompiler([...phaseContracts]),
    gateA: new FakeGate({ kind: 'approve' }),
    planner,
    planGate: new FakePlanGate({ kind: 'approve' }),
    harness,
    makeLadder: (contract) => ladderFor(contract.goal),
    approver: new FakeApprover(w.approvals ?? [approve(), approve(), approve()]),
    workspace,
    clock: new ManualClock(),
    budget: w.budget ?? new ManualBudgetMeter(false),
    runlog,
  };
  return { deps, workspace, runlog, planner };
}

const phasedConfig = makeConfig({ goal: ACCEPTANCE_GOAL, phased: true, maxIterations: 3 });

describe('drive() — phased run (issue #48), zero IO', () => {
  it('PLAN → per-phase frozen contracts → cumulative ACCEPT, checkpointing between phases', async () => {
    const { deps, workspace, runlog } = wirePhased({
      // one agent run per phase (phase0, phase1, acceptance), each changing the tree.
      scripts: [{ postHash: '0000001' }, { postHash: '0000002' }, { postHash: '0000003' }],
    });

    const outcome = await drive(deps, phasedConfig, runId);

    expect(outcome.status).toBe('DONE');
    // One iteration per phase (2 sub-goals + acceptance) = 3.
    expect(outcome.iterations).toBe(3);
    // The acceptance contract's hash is the one that turned the final two keys.
    expect(outcome.contractHash).toBe(contractFor(ACCEPTANCE_GOAL).contractHash);

    const events = runlog.entries.map((e) => e.event);
    // The plan was authored, frozen, and logged loudly with its hash.
    const planCompiled = events.find((e) => e.tag === 'PLAN_COMPILED');
    expect(planCompiled).toBeDefined();
    if (planCompiled?.tag === 'PLAN_COMPILED') expect(planCompiled.plan.planHash).toBe(plan.planHash);
    // Three contracts were frozen — one per sub-goal plus the cumulative acceptance.
    expect(events.filter((e) => e.tag === 'CONTRACT_COMPILED')).toHaveLength(3);
    // A checkpoint was taken BETWEEN phases (after phase0 and phase1) — but NOT after acceptance.
    expect(events.filter((e) => e.tag === 'PHASE_CHECKPOINTED')).toHaveLength(2);
    expect(workspace.baselineCalls).toEqual(['0000001', '0000002']);
  });

  it('all phases DONE but acceptance fails ⇒ run FAILED (decomposition cannot green a broken whole)', async () => {
    const { deps, runlog } = wirePhased({
      // phase0 + phase1 pass on iter 1; acceptance then fails every iteration up to the cap.
      scripts: [
        { postHash: '0000001' },
        { postHash: '0000002' },
        { postHash: '0000003' },
        { postHash: '0000004' },
        { postHash: '0000005' },
      ],
      // The acceptance contract (original goal) never passes its ladder; the sub-goals do. Distinct
      // failure details per iteration so the run reaches maxIterations as a FAILED (not a stuck ABORT).
      ladderFor: (goal) =>
        goal === ACCEPTANCE_GOAL
          ? new FakeVerifier([failVerdict('not wired 1'), failVerdict('not wired 2'), failVerdict('not wired 3')])
          : new FakeVerifier([passVerdict()]),
      approvals: [approve(), approve()], // acceptance never reaches Gate B
    });

    const outcome = await drive(deps, phasedConfig, runId);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('cumulative acceptance phase');
    // Both sub-goal phases still completed (two checkpoints were taken before acceptance ran).
    expect(
      runlog.entries.filter((e) => e.event.tag === 'PHASE_CHECKPOINTED'),
    ).toHaveLength(2);
  });

  it('an unparseable / failing plan ⇒ typed FAILED before any phase (fail-closed)', async () => {
    const workspace = new FakeWorkspace('0000000');
    const deps: DriverDeps = {
      compiler: new FakeCompiler(new Error('must not compile')),
      gateA: new FakeGate({ kind: 'approve' }),
      planner: new FakePlanner(new Error('planner could not produce a plan')),
      planGate: new FakePlanGate({ kind: 'approve' }),
      harness: new FakeHarness([{ throwError: 'must not run' }], workspace),
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([]),
      workspace,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog: new InMemoryRunLog(),
    };
    const outcome = await drive(deps, phasedConfig, runId);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('planner could not produce a plan');
    expect(outcome.contractHash).toBeNull();
  });

  it('--resume re-enters mid-plan without repeating the planner or completed phases', async () => {
    // Drive a full phased run to DONE to obtain a realistic log.
    const ws1 = new FakeWorkspace('0000000', 'diff');
    const log = new InMemoryRunLog();
    const first = wirePhased({
      scripts: [{ postHash: '0000001' }, { postHash: '0000002' }, { postHash: '0000003' }],
      workspace: ws1,
      runlog: log,
    });
    expect((await drive(first.deps, phasedConfig, runId)).status).toBe('DONE');

    // Truncate the log to just AFTER the first phase's checkpoint — i.e. resume should re-enter at
    // phase 1 (the second sub-goal), never re-running the planner, plan gate, or phase 0.
    const firstCheckpointIdx = log.entries.findIndex((e) => e.event.tag === 'PHASE_CHECKPOINTED');
    expect(firstCheckpointIdx).toBeGreaterThan(0);
    const resumeLog = new InMemoryRunLog();
    resumeLog.header = log.header;
    resumeLog.entries = log.entries.slice(0, firstCheckpointIdx + 1);

    // Resume deps: the planner and plan gate MUST NOT run (they throw if they do); only phase 1 and
    // the acceptance phase remain, so the compiler hands back exactly those two contracts.
    const ws2 = new FakeWorkspace('0000000', 'diff');
    const planner2 = new FakePlanner(new Error('planner must not run on resume'));
    const resumeDeps: DriverDeps = {
      compiler: new FakeCompiler([contractFor('wire it into the CLI'), contractFor(ACCEPTANCE_GOAL)]),
      gateA: new FakeGate({ kind: 'approve' }),
      planner: planner2,
      planGate: new FakePlanGate({ kind: 'reject', reason: 'plan gate must not run on resume' }),
      harness: new FakeHarness([{ postHash: '0000022' }, { postHash: '0000033' }], ws2),
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([approve(), approve()]),
      workspace: ws2,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog: resumeLog,
    };
    const outcome = await drive(resumeDeps, phasedConfig, runId, { resume: true });

    expect(outcome.status).toBe('DONE');
    // The planner was never re-invoked (the plan is replayed from the log, not re-authored).
    expect(planner2.configs).toEqual([]);
    // The FIRST baseline adopted on resume is the reconstruction from phase 0's checkpoint tree
    // (the run then advances it again with phase 1's own checkpoint).
    expect(ws2.baselineCalls[0]).toBe('0000001');
  });

  it('budget is a whole-run cap: spend accumulates across phases, never resets', async () => {
    const budget = new ManualBudgetMeter(false);
    const { deps } = wirePhased({
      scripts: [
        { postHash: '0000001', tokensUsed: 100 },
        { postHash: '0000002', tokensUsed: 100 },
        { postHash: '0000003', tokensUsed: 100 },
      ],
      budget,
    });
    const outcome = await drive(deps, phasedConfig, runId);
    expect(outcome.status).toBe('DONE');
    // The meter saw all three phases' harness spend summed (300), not a per-phase reset.
    expect(budget.snapshot().tokensSpent).toBe(300);
  });
});
