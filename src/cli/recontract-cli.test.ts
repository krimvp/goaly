import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from './args';
import { UsageError } from './flags/tokens';
import { STATE_DIR } from './compose';
import { executeRun, nextStepHint } from './run-cmd';
import { renderRunDetail } from './runs';
import { drive, type DriverDeps } from '../driver/driver';
import { FileRunLog } from '../runlog/file-runlog';
import { readRun } from '../runlog/inspect';
import { RunId } from '../domain/ids';
import { recontractCommand } from '../followup/recontract';
import {
  FakeHarness,
  FakeVerifier,
  FakeApprover,
  FakeCompiler,
  FakeSealGate,
  FakeWorkspace,
  ManualClock,
  ManualBudgetMeter,
  makeFakeContract,
  makeConfig,
  failVerdict,
} from '../testing/fakes';
import { FakeLlm } from '../llm/provider';

/**
 * Issue #117 at the CLI seam: the flags, the fail-closed guards `--recontract` must pass before a
 * successor run can start, and the provenance a successor records + surfaces in `goaly runs show`.
 * Every run here uses `--dry-run`, the last read-only point: the follow-up resolution (and so the
 * whole eligibility check) has already run, but nothing is written and no token is spent.
 */

const GOAL = 'add a createDatabase bootstrap';
const SIGNATURE = 'AssertionError: expected createDatabase to be called (verify/db.test.ts:12)';
const contract = makeFakeContract({
  goal: GOAL,
  rubric: 'a database is created on first boot',
  generatedFiles: [{ path: 'verify/db.test.ts', sha256: 'a'.repeat(64) }],
});

/** Drive a repeat-failure run to a terminal state, persisted where `--from-run` will look for it. */
async function seedPriorRun(dir: string, runId: string, verdict: object | null): Promise<void> {
  const workspace = new FakeWorkspace('0000000', 'a fake diff');
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness(
      [{ postHash: '0000001' }, { postHash: '0000002' }, { postHash: '0000003' }],
      workspace,
    ),
    makeLadder: () => new FakeVerifier([failVerdict(SIGNATURE)]),
    approver: new FakeApprover([]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    sleep: async () => {},
    runlog: new FileRunLog(path.join(dir, STATE_DIR, runId)),
    ...(verdict !== null ? { prepareLlm: new FakeLlm([JSON.stringify(verdict)]) } : {}),
  };
  await drive(deps, makeConfig({ goal: GOAL, maxIterations: 10 }), RunId.parse(runId));
}

const DEFECTIVE = { defective: true, reason: 'no implementation can satisfy that assertion' };

/** `--dry-run` so the guards run and nothing is written; `fake` harness so no CLI is probed. */
async function dryRun(dir: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const parsed = await parseArgs(
    ['run', '--harness', 'fake', '--workspace', dir, '--workspace-mode', 'file', '--autonomous', '--dry-run', ...argv],
    undefined,
    async () => ({ overlay: {}, sources: [] }),
  );
  let out = '';
  let err = '';
  const result = await executeRun(parsed, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code: result.code, out, err };
}

describe('--recontract / --max-recontracts parsing', () => {
  const base = ['run', '--goal', 'x', '--verify-cmd', 'true'];

  it('parses the pair and defaults the chain cap to 1', async () => {
    const a = await parseArgs([...base, '--from-run', 'run-x', '--recontract']);
    expect(a.recontract).toEqual({ maxRecontracts: 1 });
    const raised = await parseArgs([...base, '--from-run', 'run-x', '--recontract', '--max-recontracts', '3']);
    expect(raised.recontract).toEqual({ maxRecontracts: 3 });
  });

  it('needs no goal on the command line — a re-contract inherits the predecessor\'s frozen one', async () => {
    const a = await parseArgs(['run', '--from-run', 'run-x', '--recontract']);
    expect(a.recontract).toEqual({ maxRecontracts: 1 });
  });

  it('fails closed on a cap without the flag it bounds, and on a non-numeric cap', async () => {
    await expect(parseArgs([...base, '--max-recontracts', '2'])).rejects.toBeInstanceOf(UsageError);
    await expect(
      parseArgs([...base, '--from-run', 'r', '--recontract', '--max-recontracts', 'lots']),
    ).rejects.toBeInstanceOf(UsageError);
  });
});

