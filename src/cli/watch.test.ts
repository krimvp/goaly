import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runsWatch, renderWatchEvent } from './watch';
import { FileRunLog } from '../runlog/file-runlog';
import type { RunLogEntry, RunLogHeader } from '../runlog/runlog';
import { RunId, ContractHash, DiffHash, SessionId } from '../domain/ids';
import { makeConfig, makeFakeContract } from '../testing/fakes';

const runId = 'run-watched';
const contract = makeFakeContract({ goal: 'watch me' });

function header(): RunLogHeader {
  return {
    runId: RunId.parse(runId),
    startedAt: 1_700_000_000_000,
    config: makeConfig({ goal: 'watch me work' }),
    harness: 'fake',
  };
}

const base = { runId: RunId.parse(runId), contractHash: ContractHash.parse('a1b2c3d') };

const compiled = (seq: number): RunLogEntry => ({
  ...base, seq, ts: seq * 1000,
  event: { tag: 'CONTRACT_COMPILED', contract },
  stateTagAfter: 'AWAIT_SEAL',
});
const sealed = (seq: number): RunLogEntry => ({
  ...base, seq, ts: seq * 1000,
  event: { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } },
  stateTagAfter: 'RUNNING_AGENT',
});
const agentRan = (seq: number): RunLogEntry => ({
  ...base, seq, ts: seq * 1000,
  event: {
    tag: 'AGENT_RAN',
    run: { output: 'did work', sessionId: SessionId.parse('s1'), status: 'completed', tokensUsed: 42 },
    prevDiffHash: DiffHash.parse('0000000'),
    diffHash: DiffHash.parse('0000001'),
    budget: { exceeded: false },
  },
  stateTagAfter: 'VERIFYING',
});
const verified = (seq: number, pass: boolean, terminal = false): RunLogEntry => ({
  ...base, seq, ts: seq * 1000,
  event: { tag: 'VERIFIED', verdict: { pass, confidence: 1, detail: pass ? 'green' : 'ImportError: nope' } },
  stateTagAfter: terminal ? 'ABORTED' : pass ? 'AWAIT_SIGNOFF' : 'RUNNING_AGENT',
});
const signedOff = (seq: number): RunLogEntry => ({
  ...base, seq, ts: seq * 1000,
  event: { tag: 'SIGNOFF_DECIDED', approval: { veto: false } },
  stateTagAfter: 'DONE',
});

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'goaly-watch-'));
}

describe('runsWatch', () => {
  it('renders the whole timeline of a finished run and exits 0 at the terminal state', async () => {
    const stateDir = await freshDir();
    try {
      const log = new FileRunLog(join(stateDir, runId));
      await log.writeHeader(header());
      for (const e of [compiled(1), sealed(2), agentRan(3), verified(4, true), signedOff(5)]) {
        await log.append(e);
      }
      const lines: string[] = [];
      const code = await runsWatch(runId, stateDir, (s) => lines.push(s), () => {}, {
        sleep: async () => {},
        isActive: async () => false,
      });
      const text = lines.join('');
      expect(code).toBe(0);
      expect(text).toContain('watching run-watched — goal: watch me work');
      expect(text).toContain('contract compiled');
      expect(text).toContain('seal: approve');
      expect(text).toContain('iter 1: agent completed (tree changed, 42 tokens)');
      expect(text).toContain('verify PASS');
      expect(text).toContain('sign-off approved');
      expect(text).toContain('finished: DONE');
      expect(text).toContain(`runs show ${runId}`);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('tails a LIVE run: renders entries appended between polls, then the terminal line', async () => {
    const stateDir = await freshDir();
    try {
      const log = new FileRunLog(join(stateDir, runId));
      await log.writeHeader(header());
      await log.append(compiled(1));
      await log.append(sealed(2));

      // The "driver" appends more entries whenever the watcher sleeps.
      const script = [
        async () => log.append(agentRan(3)),
        async () => log.append(verified(4, false)),
        async () => log.append(agentRan(5)),
        async () => log.append(verified(6, true)),
        async () => log.append(signedOff(7)),
      ];
      let i = 0;
      const lines: string[] = [];
      const code = await runsWatch(runId, stateDir, (s) => lines.push(s), () => {}, {
        sleep: async () => {
          await script[Math.min(i, script.length - 1)]!();
          i += 1;
        },
        isActive: async () => true,
      });
      const text = lines.join('');
      expect(code).toBe(0);
      expect(text).toContain('iter 1: verify FAIL ✗ — ImportError: nope');
      expect(text).toContain('iter 2: verify PASS');
      expect(text).toContain('finished: DONE');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('exits 1 with the resume command when an INCOMPLETE run has no live driver', async () => {
    const stateDir = await freshDir();
    try {
      const log = new FileRunLog(join(stateDir, runId));
      await log.writeHeader(header());
      await log.append(compiled(1)); // stops mid-run — no terminal entry
      const lines: string[] = [];
      const code = await runsWatch(runId, stateDir, (s) => lines.push(s), () => {}, {
        sleep: async () => {},
        isActive: async () => false,
      });
      expect(code).toBe(1);
      const text = lines.join('');
      expect(text).toContain('no live process holds its lock');
      expect(text).toContain(`--resume ${runId}`);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('errors on a missing run', async () => {
    const stateDir = await freshDir();
    try {
      const errs: string[] = [];
      const code = await runsWatch('run-nope', stateDir, () => {}, (s) => errs.push(s), {
        sleep: async () => {},
        isActive: async () => false,
      });
      expect(code).toBe(1);
      expect(errs.join('')).toContain('no such run');
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe('renderWatchEvent', () => {
  it('renders an operator extension with its knobs and note', () => {
    const entry: RunLogEntry = {
      ...base, seq: 9, ts: 9_000,
      event: { tag: 'RUN_EXTENDED', maxIterations: 20, note: 'focus on the parser' },
      stateTagAfter: 'RUNNING_AGENT',
    };
    const line = renderWatchEvent(entry, 3);
    expect(line).toContain('operator extension');
    expect(line).toContain('max-iterations→20');
    expect(line).toContain('focus on the parser');
  });

  it('renders a veto with its reason and suppresses CHECKPOINTED plumbing', () => {
    const veto: RunLogEntry = {
      ...base, seq: 5, ts: 5_000,
      event: { tag: 'SIGNOFF_DECIDED', approval: { veto: true, reason: 'the test is empty' } },
      stateTagAfter: 'RUNNING_AGENT',
    };
    expect(renderWatchEvent(veto, 2)).toContain('sign-off VETO — the test is empty');

    const checkpoint: RunLogEntry = {
      ...base, seq: 6, ts: 6_000,
      event: { tag: 'CHECKPOINTED', tree: DiffHash.parse('0000002') },
      stateTagAfter: 'RUNNING_AGENT',
    };
    expect(renderWatchEvent(checkpoint, 2)).toBeNull();
  });
});
