import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRunLog } from './file-runlog';
import { listRuns, readRun, runSummary, runDetail } from './inspect';
import type { RunLogHeader, RunLogEntry } from './runlog';
import { RunId, DiffHash, SessionId } from '../domain/ids';
import type { OrchestratorEvent } from '../domain/events';
import { makeConfig, makeFakeContract, makeFakePlan, passVerdict, failVerdict, approve, veto } from '../testing/fakes';

const contract = makeFakeContract({ goal: 'build the parser' });

let counter = 0;
async function freshDir(): Promise<string> {
  counter += 1;
  return mkdtemp(join(tmpdir(), `inspect-${process.pid}-${counter}-`));
}

function header(runId: string, startedAt: number): RunLogHeader {
  return {
    runId: RunId.parse(runId),
    startedAt,
    config: makeConfig({ goal: 'build the parser' }),
  };
}

let seq = 0;
function entry(runId: string, event: OrchestratorEvent, ts = 1000 + seq): RunLogEntry {
  seq += 1;
  return { runId: RunId.parse(runId), seq, ts, contractHash: null, event, stateTagAfter: 'x' };
}

function agentRan(runId: string, prev: string, post: string, tokensSpent?: number): RunLogEntry {
  return entry(runId, {
    tag: 'AGENT_RAN',
    run: { output: '', sessionId: SessionId.parse('s1'), status: 'completed' },
    prevDiffHash: DiffHash.parse(prev),
    diffHash: DiffHash.parse(post),
    budget: { exceeded: false, ...(tokensSpent !== undefined ? { tokensSpent } : {}) },
  });
}

