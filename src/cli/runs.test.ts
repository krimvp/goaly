import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runRuns, renderRunsTable, renderRunDetail } from './runs';
import type { RunDetail, RunListItem, RunSummary } from '../runlog/inspect';
import { FileRunLog } from '../runlog/file-runlog';
import type { RunLogHeader, RunLogEntry } from '../runlog/runlog';
import type { OrchestratorEvent } from '../domain/events';
import { RunId, DiffHash, SessionId } from '../domain/ids';
import { makeConfig, makeFakeContract, passVerdict, failVerdict, approve } from '../testing/fakes';

const contract = makeFakeContract({ goal: 'build the parser' });

function summaryItem(over: Partial<RunSummary> = {}): RunListItem {
  return {
    ok: true,
    summary: {
      runId: RunId.parse('run-aaa'),
      goal: 'build the parser',
      status: 'DONE',
      stateTag: 'DONE',
      iterations: 2,
      tokensSpent: 1234,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_050_000,
      contractHash: contract.contractHash,
      ...over,
    },
  };
}

describe('renderRunsTable', () => {
  it('renders a header row and a data row with all columns', () => {
    const table = renderRunsTable([summaryItem()]);
    expect(table).toContain('RUN ID');
    expect(table).toContain('STATUS');
    expect(table).toContain('TOKENS');
    expect(table).toContain('run-aaa');
    expect(table).toContain('DONE');
    expect(table).toContain('1234');
    expect(table).toContain('build the parser');
  });

  it('renders a corrupt row as CORRUPT with the error in place of the goal', () => {
    const items: RunListItem[] = [{ ok: false, runId: 'run-bad', error: 'corrupt header' }];
    const table = renderRunsTable(items);
    expect(table).toContain('run-bad');
    expect(table).toContain('CORRUPT');
    expect(table).toContain('corrupt header');
  });

  it('renders a dash for missing tokens / ended time', () => {
    const item: RunListItem = {
      ok: true,
      summary: {
        runId: RunId.parse('run-bbb'),
        goal: 'g',
        status: 'INCOMPLETE',
        stateTag: 'RUNNING_AGENT',
        iterations: 0,
        tokensSpent: undefined,
        startedAt: 1_700_000_000_000,
        endedAt: undefined,
        contractHash: null,
      },
    };
    const table = renderRunsTable([item]);
    expect(table).toContain('run-bbb');
    expect(table).toContain('-');
  });
});

describe('renderRunDetail', () => {
  function detail(over: Partial<RunDetail> = {}): RunDetail {
    return {
      runId: RunId.parse('run-aaa'),
      goal: 'build the parser',
      status: 'DONE',
      stateTag: 'DONE',
      reason: undefined,
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_050_000,
      iterations: 2,
      tokensSpent: 1234,
      usage: {
        harness: { tokens: 1000, calls: 2, unknownCalls: 0 },
        compiler: { tokens: 100, calls: 1, unknownCalls: 0 },
        verifier: { tokens: 100, calls: 2, unknownCalls: 0 },
        approver: { tokens: 34, calls: 2, unknownCalls: 0 },
        llm: { tokens: 234, calls: 5, unknownCalls: 0 },
        total: { tokens: 1234, calls: 7, unknownCalls: 0 },
        budget: { spent: 1234, exceeded: false },
      },
      contract,
      contractHash: contract.contractHash,
      compileFailures: [],
      seal: [{ kind: 'approve' }],
      prepare: undefined,
      iterationsDetail: [
        { index: 1, runStatus: 'completed', changed: true, tokensSpent: 10, verdict: failVerdict('red'), signoff: undefined },
        { index: 2, runStatus: 'completed', changed: true, tokensSpent: 25, verdict: passVerdict('green'), signoff: approve() },
      ],
      ...over,
    };
  }

  it('shows status, the frozen contract hash, Seal, and per-iteration ladder + Sign-off', () => {
    const text = renderRunDetail(detail());
    expect(text).toContain('run-aaa');
    expect(text).toContain('status:      DONE');
    expect(text).toContain(contract.contractHash);
    expect(text).toContain('seal:        approve');
    expect(text).toContain('#1');
    expect(text).toContain('FAIL');
    expect(text).toContain('#2');
    expect(text).toContain('PASS');
    expect(text).toContain('sign-off=approved');
  });

  it('renders the per-layer spend breakdown (harness vs the LLM steps)', () => {
    const text = renderRunDetail(detail());
    expect(text).toContain('spend:');
    expect(text).toContain('harness');
    expect(text).toContain('1,000 tokens');
    expect(text).toContain('llm subtotal');
    expect(text).toContain('234 tokens');
    expect(text).toContain('1,234 tokens');
  });

  it('annotates an INCOMPLETE run with its raw state tag and shows a failure reason', () => {
    const text = renderRunDetail(detail({ status: 'INCOMPLETE', stateTag: 'VERIFYING', reason: undefined }));
    expect(text).toContain('status:      INCOMPLETE (VERIFYING)');
  });

  it('shows the terminal reason when present', () => {
    const text = renderRunDetail(detail({ status: 'ABORTED', stateTag: 'ABORTED', reason: 'no-diff: stuck' }));
    expect(text).toContain('reason:      no-diff: stuck');
  });

  it('notes a contract-less run that failed before compile', () => {
    const text = renderRunDetail(detail({ contract: null, contractHash: null, compileFailures: ['bad rubric'] }));
    expect(text).toContain('none — run failed before compile');
    expect(text).toContain('compile:     FAILED — bad rubric');
  });
});

