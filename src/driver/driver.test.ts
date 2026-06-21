import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import type { RunLog } from '../runlog/runlog';
import { RunId } from '../domain/ids';
import type { RunConfig } from '../domain/config';
import type { Verdict, ApprovalVerdict } from '../domain/verdict';
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
  veto,
  approve,
  type FakeRunScript,
} from '../testing/fakes';

const runId = RunId.parse('run-1');
const contract = makeFakeContract({ goal: 'make the thing work' });

type Wiring = {
  config?: RunConfig;
  scripts: FakeRunScript[];
  verdicts: Verdict[];
  approvals?: ApprovalVerdict[];
  gate?: FakeGate;
  budget?: ManualBudgetMeter;
  workspace?: FakeWorkspace;
  runlog?: InMemoryRunLog;
};

function wire(w: Wiring): {
  deps: DriverDeps;
  harness: FakeHarness;
  runlog: InMemoryRunLog;
  approver: FakeApprover;
} {
  const workspace = w.workspace ?? new FakeWorkspace('0000000', 'a fake diff');
  const harness = new FakeHarness(w.scripts, workspace);
  const ladder = new FakeVerifier(w.verdicts);
  const runlog = w.runlog ?? new InMemoryRunLog();
  const approver = new FakeApprover(w.approvals ?? []);
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    gateA: w.gate ?? new FakeGate({ kind: 'approve' }),
    harness,
    makeLadder: () => ladder,
    approver,
    workspace,
    clock: new ManualClock(),
    budget: w.budget ?? new ManualBudgetMeter(false),
    runlog,
  };
  return { deps, harness, runlog, approver };
}