describe('the CONTRACT_DEFECTIVE abort prints the exact successor command', () => {
  it('names --from-run <runId> --recontract, not --stuck-repeat-threshold', () => {
    const hint = nextStepHint({
      runId: RunId.parse('run-abc'),
      status: 'ABORTED',
      contractHash: contract.contractHash,
      iterations: 4,
      reason: 'CONTRACT_DEFECTIVE: the frozen verification is DEFECTIVE — … STUCK_REPEATED_FAILURE',
    });
    expect(hint).toContain(recontractCommand('run-abc'));
    expect(hint).not.toContain('--stuck-repeat-threshold');
  });
});

describe('the CLI guards on a real run log', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('refuses --recontract without --from-run', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-recontract-'));
    const r = await dryRun(dir, ['--goal', 'x', '--recontract']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--recontract requires --from-run');
  });

  it('refuses a predecessor the adjudicator judged SOUND (the worker can never open this door)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-recontract-'));
    await seedPriorRun(dir, 'run-sound', { defective: false, reason: 'satisfiable' });
    const r = await dryRun(dir, ['--from-run', 'run-sound', '--recontract']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--recontract:');
    expect(r.err).toContain('not adjudicated CONTRACT_DEFECTIVE');
  });

  it('accepts a defective predecessor and inherits its FROZEN goal', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-recontract-'));
    await seedPriorRun(dir, 'run-bad-bar', DEFECTIVE);
    const r = await dryRun(dir, ['--from-run', 'run-bad-bar', '--recontract']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(GOAL); // inherited: no goal was passed on this command line
    expect(r.out).toContain('recontract');
    expect(r.err).toBe('');
  });

  it('ignores a goal passed alongside --recontract, loudly (a repair changes the bar, not the goal)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-recontract-'));
    await seedPriorRun(dir, 'run-bad-bar-2', DEFECTIVE);
    const r = await dryRun(dir, ['--goal', 'something else entirely', '--from-run', 'run-bad-bar-2', '--recontract']);
    expect(r.code).toBe(0);
    expect(r.err).toContain('the goal passed on this command line is ignored');
    expect(r.out).toContain(GOAL);
    expect(r.out).not.toContain('something else entirely');
  });

  it('a predecessor with no such run id is refused before anything is written', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-recontract-'));
    const r = await dryRun(dir, ['--from-run', 'run-nope', '--recontract']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('no such run');
  });
});

describe('successor provenance is persisted and surfaced', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('rides into the run-log header and is rendered by `goaly runs show`', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-recontract-'));
    const stateDir = path.join(dir, STATE_DIR);
    await seedPriorRun(dir, 'run-pred', DEFECTIVE);
    const prior = await readRun(stateDir, 'run-pred');
    if (prior === null || !prior.ok) throw new Error('predecessor not readable');

    // The predecessor's own `runs show` offers the successor command.
    expect(renderRunDetail(prior.detail)).toContain(recontractCommand('run-pred'));

    const provenance = {
      predecessorRunId: prior.detail.runId,
      predecessorContractHash: contract.contractHash,
      verdict: DEFECTIVE.reason,
      recontracts: 1,
    };
    const successorId = 'run-successor';
    const workspace = new FakeWorkspace('0000000', 'a fake diff');
    // A successor that reaches DONE on its own new bar — a NEW runId, a NEW contract, the SAME tree.
    const successorContract = makeFakeContract({ goal: GOAL, rubric: 'the corrected bar' });
    await drive(
      {
        compiler: new FakeCompiler(successorContract),
        seal: new FakeSealGate({ kind: 'approve' }),
        harness: new FakeHarness([{ postHash: '0000009' }], workspace),
        makeLadder: () => new FakeVerifier([{ pass: true, confidence: 1, detail: 'green' }]),
        approver: new FakeApprover([{ veto: false }]),
        workspace,
        clock: new ManualClock(),
        budget: new ManualBudgetMeter(false),
        runlog: new FileRunLog(path.join(stateDir, successorId)),
      },
      makeConfig({ goal: GOAL }),
      RunId.parse(successorId),
      { provenance },
    );

    const successor = await readRun(stateDir, successorId);
    if (successor === null || !successor.ok) throw new Error('successor not readable');
    expect(successor.detail.provenance).toEqual(provenance);
    // A NEW contract hash under a NEW run id — the predecessor's contract is recorded, never reused.
    expect(successor.detail.contractHash).not.toBe(prior.detail.contractHash);

    const shown = renderRunDetail(successor.detail);
    expect(shown).toContain('successor of: run-pred');
    expect(shown).toContain(contract.contractHash);
    expect(shown).toContain('re-contract #1');
    expect(shown).toContain(DEFECTIVE.reason);
  });
});
