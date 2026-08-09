import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from './args';
import { STATE_DIR } from './compose';
import { executeRun } from './run-cmd';
import { resolveFollowup } from './followup-wiring';
import { drive, type DriverDeps } from '../driver/driver';
import { FileRunLog } from '../runlog/file-runlog';
import { readRun } from '../runlog/inspect';
import { compactRun } from '../followup/compaction';
import { RunId } from '../domain/ids';
import type { RunFollowup } from '../runlog/runlog';
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
} from '../testing/fakes';

/**
 * Capability C (`--from-run`) across a RESUME.
 *
 * `--from-run` is refused with `--resume`, so the prior-run compaction only ever arrived from the
 * fresh CLI invocation — and `RunLogHeader` recorded nothing identifying the predecessor. A resume
 * that still has to COMPILE (a crash before `CONTRACT_COMPILED` was persisted, or a Seal "revise"
 * round) therefore re-authored the bar with ZERO prior-run context, silently: the same degradation
 * the `--recontract` repair brief was fixed for, in the ordinary follow-up path.
 */

const GOAL = 'add a createDatabase bootstrap';
const contract = makeFakeContract({ goal: GOAL, rubric: 'a database is created on first boot' });

/** Drive a trivially-DONE run, persisted where `--from-run` / `--resume` will look for it. */
async function seedRun(dir: string, runId: string, followup?: RunFollowup): Promise<void> {
  const workspace = new FakeWorkspace('0000000', 'a fake diff');
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: '0000001' }], workspace),
    makeLadder: () => new FakeVerifier([{ pass: true, confidence: 1, detail: 'green' }]),
    approver: new FakeApprover([{ veto: false }]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog: new FileRunLog(path.join(dir, STATE_DIR, runId)),
  };
  await drive(deps, makeConfig({ goal: GOAL }), RunId.parse(runId), {
    ...(followup !== undefined ? { followup } : {}),
  });
}

async function parse(dir: string, argv: string[]) {
  return parseArgs(
    ['run', '--harness', 'fake', '--workspace', dir, '--workspace-mode', 'file', '--autonomous', ...argv],
    undefined,
    async () => ({ overlay: {}, sources: [] }),
  );
}

/** `--dry-run`: the last read-only point — the follow-up/resume resolution has already run. */
async function dryRun(dir: string, argv: string[]): Promise<{ code: number; err: string }> {
  const parsed = await parse(dir, ['--dry-run', ...argv]);
  let err = '';
  const result = await executeRun(parsed, { out: () => {}, err: (s) => (err += s) });
  return { code: result.code, err };
}

/** Normalize the per-call random nonce of the seed's UNTRUSTED fences, so seeds stay comparable. */
function withoutNonces(seed: string): string {
  return seed.replace(/(<<\/?UNTRUSTED [A-Z ]+) [0-9a-f]+>>/g, '$1>>');
}

describe('a --from-run follow-up records its predecessor and its compaction', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('resolveFollowup returns the SAME seed it records in the header', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-followup-'));
    await seedRun(dir, 'run-pred');
    const prior = await readRun(path.join(dir, STATE_DIR), 'run-pred');
    if (prior === null || !prior.ok) throw new Error('predecessor not readable');

    const parsed = await parse(dir, ['a follow-up goal', '--from-run', 'run-pred']);
    const resolution = await resolveFollowup(parsed, () => {});

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    // The seed IS the prior-run compaction. Compared modulo the untrusted-fence nonce, which is
    // random per call: the recorded seed is the one string that was BUILT here (asserted below), so
    // a re-derivation is never expected to be byte-identical.
    expect(withoutNonces(resolution.followupSeed ?? '')).toBe(
      withoutNonces(compactRun(prior.detail)),
    );
    // The header record must carry the very seed the compiler is handed — not a re-derivation that
    // could drift, and not just an id whose run may later be pruned.
    expect(resolution.followup?.predecessorRunId).toBe('run-pred');
    expect(resolution.followup?.seed).toBe(resolution.followupSeed);
  });

  it('the header round-trips it, so a later process can find the predecessor', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-followup-'));
    await seedRun(dir, 'run-succ', {
      predecessorRunId: RunId.parse('run-pred'),
      seed: '# Prior run context (run run-pred)\nPrior goal: build the thing',
    });

    const stored = await new FileRunLog(path.join(dir, STATE_DIR, 'run-succ')).read();

    expect(stored?.header.followup?.predecessorRunId).toBe('run-pred');
    expect(stored?.header.followup?.seed).toContain('Prior run context');
  });
});

describe('a resumed follow-up keeps its prior-run compaction', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('rebuilds the seed from the header, silently and without complaint', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-followup-'));
    await seedRun(dir, 'run-succ-seed', {
      predecessorRunId: RunId.parse('run-pred'),
      seed: '# Prior run context (run run-pred)\nPrior goal: build the thing',
    });

    const r = await dryRun(dir, ['--resume', 'run-succ-seed']);

    expect(r.code).toBe(0);
    expect(r.err).not.toContain('prior-run context');
  });

  it('says so loudly when the log predates the recorded compaction', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-followup-'));
    await seedRun(dir, 'run-succ-noseed', { predecessorRunId: RunId.parse('run-pred') });

    const r = await dryRun(dir, ['--resume', 'run-succ-noseed']);

    expect(r.code).toBe(0);
    // Degrading in silence is the bug; naming the limit and the fresh follow-up command is the fix.
    expect(r.err).toContain('prior-run context');
    expect(r.err).toContain('--from-run run-pred');
  });

  it('an ordinary run records nothing and warns about nothing', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-followup-'));
    await seedRun(dir, 'run-plain');

    const stored = await new FileRunLog(path.join(dir, STATE_DIR, 'run-plain')).read();
    expect(stored?.header.followup).toBeUndefined();

    const r = await dryRun(dir, ['--resume', 'run-plain']);
    expect(r.err).not.toContain('prior-run context');
  });
});
