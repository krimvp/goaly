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
  FakeSealGate,
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
  recordingLogger,
  type FakeRunScript,
} from '../testing/fakes';
import type { Logger, LogRecord } from '../log/logger';

const runId = RunId.parse('run-1');
const contract = makeFakeContract({ goal: 'make the thing work' });

type Wiring = {
  config?: RunConfig;
  scripts: FakeRunScript[];
  verdicts: Verdict[];
  approvals?: ApprovalVerdict[];
  gate?: FakeSealGate;
  budget?: ManualBudgetMeter;
  workspace?: FakeWorkspace;
  runlog?: InMemoryRunLog;
  logger?: Logger;
  /** Override the compiler (e.g. to script a COMPILE_FAILED then a success for the retry path). */
  compiler?: FakeCompiler;
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
    compiler: w.compiler ?? new FakeCompiler(contract),
    seal: w.gate ?? new FakeSealGate({ kind: 'approve' }),
    harness,
    makeLadder: () => ladder,
    approver,
    workspace,
    clock: new ManualClock(),
    budget: w.budget ?? new ManualBudgetMeter(false),
    runlog,
    ...(w.logger !== undefined ? { logger: w.logger } : {}),
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

  it('runs setup + pre-flight before iteration 1, then completes the loop (Fix #1/#2)', async () => {
    const setupContract = makeFakeContract({ goal: 'make the thing work', setup: 'npm ci' });
    // Workspace.run returns exit 0 for the setup command AND the deterministic pre-flight rung.
    const workspace = new FakeWorkspace('0000000', 'a fake diff');
    const { deps, harness, runlog } = wire({
      workspace,
      compiler: new FakeCompiler(setupContract),
      scripts: [{ postHash: '0000001' }],
      verdicts: [passVerdict()],
      approvals: [approve()],
    });

    const outcome = await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);

    expect(outcome.status).toBe('DONE');
    expect(harness.prompts).toHaveLength(1);
    // The prepare phase was persisted write-ahead (so --resume reconstructs it) and proceeded.
    const prepared = runlog.entries.find((e) => e.event.tag === 'WORKSPACE_PREPARED');
    expect(prepared?.event).toMatchObject({ tag: 'WORKSPACE_PREPARED', setupRan: true });
  });

  it('a failing USER --setup-cmd → FAILED (SETUP_FAILED) before any worker turn (Fix #1)', async () => {
    const setupContract = makeFakeContract({ goal: 'make the thing work', setup: 'npm ci' });
    // First workspace.run (the setup command) exits non-zero → SETUP_FAILED, loop never starts.
    const workspace = new FakeWorkspace('0000000', 'a fake diff', [
      { exitCode: 1, stdout: '', stderr: 'could not resolve dependencies' },
    ]);
    const { deps, harness } = wire({
      workspace,
      compiler: new FakeCompiler(setupContract),
      scripts: [],
      verdicts: [],
    });

    // A user-supplied --setup-cmd (config.setupCmd set) is enforced fatally — setupAuthored=false.
    const outcome = await drive(
      deps,
      makeConfig({ goal: 'make the thing work', setupCmd: 'npm ci' }),
      runId,
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('SETUP_FAILED');
    expect(outcome.iterations).toBe(0);
    expect(harness.prompts).toHaveLength(0); // never handed the worker a broken tree
  });

  it('a failing AUTHORED setup is best-effort: proceeds to the loop with a setup-note prompt (Fix A)', async () => {
    const setupContract = makeFakeContract({ goal: 'make the thing work', setup: 'go mod download' });
    // The authored setup exits non-zero (from-scratch: no go.mod yet), then the pre-flight rung is red,
    // then the agent's run makes the workspace change and verification passes.
    const workspace = new FakeWorkspace('0000000', 'a fake diff', [
      { exitCode: 1, stdout: '', stderr: 'go.mod file not found in current directory' },
      { exitCode: 1, stdout: '', stderr: 'build failed' }, // pre-flight rung (red — honest)
    ]);
    const { deps, harness, runlog } = wire({
      workspace,
      compiler: new FakeCompiler(setupContract),
      scripts: [{ postHash: '0000001' }],
      verdicts: [passVerdict()],
      approvals: [approve()],
    });

    // No --setup-cmd ⇒ setupAuthored=true ⇒ the failure degrades to proceed instead of SETUP_FAILED.
    const outcome = await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);

    expect(outcome.status).toBe('DONE');
    expect(harness.prompts).toHaveLength(1);
    // The first prompt carries the setup note so the agent scaffolds + runs setup itself.
    expect(harness.prompts[0]).toContain('go mod download');
    expect(harness.prompts[0]).toContain('Setup note');
    // The prepare phase still proceeded (best-effort), not a typed abort.
    const prepared = runlog.entries.find((e) => e.event.tag === 'WORKSPACE_PREPARED');
    expect(prepared?.event).toMatchObject({
      tag: 'WORKSPACE_PREPARED',
      setupRan: true,
      prepared: { status: 'proceed' },
    });
  });

  it('from-scratch --generate --autonomous with BOTH an authored setup and a build rung reaches the loop → DONE (Fix A+B1)', async () => {
    // This is the §1 Round-B failure: the compiler authors `go mod download` (setup) AND `go build`
    // (deterministic rung); on the empty starting tree both are red, which used to kill the run at
    // iteration 0 via SETUP_FAILED / CONTRACT_UNSOUND. With Fix A (authored setup best-effort) + Fix B1
    // (from-scratch skips the soundness pre-flight) the run must reach the agent loop instead.
    const contractFromScratch = makeFakeContract({
      goal: 'build a Go MCP server',
      setup: 'go mod download',
      rungs: [{ kind: 'deterministic', command: 'go build ./...' }],
      generatedFiles: [{ path: 'verify/server_test.go', sha256: 'a'.repeat(64) }],
    });
    const workspace = new FakeWorkspace('0000000', 'a fake diff', [
      // The authored setup is red on the empty tree (no go.mod yet) — best-effort, non-fatal.
      { exitCode: 1, stdout: '', stderr: 'go.mod file not found in current directory' },
    ]);
    workspace.setEmptyOfSource(true); // from-scratch ⇒ the soundness pre-flight is skipped entirely
    const { deps, harness } = wire({
      workspace,
      compiler: new FakeCompiler(contractFromScratch),
      scripts: [{ postHash: '0000001' }], // the agent writes the implementation
      verdicts: [passVerdict()],
      approvals: [approve()],
    });

    const outcome = await drive(
      deps,
      makeConfig({ goal: 'build a Go MCP server', autonomous: true, verifier: { kind: 'generate' } }),
      runId,
    );

    expect(outcome.status).toBe('DONE');
    expect(harness.prompts).toHaveLength(1); // it reached the agent loop (no iteration-0 death)
    expect(harness.prompts[0]).toContain('Setup note'); // the authored-setup failure surfaced as a hint
  });

  it('a missing required tool + --install-missing-tools false → FAILED (TOOLS_MISSING) before any worker turn', async () => {
    const toolContract = makeFakeContract({ goal: 'build it', requiredTools: ['cargo'] });
    // The tool probe is the first workspace.run; its stdout names the missing program.
    const workspace = new FakeWorkspace('0000000', 'a fake diff', [
      { exitCode: 0, stdout: 'cargo\n', stderr: '' },
    ]);
    const { deps, harness } = wire({
      workspace,
      compiler: new FakeCompiler(toolContract),
      scripts: [],
      verdicts: [],
    });

    const outcome = await drive(
      deps,
      makeConfig({ goal: 'build it', installMissingTools: false }),
      runId,
    );

    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('TOOLS_MISSING');
    expect(outcome.reason).toContain('cargo');
    expect(outcome.iterations).toBe(0);
    expect(harness.prompts).toHaveLength(0); // never spent a worker turn
  });

  it('retries a COMPILE_FAILED with the error fed back, then proceeds (issue #51)', async () => {
    const compiler = new FakeCompiler([
      new Error('refusing a verification command that references an out-of-repo path /tmp/x.sh'),
      contract,
    ]);
    const { deps } = wire({
      compiler,
      scripts: [{ postHash: '0000001' }],
      verdicts: [passVerdict()],
      approvals: [approve()],
    });

    const outcome = await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);

    expect(outcome.status).toBe('DONE');
    // Two compile attempts: the first with no feedback, the retry carrying the error text.
    expect(compiler.feedbacks).toHaveLength(2);
    expect(compiler.feedbacks[0]).toBeUndefined();
    expect(compiler.feedbacks[1]).toContain('out-of-repo path');
  });

  it('a typed FAILED once the compile-retry budget is exhausted (issue #51)', async () => {
    const compiler = new FakeCompiler(new Error('still bad path /tmp/y.sh'));
    const { deps } = wire({
      config: makeConfig({ maxCompileRetries: 1 }),
      compiler,
      scripts: [],
      verdicts: [],
    });

    const outcome = await drive(deps, makeConfig({ maxCompileRetries: 1 }), runId);

    expect(outcome.status).toBe('FAILED');
    expect(outcome.contractHash).toBeNull();
    // maxCompileRetries: 1 ⇒ the initial attempt + one retry = 2 compile calls, then terminal.
    expect(compiler.feedbacks).toHaveLength(2);
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
    // Two keys: Sign-off is never consulted on an all-red run.
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

  it('ABORTED (STUCK_HARNESS_CRASH) after two consecutive harness crashes — fast and named, not a 6-iteration repeat-failure', async () => {
    // The real incident: the agent CLI crashed every turn (status=crashed), leaving a stale verifier
    // red that repeated. The loop must stop after the crash streak (2) with a harness-focused reason,
    // not churn until the downstream verifier signature trips STUCK_REPEATED_FAILURE.
    const { deps } = wire({
      scripts: [
        { status: 'crashed', output: 'claude: command not found', postHash: '0000001' },
        { status: 'crashed', output: 'claude: command not found', postHash: '0000002' },
        { status: 'crashed', output: 'claude: command not found', postHash: '0000003' },
      ],
      verdicts: [failVerdict('ImportError'), failVerdict('ImportError'), failVerdict('ImportError')],
    });
    const outcome = await drive(deps, makeConfig({ maxIterations: 10 }), runId);
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.iterations).toBe(2); // bailed after the 2nd crash, not the 6th
    expect(outcome.reason).toContain('STUCK_HARNESS_CRASH');
    expect(outcome.reason).toContain('claude: command not found');
    expect(outcome.reason).not.toContain('STUCK_REPEATED_FAILURE');
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

  it('ABORTED when the contract is rejected at Seal (and the loop never starts)', async () => {
    const { deps, harness } = wire({
      scripts: [{ postHash: '0000001' }],
      verdicts: [passVerdict()],
      gate: new FakeSealGate({ kind: 'reject', reason: 'bar is wrong' }),
    });
    const outcome = await drive(deps, makeConfig(), runId);
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toBe('bar is wrong');
    expect(harness.prompts).toHaveLength(0);
  });

  it('Seal revise re-authors the contract, then the APPROVED contract runs the loop', async () => {
    const draft = makeFakeContract({ goal: 'draft bar' });
    const revised = makeFakeContract({ goal: 'revised bar' });
    expect(draft.contractHash).not.toBe(revised.contractHash);

    const ws = new FakeWorkspace('0000000', 'diff');
    const harness = new FakeHarness([{ postHash: '0000001' }], ws);
    const compiler = new FakeCompiler([draft, revised]);
    const runlog = new InMemoryRunLog();
    const deps: DriverDeps = {
      compiler,
      seal: new FakeSealGate([
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

  it('Seal revise past the cap → ABORTED without ever starting the loop', async () => {
    const draft = makeFakeContract({ goal: 'draft' });
    const ws = new FakeWorkspace('0000000', 'diff');
    const harness = new FakeHarness([{ postHash: '0000001' }], ws);
    const deps: DriverDeps = {
      compiler: new FakeCompiler(draft),
      seal: new FakeSealGate([{ kind: 'revise', feedback: 'again' }]), // clamps → always revises
      harness,
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([approve()]),
      workspace: ws,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(),
      runlog: new InMemoryRunLog(),
    };
    const outcome = await drive(deps, makeConfig({ maxSealRevisions: 2 }), runId);
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('revision cap');
    expect(harness.prompts).toHaveLength(0);
  });

  it('FAILED when the compiler throws (no contract ever frozen)', async () => {
    const workspace = new FakeWorkspace();
    const deps: DriverDeps = {
      compiler: new FakeCompiler(new Error('cannot author a verifier')),
      seal: new FakeSealGate(),
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
    // The 5th append never lands: seq1-4 (compile, seal, iter1 run, iter1 verify) persist; iter2's
    // AGENT_RAN does not. The hardened driver fail-closes to ABORTED rather than rejecting.
    const ws1 = new FakeWorkspace('0000000', 'diff');
    const deps1: DriverDeps = {
      compiler: new FakeCompiler(contract),
      seal: new FakeSealGate(),
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
      seal: new FakeSealGate({ kind: 'reject', reason: 'gate must not run on resume' }),
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

  it('resumes from a log ending right after CONTRACT_COMPILED (replay into AWAIT_SEAL)', async () => {
    const inner = new InMemoryRunLog();
    // Crash on the 2nd append: only CONTRACT_COMPILED persists; the run stalls in AWAIT_SEAL.
    const ws1 = new FakeWorkspace('0000000', 'diff');
    const deps1: DriverDeps = {
      compiler: new FakeCompiler(contract),
      seal: new FakeSealGate(),
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

    // Resume: compile must NOT run again; Seal onward proceeds to DONE.
    const ws2 = new FakeWorkspace('0000000', 'diff');
    const deps2: DriverDeps = {
      compiler: new FakeCompiler(new Error('compile must not run on resume')),
      seal: new FakeSealGate({ kind: 'approve' }),
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
      seal: new FakeSealGate({ kind: 'reject', reason: 'must not run' }),
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

describe('drive() — diagnostic logging', () => {
  const msgsAt = (records: LogRecord[], level: LogRecord['level']): string[] =>
    records.filter((r) => r.level === level).map((r) => r.msg);

  it('emits leveled records across the whole loop without affecting the outcome', async () => {
    const { logger, records } = recordingLogger('debug');
    const { deps } = wire({
      scripts: [{ postHash: '0000001' }],
      verdicts: [passVerdict()],
      approvals: [approve()],
      logger,
    });

    const outcome = await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);
    expect(outcome.status).toBe('DONE');

    // info is content-free observability: every lifecycle beat is present.
    expect(msgsAt(records, 'info')).toEqual([
      'starting run',
      'contract compiled',
      'seal decided',
      'agent ran',
      'verified',
      'sign-off decided',
      'run finished',
    ]);

    const compiled = records.find((r) => r.msg === 'contract compiled');
    expect(compiled?.fields).toMatchObject({ contractHash: contract.contractHash, rungs: 1 });
    const finished = records.find((r) => r.msg === 'run finished');
    expect(finished?.fields).toMatchObject({ status: 'DONE', iterations: 1 });

    // debug carries the step-by-step detail (commands, transitions, prompt size).
    const debug = msgsAt(records, 'debug');
    expect(debug).toContain('perform command');
    expect(debug).toContain('transition');
    expect(debug).toContain('agent prompt');
  });

  it('keeps prompt/verifier CONTENT out of info records (secrets discipline)', async () => {
    const { logger, records } = recordingLogger('debug');
    const { deps } = wire({
      scripts: [{ postHash: '0000001' }],
      verdicts: [passVerdict('SECRET-VERDICT-DETAIL')],
      approvals: [approve()],
      logger,
    });
    await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);

    // The verdict detail only ever appears in a debug record, never at info.
    const infoHasDetail = records
      .filter((r) => r.level === 'info')
      .some((r) => JSON.stringify(r.fields).includes('SECRET-VERDICT-DETAIL'));
    expect(infoHasDetail).toBe(false);
    const debugHasDetail = records.some(
      (r) => r.level === 'debug' && r.msg === 'verdict detail',
    );
    expect(debugHasDetail).toBe(true);
  });

  it('logs a compile failure at error level', async () => {
    const { logger, records } = recordingLogger('debug');
    const { deps } = wire({ scripts: [], verdicts: [passVerdict()], logger });
    deps.compiler = new FakeCompiler(new Error('cannot author a verifier'));

    const outcome = await drive(deps, makeConfig(), runId);
    expect(outcome.status).toBe('FAILED');

    const err = records.find((r) => r.level === 'error');
    expect(err?.msg).toBe('compile failed');
    expect(err?.fields).toMatchObject({ reason: 'cannot author a verifier' });
  });

  it('warns loudly when the harness reports no token usage', async () => {
    const { logger, records } = recordingLogger('debug');
    const { deps } = wire({
      scripts: [{ postHash: '0000001' }], // no tokensUsed → unaccounted spend
      verdicts: [passVerdict()],
      approvals: [approve()],
      logger,
    });

    await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);

    const warn = records.find(
      (r) => r.level === 'warn' && r.msg.includes('harness reported no token usage'),
    );
    expect(warn).toBeDefined();
  });

  it('does not warn about token usage when the harness reports it', async () => {
    const { logger, records } = recordingLogger('debug');
    const { deps } = wire({
      scripts: [{ postHash: '0000001', tokensUsed: 1234 }],
      verdicts: [passVerdict()],
      approvals: [approve()],
      logger,
    });

    await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);

    const warn = records.find(
      (r) => r.level === 'warn' && r.msg.includes('harness reported no token usage'),
    );
    expect(warn).toBeUndefined();
  });

  it('warns when .gitignore changes during the agent run', async () => {
    const { logger, records } = recordingLogger('debug');
    const { deps } = wire({
      scripts: [{ postHash: '0000001', gitignoreHash: 'a'.repeat(64) }],
      verdicts: [passVerdict()],
      approvals: [approve()],
      logger,
    });

    await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);

    const warn = records.find(
      (r) => r.level === 'warn' && r.msg.includes('.gitignore changed'),
    );
    expect(warn).toBeDefined();
  });
});
