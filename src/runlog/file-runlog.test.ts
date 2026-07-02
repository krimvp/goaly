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
    event: { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } },
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

  it('drops a torn (unterminated) final line instead of rejecting the log', async () => {
    const dir = await freshDir();
    try {
      const log = new FileRunLog(dir);
      const header = makeHeader();
      await log.writeHeader(header);
      await log.append(gateEntry(0));
      await log.append(agentRanEntry(1));
      // Simulate a crash mid-append: a partial JSON prefix with NO terminating newline.
      const torn = JSON.stringify(agentRanEntry(2)).slice(0, 40);
      await appendFile(join(dir, 'log.jsonl'), torn, 'utf8');

      const result = await log.read();
      expect(result?.entries).toEqual([gateEntry(0), agentRanEntry(1)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('repairs a torn tail on the next append so later reads stay valid', async () => {
    const dir = await freshDir();
    try {
      const log = new FileRunLog(dir);
      await log.writeHeader(makeHeader());
      await log.append(gateEntry(0));
      const torn = JSON.stringify(agentRanEntry(1)).slice(0, 25);
      await appendFile(join(dir, 'log.jsonl'), torn, 'utf8');

      // A NEW process (fresh FileRunLog) resumes and appends: the torn tail must be truncated
      // first, never fused with the new entry into one corrupt line.
      const resumed = new FileRunLog(dir);
      await resumed.append(agentRanEntry(1));

      const result = await resumed.read();
      expect(result?.entries).toEqual([gateEntry(0), agentRanEntry(1)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recovers when the whole log is a single torn first line', async () => {
    const dir = await freshDir();
    try {
      const log = new FileRunLog(dir);
      await log.writeHeader(makeHeader());
      await writeFile(join(dir, 'log.jsonl'), '{"partial', 'utf8');

      const read = await log.read();
      expect(read?.entries).toEqual([]);

      const resumed = new FileRunLog(dir);
      await resumed.append(gateEntry(0));
      expect((await resumed.read())?.entries).toEqual([gateEntry(0)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('still rejects a TERMINATED corrupt line even when it is the final line', async () => {
    const dir = await freshDir();
    try {
      const log = new FileRunLog(dir);
      await log.writeHeader(makeHeader());
      await log.append(gateEntry(0));
      // Terminated (newline'd) garbage is real corruption, not a torn append — fail closed.
      await appendFile(join(dir, 'log.jsonl'), '{ not valid json\n', 'utf8');
      await expect(log.read()).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('repairs a torn tail longer than one scan chunk (newline beyond 4KB from the end)', async () => {
    const dir = await freshDir();
    try {
      const log = new FileRunLog(dir);
      await log.writeHeader(makeHeader());
      await log.append(gateEntry(0));
      // A torn tail larger than the 4096-byte backward-scan chunk.
      await appendFile(join(dir, 'log.jsonl'), `{"pad":"${'x'.repeat(10_000)}`, 'utf8');

      const resumed = new FileRunLog(dir);
      await resumed.append(agentRanEntry(1));
      expect((await resumed.read())?.entries).toEqual([gateEntry(0), agentRanEntry(1)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