describe('drive() — full loop with zero IO', () => {
  it('scripted pass on iter 3, one veto → DONE on iter 4', async () => {
    const { deps, harness, runlog } = wire({
      config: makeConfig({ goal: 'make the thing work', maxIterations: 10 }),
      scripts: [
        { postHash: '0000001' },
        { postHash: '0000002' },
        { postHash: '0000003' },
        { postHash: '0000004' },
      ],
      verdicts: [failVerdict('red'), failVerdict('red2'), passVerdict(), passVerdict()],
      approvals: [veto('the test looks empty'), approve()],
    });

    const outcome = await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);

    expect(outcome.status).toBe('DONE');
    expect(outcome.iterations).toBe(4);
    expect(outcome.contractHash).toBe(contract.contractHash);

    // The 4th prompt must carry the veto reason as feedback (not a silent retry).
    expect(harness.prompts).toHaveLength(4);
    expect(harness.prompts[3]).toContain('the test looks empty');

    // The bar never moved: every logged contractHash (post-compile) is identical.
    const hashes = runlog.entries
      .map((e) => e.contractHash)
      .filter((h): h is NonNullable<typeof h> => h !== null);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(contract.contractHash);
  });

  it('FAILED when maxIterations is reached without satisfying the contract', async () => {
    const { deps, approver } = wire({
      scripts: [{ postHash: '0000001' }, { postHash: '0000002' }, { postHash: '0000003' }],
      verdicts: [failVerdict('e1'), failVerdict('e2'), failVerdict('e3')],
    });
    const outcome = await drive(deps, makeConfig({ maxIterations: 3 }), runId);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.iterations).toBe(3);
    expect(outcome.reason).toContain('maxIterations');
    // Two keys: Gate B is never consulted on an all-red run.
    expect(approver.inputs).toHaveLength(0);
  });

  it('ABORTED on no-diff when an iteration changes nothing', async () => {
    const { deps, approver } = wire({
      // iter1 changes the tree; iter2 leaves it identical (no postHash) → no-diff.
      scripts: [{ postHash: '0000001' }, {}],
      verdicts: [failVerdict('x'), failVerdict('x')],
    });
    const outcome = await drive(deps, makeConfig({ maxIterations: 10 }), runId);
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('no-diff');
    expect(outcome.iterations).toBe(2);
    expect(approver.inputs).toHaveLength(0);
  });

  it('fail-closed: a harness that throws is caught and mapped to a crashed run (never rejects)', async () => {
    const { deps } = wire({
      // The agent process dies on the only run; the loop must not crash.
      scripts: [{ throwError: 'agent exploded' }],
      verdicts: [failVerdict('x')],
    });
    const outcome = await drive(deps, makeConfig({ maxIterations: 1 }), runId);
    // A crashed run still produces an AGENT_RAN event; the verifier fails → terminal, no reject.
    expect(['FAILED', 'ABORTED']).toContain(outcome.status);
  });

  it('ABORTED on budget exhaustion independent of iteration count', async () => {
    const { deps } = wire({
      scripts: [{ postHash: '0000001' }],
      verdicts: [failVerdict('x')],
      budget: new ManualBudgetMeter(true),
    });
    const outcome = await drive(deps, makeConfig({ maxIterations: 10 }), runId);
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toBe('budget exceeded');
  });

  it('ABORTED when the contract is rejected at Gate A (and the loop never starts)', async () => {
    const { deps, harness } = wire({
      scripts: [{ postHash: '0000001' }],
      verdicts: [passVerdict()],
      gate: new FakeGate({ kind: 'reject', reason: 'bar is wrong' }),
    });
    const outcome = await drive(deps, makeConfig(), runId);
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toBe('bar is wrong');
    expect(harness.prompts).toHaveLength(0);
  });

  it('Gate A revise re-authors the contract, then the APPROVED contract runs the loop', async () => {
    const draft = makeFakeContract({ goal: 'draft bar' });
    const revised = makeFakeContract({ goal: 'revised bar' });
    expect(draft.contractHash).not.toBe(revised.contractHash);

    const ws = new FakeWorkspace('0000000', 'diff');
    const harness = new FakeHarness([{ postHash: '0000001' }], ws);
    const compiler = new FakeCompiler([draft, revised]);
    const runlog = new InMemoryRunLog();
    const deps: DriverDeps = {
      compiler,
      gateA: new FakeGate([
        { kind: 'revise', feedback: 'make the bar stricter' },
        { kind: 'approve' },
      ]),
      harness,
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([approve()]),
      workspace: ws,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(),
      runlog,
    };

    const outcome = await drive(deps, makeConfig({ maxIterations: 10 }), runId);

    // The loop ran against the APPROVED (revised) contract — only it is ever used.
    expect(outcome.status).toBe('DONE');
    expect(outcome.contractHash).toBe(revised.contractHash);
    // The compiler was re-invoked WITH the human's feedback on the second pass.
    expect(compiler.feedbacks).toEqual([undefined, 'make the bar stricter']);
    // The first agent prompt is built from the approved contract's goal, not the draft's.
    expect(harness.prompts[0]).toContain('revised bar');
    expect(harness.prompts[0]).not.toContain('draft bar');
    // Both frozen contracts are audited in the log (the renegotiation is visible).
    const hashes = new Set(
      runlog.entries
        .map((e) => e.contractHash)
        .filter((h): h is NonNullable<typeof h> => h !== null),
    );
    expect(hashes.has(draft.contractHash)).toBe(true);
    expect(hashes.has(revised.contractHash)).toBe(true);
  });

  it('Gate A revise past the cap → ABORTED without ever starting the loop', async () => {
    const draft = makeFakeContract({ goal: 'draft' });
    const ws = new FakeWorkspace('0000000', 'diff');
    const harness = new FakeHarness([{ postHash: '0000001' }], ws);
    const deps: DriverDeps = {
      compiler: new FakeCompiler(draft),
      gateA: new FakeGate([{ kind: 'revise', feedback: 'again' }]), // clamps → always revises
      harness,
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([approve()]),
      workspace: ws,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(),
      runlog: new InMemoryRunLog(),
    };
    const outcome = await drive(deps, makeConfig({ maxGateARevisions: 2 }), runId);
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('revision cap');
    expect(harness.prompts).toHaveLength(0);
  });

  it('FAILED when the compiler throws (no contract ever frozen)', async () => {
    const workspace = new FakeWorkspace();
    const deps: DriverDeps = {
      compiler: new FakeCompiler(new Error('cannot author a verifier')),
      gateA: new FakeGate(),
      harness: new FakeHarness([], workspace),
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([]),
      workspace,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(),
      runlog: new InMemoryRunLog(),
    };
    const outcome = await drive(deps, makeConfig(), runId);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('cannot author a verifier');
    expect(outcome.contractHash).toBeNull();
  });

  it('every event is persisted write-ahead before the next step', async () => {
    const { deps, runlog } = wire({
      scripts: [{ postHash: '0000001' }],
      verdicts: [passVerdict()],
      approvals: [approve()],
    });
    await drive(deps, makeConfig(), runId);
    // seq is strictly increasing from 1, and the last entry lands on a terminal tag.
    expect(runlog.entries.map((e) => e.seq)).toEqual(
      runlog.entries.map((_, i) => i + 1),
    );
    expect(runlog.entries.at(-1)?.stateTagAfter).toBe('DONE');
  });
});

/** An InMemoryRunLog whose Nth append throws — simulating a process kill mid-persist. */
function crashAfter(inner: InMemoryRunLog, failOnAppend: number): RunLog {
  let appends = 0;
  return {
    writeHeader: (h) => inner.writeHeader(h),
    append: async (e) => {
      appends += 1;
      if (appends === failOnAppend) throw new Error('disk died');
      await inner.append(e);
    },
    read: () => inner.read(),
  };
}