// ---- dispatch over a real (temp) state dir --------------------------------

let counter = 0;
async function freshDir(): Promise<string> {
  counter += 1;
  return mkdtemp(join(tmpdir(), `runs-cli-${process.pid}-${counter}-`));
}

function capture(): { out: (s: string) => void; err: (s: string) => void; stdout: () => string; stderr: () => string } {
  let o = '';
  let e = '';
  return {
    out: (s) => (o += s),
    err: (s) => (e += s),
    stdout: () => o,
    stderr: () => e,
  };
}

let seq = 0;
function h(runId: string): RunLogHeader {
  return { runId: RunId.parse(runId), startedAt: 1_700_000_000_000, config: makeConfig({ goal: 'build the parser' }) };
}
function e(runId: string, event: OrchestratorEvent): RunLogEntry {
  seq += 1;
  return { runId: RunId.parse(runId), seq, ts: 1_700_000_000_000 + seq, contractHash: null, event, stateTagAfter: 'x' };
}

async function writeDoneRun(stateDir: string, runId: string): Promise<void> {
  seq = 0;
  const entries: RunLogEntry[] = [
    e(runId, { tag: 'CONTRACT_COMPILED', contract }),
    e(runId, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
    e(runId, {
      tag: 'AGENT_RAN',
      run: { output: '', sessionId: SessionId.parse('s1'), status: 'completed' },
      prevDiffHash: DiffHash.parse('0000000'),
      diffHash: DiffHash.parse('0000001'),
      budget: { exceeded: false, tokensSpent: 42 },
    }),
    e(runId, { tag: 'VERIFIED', verdict: passVerdict() }),
    e(runId, { tag: 'SIGNOFF_DECIDED', approval: approve() }),
  ];
  const log = new FileRunLog(join(stateDir, runId));
  await log.writeHeader(h(runId));
  for (const entry of entries) await log.append(entry);
}

describe('runRuns dispatch', () => {
  it('list: prints a friendly message and exits 0 when there are no runs', async () => {
    const stateDir = await freshDir();
    try {
      const c = capture();
      const code = await runRuns({ kind: 'list' }, stateDir, c.out, c.err);
      expect(code).toBe(0);
      expect(c.stdout()).toContain('No runs found');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('list: prints a table of runs', async () => {
    const stateDir = await freshDir();
    try {
      await writeDoneRun(stateDir, 'run-xyz');
      const c = capture();
      const code = await runRuns({ kind: 'list' }, stateDir, c.out, c.err);
      expect(code).toBe(0);
      expect(c.stdout()).toContain('run-xyz');
      expect(c.stdout()).toContain('DONE');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('show: prints the detail for an existing run', async () => {
    const stateDir = await freshDir();
    try {
      await writeDoneRun(stateDir, 'run-xyz');
      const c = capture();
      const code = await runRuns({ kind: 'show', runId: 'run-xyz' }, stateDir, c.out, c.err);
      expect(code).toBe(0);
      expect(c.stdout()).toContain('run-xyz');
      expect(c.stdout()).toContain(contract.contractHash);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('show: exits 1 with an error on an unknown run', async () => {
    const stateDir = await freshDir();
    try {
      const c = capture();
      const code = await runRuns({ kind: 'show', runId: 'run-nope' }, stateDir, c.out, c.err);
      expect(code).toBe(1);
      expect(c.stderr()).toContain('no such run');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('show: exits 1 and reports corruption on a corrupt run (fail-closed)', async () => {
    const stateDir = await freshDir();
    try {
      await new FileRunLog(join(stateDir, 'run-bad')).writeHeader(h('run-bad'));
      await appendFile(join(stateDir, 'run-bad', 'log.jsonl'), '{ not json\n', 'utf8');
      const c = capture();
      const code = await runRuns({ kind: 'show', runId: 'run-bad' }, stateDir, c.out, c.err);
      expect(code).toBe(1);
      expect(c.stderr()).toContain('corrupt');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