/** A full two-iteration DONE run: iter1 fails the ladder, iter2 passes and is approved. */
function doneRun(runId = 'run-done'): { header: RunLogHeader; entries: RunLogEntry[] } {
  seq = 0;
  return {
    header: header(runId, 1_700_000_000_000),
    entries: [
      entry(runId, { tag: 'CONTRACT_COMPILED', contract }),
      entry(runId, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
      agentRan(runId, '0000000', '0000001', 10),
      entry(runId, { tag: 'VERIFIED', verdict: failVerdict('red') }),
      agentRan(runId, '0000001', '0000002', 25),
      entry(runId, { tag: 'VERIFIED', verdict: passVerdict('green') }),
      entry(runId, { tag: 'SIGNOFF_DECIDED', approval: approve() }, 1_700_000_009_999),
    ],
  };
}

describe('runSummary (pure projection)', () => {
  it('summarizes a DONE run with the Driver-matching status/iterations/tokens', () => {
    const { header: h, entries } = doneRun();
    const s = runSummary(h, entries);
    expect(s.status).toBe('DONE');
    expect(s.stateTag).toBe('DONE');
    expect(s.iterations).toBe(2);
    expect(s.tokensSpent).toBe(25); // cumulative = last AGENT_RAN snapshot
    expect(s.goal).toBe('build the parser');
    expect(s.contractHash).toBe(contract.contractHash);
    expect(s.startedAt).toBe(1_700_000_000_000);
    expect(s.endedAt).toBe(1_700_000_009_999);
  });

  it('reports an interrupted run as INCOMPLETE with its raw final state tag', () => {
    seq = 0;
    const h = header('run-mid', 1);
    const entries = [
      entry('run-mid', { tag: 'CONTRACT_COMPILED', contract }),
      entry('run-mid', { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
      agentRan('run-mid', '0000000', '0000001'), // stops in VERIFYING (no VERIFIED yet)
    ];
    const s = runSummary(h, entries);
    expect(s.status).toBe('INCOMPLETE');
    expect(s.stateTag).toBe('VERIFYING');
    expect(s.tokensSpent).toBeUndefined();
    expect(s.endedAt).toBe(entries[entries.length - 1]!.ts);
  });
});

describe('runDetail (pure projection)', () => {
  it('reconstructs the frozen contract, Seal, and per-iteration ladder + Sign-off', () => {
    const { header: h, entries } = doneRun();
    const d = runDetail(h, entries);

    expect(d.status).toBe('DONE');
    expect(d.contract).toEqual(contract);
    expect(d.contractHash).toBe(contract.contractHash);
    expect(d.seal).toEqual([{ kind: 'approve' }]);
    expect(d.compileFailures).toEqual([]);

    expect(d.iterationsDetail).toHaveLength(2);
    const [i1, i2] = d.iterationsDetail;
    expect(i1).toMatchObject({ index: 1, changed: true, tokensSpent: 10 });
    expect(i1!.verdict?.pass).toBe(false);
    expect(i1!.signoff).toBeUndefined(); // ladder failed → Sign-off never ran
    expect(i2).toMatchObject({ index: 2, changed: true, tokensSpent: 25 });
    expect(i2!.verdict?.pass).toBe(true);
    expect(i2!.signoff).toEqual({ veto: false });
  });

  it('surfaces a Sign-off veto on the iteration it belongs to', () => {
    seq = 0;
    const h = header('run-veto', 5);
    const entries = [
      entry('run-veto', { tag: 'CONTRACT_COMPILED', contract }),
      entry('run-veto', { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
      agentRan('run-veto', '0000000', '0000001'),
      entry('run-veto', { tag: 'VERIFIED', verdict: passVerdict() }),
      entry('run-veto', { tag: 'SIGNOFF_DECIDED', approval: veto('looks empty') }),
    ];
    const d = runDetail(h, entries);
    expect(d.iterationsDetail[0]!.signoff).toEqual({ veto: true, reason: 'looks empty' });
  });

  it('records compile failures and an empty Seal when compile never succeeded', () => {
    seq = 0;
    const h = header('run-compilefail', 9);
    const entries = [entry('run-compilefail', { tag: 'COMPILE_FAILED', reason: 'bad rubric' })];
    const d = runDetail(h, entries);
    expect(d.contract).toBeNull();
    expect(d.contractHash).toBeNull();
    expect(d.compileFailures).toEqual(['bad rubric']);
    expect(d.seal).toEqual([]);
  });
});

describe('listRuns / readRun (read-only filesystem layer)', () => {
  it('returns [] for a missing state directory', async () => {
    expect(await listRuns(join(tmpdir(), `no-such-${process.pid}-${counter}`))).toEqual([]);
  });

  it('lists runs most-recent-first and skips non-run directories', async () => {
    const stateDir = await freshDir();
    try {
      await writeRun(stateDir, 'run-old', 100);
      await writeRun(stateDir, 'run-new', 200);
      await mkdir(join(stateDir, 'not-a-run'), { recursive: true }); // no header → skipped

      const items = await listRuns(stateDir);
      expect(items.map((i) => (i.ok ? i.summary.runId : i.runId))).toEqual(['run-new', 'run-old']);
      expect(items.every((i) => i.ok)).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('flags a corrupt run in the listing instead of throwing (fail-closed)', async () => {
    const stateDir = await freshDir();
    try {
      await writeRun(stateDir, 'run-ok', 100);
      // A run with a header but a corrupt log line.
      await new FileRunLog(join(stateDir, 'run-bad')).writeHeader(header('run-bad', 50));
      await appendFile(join(stateDir, 'run-bad', 'log.jsonl'), '{ not json\n', 'utf8');

      const items = await listRuns(stateDir);
      const bad = items.find((i) => !i.ok);
      expect(bad).toBeDefined();
      expect(bad).toMatchObject({ ok: false, runId: 'run-bad' });
      // The healthy run is still listed.
      expect(items.some((i) => i.ok && i.summary.runId === 'run-ok')).toBe(true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('readRun returns the detail for an existing run', async () => {
    const stateDir = await freshDir();
    try {
      await writeRun(stateDir, 'run-done', 100);
      const result = await readRun(stateDir, 'run-done');
      expect(result?.ok).toBe(true);
      if (result?.ok) expect(result.detail.status).toBe('DONE');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('readRun returns null for an unknown run id', async () => {
    const stateDir = await freshDir();
    try {
      expect(await readRun(stateDir, 'run-nope')).toBeNull();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('readRun flags a corrupt run (never silently green)', async () => {
    const stateDir = await freshDir();
    try {
      await new FileRunLog(join(stateDir, 'run-bad')).writeHeader(header('run-bad', 50));
      await writeFile(join(stateDir, 'run-bad', 'log.jsonl'), `${JSON.stringify({ seq: 'x' })}\n`, 'utf8');
      const result = await readRun(stateDir, 'run-bad');
      expect(result).toMatchObject({ ok: false, runId: 'run-bad' });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('runDetail — phased projection (issue #48)', () => {
  it('captures the frozen plan, plan-Seal, and stamps each iteration with its phase', () => {
    seq = 0;
    const runId = 'run-phased';
    const plan = makeFakePlan({ phases: [{ goal: 'phase one' }, { goal: 'phase two' }] });
    const tree = DiffHash.parse('0000abc');
    const h: RunLogHeader = {
      runId: RunId.parse(runId),
      startedAt: 1,
      config: makeConfig({ phased: true, goal: 'the whole goal' }),
    };
    const entries = [
      entry(runId, { tag: 'PLAN_COMPILED', plan }),
      entry(runId, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } }),
      // phase 0
      entry(runId, { tag: 'CONTRACT_COMPILED', contract }),
      entry(runId, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
      agentRan(runId, '0000000', '0000001'),
      entry(runId, { tag: 'VERIFIED', verdict: passVerdict() }),
      entry(runId, { tag: 'SIGNOFF_DECIDED', approval: approve() }),
      entry(runId, { tag: 'PHASE_ADVANCED', tree }),
      // phase 1
      entry(runId, { tag: 'CONTRACT_COMPILED', contract }),
      entry(runId, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
      agentRan(runId, '0000001', '0000002'),
      entry(runId, { tag: 'VERIFIED', verdict: passVerdict() }),
      entry(runId, { tag: 'SIGNOFF_DECIDED', approval: approve() }),
    ];
    const d = runDetail(h, entries);
    expect(d.plan?.planHash).toBe(plan.planHash);
    expect(d.planSeal).toEqual([{ kind: 'approve' }]);
    expect(d.planFailures).toEqual([]);
    // Iteration 1 is in phase 0, iteration 2 (after the advance) is in phase 1.
    expect(d.iterationsDetail.map((it) => it.phase)).toEqual([0, 1]);
  });

  it('records a PLAN_FAILED reason and leaves the plan null', () => {
    seq = 0;
    const runId = 'run-planfail';
    const h: RunLogHeader = {
      runId: RunId.parse(runId),
      startedAt: 1,
      config: makeConfig({ phased: true }),
    };
    const entries = [entry(runId, { tag: 'PLAN_FAILED', reason: 'no JSON' })];
    const d = runDetail(h, entries);
    expect(d.plan).toBeNull();
    expect(d.planFailures).toEqual(['no JSON']);
    expect(d.status).toBe('FAILED');
  });
});

/** Persist a full DONE run under `stateDir/<runId>` with the given startedAt for sort tests. */
async function writeRun(stateDir: string, runId: string, startedAt: number): Promise<void> {
  const { entries } = doneRun(runId);
  const log = new FileRunLog(join(stateDir, runId));
  await log.writeHeader(header(runId, startedAt));
  for (const e of entries) await log.append(e);
}