describe('drive() — resume', () => {
  it('reconstructs from a mid-loop log (after a persist crash) and never repeats a completed iteration', async () => {
    const inner = new InMemoryRunLog();
    // The 5th append never lands: seq1-4 (compile, gateA, iter1 run, iter1 verify) persist; iter2's
    // AGENT_RAN does not. The hardened driver fail-closes to ABORTED rather than rejecting.
    const ws1 = new FakeWorkspace('0000000', 'diff');
    const deps1: DriverDeps = {
      compiler: new FakeCompiler(contract),
      gateA: new FakeGate(),
      harness: new FakeHarness([{ postHash: '0000001' }, { postHash: '0000002' }], ws1),
      makeLadder: () => new FakeVerifier([failVerdict('e1'), failVerdict('e2')]),
      approver: new FakeApprover([]),
      workspace: ws1,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(),
      runlog: crashAfter(inner, 5),
    };
    const crashed = await drive(deps1, makeConfig({ maxIterations: 10 }), runId);
    expect(crashed.status).toBe('ABORTED'); // fail-closed, not a rejection
    expect((await inner.read())?.entries).toHaveLength(4);

    // Resume with fresh fakes; only the unfinished iteration re-runs.
    const ws2 = new FakeWorkspace('0000002', 'diff');
    const freshHarness = new FakeHarness([{ postHash: '0000003' }], ws2);
    const deps2: DriverDeps = {
      compiler: new FakeCompiler(new Error('compile must not run on resume')),
      gateA: new FakeGate({ kind: 'reject', reason: 'gate must not run on resume' }),
      harness: freshHarness,
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([approve()]),
      workspace: ws2,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(),
      runlog: inner,
    };
    const outcome = await drive(deps2, makeConfig({ maxIterations: 10 }), runId, { resume: true });

    expect(outcome.status).toBe('DONE');
    expect(outcome.iterations).toBe(2); // iter1 replayed from the log; only iter2 re-run
    expect(freshHarness.prompts).toHaveLength(1); // proves no completed iteration was repeated
  });

  it('resumes from a log ending right after CONTRACT_COMPILED (replay into AWAIT_GATE_A)', async () => {
    const inner = new InMemoryRunLog();
    // Crash on the 2nd append: only CONTRACT_COMPILED persists; the run stalls in AWAIT_GATE_A.
    const ws1 = new FakeWorkspace('0000000', 'diff');
    const deps1: DriverDeps = {
      compiler: new FakeCompiler(contract),
      gateA: new FakeGate(),
      harness: new FakeHarness([{ postHash: '0000001' }], ws1),
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([approve()]),
      workspace: ws1,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(),
      runlog: crashAfter(inner, 2),
    };
    await drive(deps1, makeConfig(), runId);
    expect((await inner.read())?.entries).toHaveLength(1);

    // Resume: compile must NOT run again; Gate A onward proceeds to DONE.
    const ws2 = new FakeWorkspace('0000000', 'diff');
    const deps2: DriverDeps = {
      compiler: new FakeCompiler(new Error('compile must not run on resume')),
      gateA: new FakeGate({ kind: 'approve' }),
      harness: new FakeHarness([{ postHash: '0000009' }], ws2),
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([approve()]),
      workspace: ws2,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(),
      runlog: inner,
    };
    const outcome = await drive(deps2, makeConfig(), runId, { resume: true });
    expect(outcome.status).toBe('DONE');
    expect(outcome.iterations).toBe(1);
  });

  it('resuming an already-terminal log returns the terminal outcome with no further effects', async () => {
    const runlog = new InMemoryRunLog();
    const { deps } = wire({
      scripts: [{ postHash: '0000001' }],
      verdicts: [passVerdict()],
      approvals: [approve()],
      runlog,
    });
    const first = await drive(deps, makeConfig(), runId);
    expect(first.status).toBe('DONE');

    // Resume from the finished log: every effectful dep throws if touched.
    const ws = new FakeWorkspace('0000001', 'diff');
    const resumeDeps: DriverDeps = {
      compiler: new FakeCompiler(new Error('must not run')),
      gateA: new FakeGate({ kind: 'reject', reason: 'must not run' }),
      harness: new FakeHarness([{ throwError: 'must not run' }], ws),
      makeLadder: () => new FakeVerifier([failVerdict('must not run')]),
      approver: new FakeApprover([]),
      workspace: ws,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(),
      runlog,
    };
    const resumed = await drive(resumeDeps, makeConfig(), runId, { resume: true });
    expect(resumed.status).toBe('DONE');
    expect(resumed.iterations).toBe(first.iterations);
  });
});
