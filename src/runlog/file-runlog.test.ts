import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileRunLog } from './file-runlog';
import type { RunLogHeader, RunLogEntry } from './runlog';
import { RunId, DiffHash, SessionId, ContractHash } from '../domain/ids';
import { makeConfig } from '../testing/fakes';

let counter = 0;
async function freshDir(): Promise<string> {
  counter += 1;
  return mkdtemp(join(tmpdir(), `file-runlog-${process.pid}-${counter}-`));
}

function makeHeader(): RunLogHeader {
  return {
    runId: RunId.parse('run-abc'),
    startedAt: 1_700_000_000_000,
    config: makeConfig(),
  };
}

function agentRanEntry(seq: number): RunLogEntry {
  return {
    runId: RunId.parse('run-abc'),
    seq,
    ts: 1_700_000_000_000 + seq,
    contractHash: ContractHash.parse('a1b2c3d'),
    event: {
      tag: 'AGENT_RAN',
      run: {
        output: 'did the thing',
        sessionId: SessionId.parse('sess-1'),
        status: 'completed',
        tokensUsed: 42,
      },
      prevDiffHash: DiffHash.parse('0000000'),
      diffHash: DiffHash.parse('deadbee'),
      budget: { exceeded: false },
    },
    stateTagAfter: 'VERIFYING',
  };
}

function gateEntry(seq: number): RunLogEntry {
  return {
    runId: RunId.parse('run-abc'),
    seq,
    ts: 1_700_000_000_000 + seq,
    contractHash: null,
    event: { tag: 'GATE_A_DECIDED', decision: { approved: true } },
    stateTagAfter: 'RUNNING',
  };
}

describe('FileRunLog', () => {
  it('round-trips a header and multiple entries via read()', async () => {
    const dir = await freshDir();
    try {
      const log = new FileRunLog(dir);
      const header = makeHeader();
      const entries: RunLogEntry[] = [gateEntry(0), agentRanEntry(1), agentRanEntry(2)];

      await log.writeHeader(header);
      for (const e of entries) await log.append(e);

      const result = await log.read();
      expect(result).not.toBeNull();
      expect(result?.header).toEqual(header);
      expect(result?.entries).toEqual(entries);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('persists the header as parseable JSON on disk', async () => {
    const dir = await freshDir();
    try {
      const header = makeHeader();
      await new FileRunLog(dir).writeHeader(header);
      const raw = await readFile(join(dir, 'header.json'), 'utf8');
      expect(JSON.parse(raw)).toEqual(header);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a fresh directory with no header', async () => {
    const dir = await freshDir();
    try {
      const result = await new FileRunLog(dir).read();
      expect(result).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns empty entries when a header exists but no log lines were appended', async () => {
    const dir = await freshDir();
    try {
      const log = new FileRunLog(dir);
      const header = makeHeader();
      await log.writeHeader(header);
      const result = await log.read();
      expect(result).toEqual({ header, entries: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects when a log line is corrupt (untrusted on read)', async () => {
    const dir = await freshDir();
    try {
      const log = new FileRunLog(dir);
      await log.writeHeader(makeHeader());
      await log.append(agentRanEntry(0));
      // Hand-corrupt the log: append a line that is not valid JSON.
      await appendFile(join(dir, 'log.jsonl'), '{ not valid json\n', 'utf8');

      await expect(log.read()).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects when a log line is valid JSON but violates the schema', async () => {
    const dir = await freshDir();
    try {
      const log = new FileRunLog(dir);
      await log.writeHeader(makeHeader());
      // A structurally-JSON line that is not a valid RunLogEntry.
      await writeFile(join(dir, 'log.jsonl'), `${JSON.stringify({ seq: 'nope' })}\n`, 'utf8');

      await expect(log.read()).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
