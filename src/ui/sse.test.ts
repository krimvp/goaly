import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, appendFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRunLog } from '../runlog/file-runlog';
import { STREAM_FILE } from '../runlog/stream-transcript';
import { makeConfig, makeFakeContract } from '../testing/fakes';
import { RunId, ContractHash, DiffHash, SessionId } from '../domain/ids';
import type { RunLogEntry } from '../runlog/runlog';
import { tailRun, NoSuchRunError } from './sse';
import type { SseFrame } from './api-schema';

const RUN_ID = 'run-sse-test';

function entry(seq: number, event: RunLogEntry['event'], stateTagAfter: string): RunLogEntry {
  return {
    runId: RunId.parse(RUN_ID),
    seq,
    ts: 1000 + seq,
    contractHash: ContractHash.parse('c'.repeat(64)),
    event,
    stateTagAfter: stateTagAfter as RunLogEntry['stateTagAfter'],
  };
}

const agentRan = (): RunLogEntry['event'] => ({
  tag: 'AGENT_RAN',
  run: { output: 'ok', sessionId: SessionId.parse('s1'), status: 'completed' },
  prevDiffHash: DiffHash.parse('0000000'),
  diffHash: DiffHash.parse('0000001'),
  budget: { exceeded: false },
});

describe('tailRun — the SSE live tail over the write-ahead log', () => {
  let dir: string;
  let runDir: string;
  let log: FileRunLog;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'goaly-sse-'));
    runDir = join(dir, RUN_ID);
    log = new FileRunLog(runDir);
    await log.writeHeader({
      runId: RunId.parse(RUN_ID),
      startedAt: 1000,
      config: makeConfig(),
      harness: 'fake',
    });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function collect(
    deps: { isActive?: (d: string) => Promise<boolean>; maxSleeps?: number; heartbeatPolls?: number },
  ): Promise<SseFrame[]> {
    const abort = new AbortController();
    let sleeps = 0;
    const frames: SseFrame[] = [];
    const gen = tailRun(
      runDir,
      RUN_ID,
      {
        sleep: async () => {
          sleeps += 1;
          if (sleeps >= (deps.maxSleeps ?? 5)) abort.abort();
        },
        isActive: deps.isActive ?? (async () => true),
        ...(deps.heartbeatPolls !== undefined ? { heartbeatPolls: deps.heartbeatPolls } : {}),
      },
      abort.signal,
    );
    for await (const frame of gen) frames.push(frame);
    return frames;
  }

  it('emits hello → entries in seq order → terminal, then ends', async () => {
    const contract = makeFakeContract();
    await log.append(entry(1, { tag: 'CONTRACT_COMPILED', contract }, 'AWAIT_SEAL'));
    await log.append(entry(2, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }, 'RUNNING_AGENT'));
    await log.append(entry(3, agentRan(), 'VERIFYING'));
    await log.append(entry(4, { tag: 'VERIFIED', verdict: { pass: true, confidence: 1, detail: 'green' } }, 'AWAIT_SIGNOFF'));
    await log.append(entry(5, { tag: 'SIGNOFF_DECIDED', approval: { veto: false } }, 'DONE'));

    const frames = await collect({});
    expect(frames[0]?.event).toBe('hello');
    const entries = frames.filter((f) => f.event === 'entry');
    expect(entries.map((f) => (f.data as RunLogEntry).seq)).toEqual([1, 2, 3, 4, 5]);
    expect(frames[frames.length - 1]).toEqual({ event: 'terminal', data: { stateTag: 'DONE' } });
  });

  it('a terminal tag MID-log does not end the stream (a RUN_EXTENDED revived the run)', async () => {
    await log.append(entry(1, agentRan(), 'VERIFYING'));
    await log.append(entry(2, { tag: 'VERIFIED', verdict: { pass: false, confidence: 1, detail: 'red' } }, 'ABORTED'));
    await log.append(entry(3, { tag: 'RUN_EXTENDED', maxIterations: 5 }, 'ABORTED'));
    await log.append(entry(4, agentRan(), 'VERIFYING'));

    const frames = await collect({ maxSleeps: 3 });
    // No terminal frame: the LAST entry is VERIFYING, so the mid-log ABORTED is superseded.
    expect(frames.some((f) => f.event === 'terminal')).toBe(false);
    expect(frames.filter((f) => f.event === 'entry')).toHaveLength(4);
  });

  it('emits liveness on change, and heartbeats when idle', async () => {
    await log.append(entry(1, agentRan(), 'VERIFYING'));
    let live = true;
    const frames = await collect({
      isActive: async () => live,
      maxSleeps: 6,
      heartbeatPolls: 2,
    });
    expect(frames.filter((f) => f.event === 'liveness').map((f) => f.data)).toEqual([{ live: true }]);
    expect(frames.some((f) => f.event === 'heartbeat')).toBe(true);
  });

  it('tails stream.jsonl incrementally when present, dropping corrupt lines', async () => {
    await log.append(entry(1, agentRan(), 'VERIFYING'));
    await appendFile(
      join(runDir, STREAM_FILE),
      `${JSON.stringify({ kind: 'message', text: 'hi', phase: 'agent', ts: 1 })}\n` +
        `not json\n` +
        `${JSON.stringify({ kind: 'tool_use', name: 'edit', phase: 'agent', ts: 2 })}\n`,
    );
    const frames = await collect({ maxSleeps: 3 });
    const stream = frames.filter((f) => f.event === 'stream');
    expect(stream).toHaveLength(2);
    expect(stream.map((f) => (f.data as { kind: string }).kind)).toEqual(['message', 'tool_use']);
  });

  it('throws NoSuchRunError for a directory without a header (the router maps it to 404)', async () => {
    const missing = join(dir, 'run-none');
    await mkdir(missing, { recursive: true });
    const gen = tailRun(missing, 'run-none', { sleep: async () => {} });
    await expect(gen.next()).rejects.toThrow(NoSuchRunError);
  });
});
