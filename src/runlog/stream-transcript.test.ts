import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  StreamTranscriptSink,
  StreamTranscriptEntry,
  readStreamTranscript,
  STREAM_FILE,
} from './stream-transcript';
import { FileRunLog } from './file-runlog';
import { drive, type DriverDeps } from '../driver/driver';
import type { HarnessAdapter } from '../harness/adapter';
import { HarnessRunResult } from '../domain/events';
import { SessionId, asRunId } from '../domain/ids';
import { replay } from './replay';
import type { LogFs } from '../log/sinks';
import type { AgentEventSink, AgentStreamEvent, StreamPhase } from '../agent-cli/stream';
import {
  FakeCompiler,
  FakeGate,
  FakeVerifier,
  FakeApprover,
  FakeWorkspace,
  ManualClock,
  ManualBudgetMeter,
  makeFakeContract,
  makeConfig,
  passVerdict,
  approve,
} from '../testing/fakes';

let counter = 0;
async function freshDir(): Promise<string> {
  counter += 1;
  return mkdtemp(join(tmpdir(), `stream-transcript-${process.pid}-${counter}-`));
}

/** An in-memory {@link LogFs} so the synchronous sink is tested without touching disk. */
function memFs(): LogFs & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    size: (p) => (files.has(p) ? Buffer.byteLength(files.get(p)!, 'utf8') : null),
    append: (p, data) => files.set(p, (files.get(p) ?? '') + data),
    exists: (p) => files.has(p),
    rename: (from, to) => {
      const v = files.get(from);
      if (v !== undefined) {
        files.set(to, v);
        files.delete(from);
      }
    },
    remove: (p) => void files.delete(p),
    ensureDir: (d) => void dirs.add(d),
  };
}

/** A {@link LogFs} whose first write throws — exercises the fail-closed latch. */
function throwingFs(on: 'append' | 'ensureDir'): LogFs {
  const base = memFs();
  return {
    ...base,
    append: (p, data) => {
      if (on === 'append') throw new Error('disk full');
      base.append(p, data);
    },
    ensureDir: (d) => {
      if (on === 'ensureDir') throw new Error('EACCES');
      base.ensureDir(d);
    },
  };
}

const fixedNow = (): number => 1_700_000_000_000;

describe('StreamTranscriptEntry schema', () => {
  it('accepts the flat { phase, ts, ...event } shape for every event variant', () => {
    const variants: AgentStreamEvent[] = [
      { kind: 'session', sessionId: 's1' },
      { kind: 'message', text: 'hi', delta: true },
      { kind: 'reasoning', text: 'thinking' },
      { kind: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'x' } },
      { kind: 'tool_result', id: 't1', output: 'ok', exitCode: 0 },
      { kind: 'usage', inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      { kind: 'done', status: 'completed' },
    ];
    for (const event of variants) {
      const parsed = StreamTranscriptEntry.parse({ ...event, phase: 'agent', ts: 1 });
      expect(parsed).toMatchObject(event);
      expect(parsed.phase).toBe('agent');
      expect(parsed.ts).toBe(1);
    }
  });

  it('rejects an unknown phase, a missing ts, and a non-event body', () => {
    expect(StreamTranscriptEntry.safeParse({ kind: 'done', status: 'x', phase: 'nope', ts: 1 }).success).toBe(false);
    expect(StreamTranscriptEntry.safeParse({ kind: 'done', status: 'x', phase: 'agent' }).success).toBe(false);
    expect(StreamTranscriptEntry.safeParse({ kind: 'bogus', phase: 'agent', ts: 1 }).success).toBe(false);
  });
});

describe('StreamTranscriptSink', () => {
  it('appends one canonical { phase, ts, ...event } JSON line per event', () => {
    const fs = memFs();
    const sink = new StreamTranscriptSink({ path: '/run/stream.jsonl', now: fixedNow, fs });
    sink.record('agent', { kind: 'message', text: 'hello' });
    sink.record('judge', { kind: 'done', status: 'completed' });

    const lines = (fs.files.get('/run/stream.jsonl') ?? '').split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ kind: 'message', text: 'hello', phase: 'agent', ts: fixedNow() });
    expect(JSON.parse(lines[1]!)).toEqual({ kind: 'done', status: 'completed', phase: 'judge', ts: fixedNow() });
    expect(fs.dirs.has('/run')).toBe(true); // ensured the directory lazily on first write
  });

  it('never throws and latches off when a write fails (fail-closed → no transcript)', () => {
    let appends = 0;
    const fs: LogFs = { ...memFs(), append: () => { appends += 1; throw new Error('disk full'); } };
    const sink = new StreamTranscriptSink({ path: '/run/stream.jsonl', now: fixedNow, fs });
    expect(() => sink.record('agent', { kind: 'done', status: 'x' })).not.toThrow();
    expect(() => sink.record('agent', { kind: 'done', status: 'y' })).not.toThrow();
    // After the first failure the sink degrades to "no transcript" — it does not retry the syscall.
    expect(appends).toBe(1);
  });

  it('swallows an ensureDir failure (still never throws)', () => {
    const sink = new StreamTranscriptSink({ path: '/run/stream.jsonl', now: fixedNow, fs: throwingFs('ensureDir') });
    expect(() => sink.record('agent', { kind: 'done', status: 'x' })).not.toThrow();
  });
});

describe('readStreamTranscript', () => {
  it('round-trips events written by the sink (write → read)', async () => {
    const dir = await freshDir();
    try {
      const runDir = join(dir, 'run-1');
      const sink = new StreamTranscriptSink({ path: join(runDir, STREAM_FILE), now: fixedNow });
      const events: Array<[StreamPhase, AgentStreamEvent]> = [
        ['agent', { kind: 'session', sessionId: 's1' }],
        ['agent', { kind: 'tool_use', name: 'command', input: 'npm test' }],
        ['judge', { kind: 'usage', inputTokens: 10, outputTokens: 20, totalTokens: 30 }],
      ];
      for (const [phase, event] of events) sink.record(phase, event);

      const read = await readStreamTranscript(dir, 'run-1');
      expect(read).toEqual(
        events.map(([phase, event]) => ({ ...event, phase, ts: fixedNow() })),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('drops corrupt lines (non-JSON and schema-invalid), keeping the good ones', async () => {
    const dir = await freshDir();
    try {
      const runDir = join(dir, 'run-1');
      const path = join(runDir, STREAM_FILE);
      // Seed the directory via the sink (it creates it lazily), then hand-write a mixed file.
      new StreamTranscriptSink({ path, now: fixedNow }).record('agent', { kind: 'done', status: 'seed' });
      const good1 = JSON.stringify({ kind: 'message', text: 'a', phase: 'agent', ts: 1 });
      const good2 = JSON.stringify({ kind: 'done', status: 'ok', phase: 'judge', ts: 2 });
      const file = [good1, '{ not json', JSON.stringify({ kind: 'bogus', phase: 'agent', ts: 3 }), good2, ''].join('\n');
      await writeFile(path, file, 'utf8');

      const read = await readStreamTranscript(dir, 'run-1');
      expect(read).toEqual([
        { kind: 'message', text: 'a', phase: 'agent', ts: 1 },
        { kind: 'done', status: 'ok', phase: 'judge', ts: 2 },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns null when no transcript was captured (file absent)', async () => {
    const dir = await freshDir();
    try {
      expect(await readStreamTranscript(dir, 'run-missing')).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('propagates a non-ENOENT read error (a real IO failure is not masked as null)', async () => {
    const dir = await freshDir();
    try {
      const { mkdir } = await import('node:fs/promises');
      // Make the transcript path a DIRECTORY so readFile fails with EISDIR (not ENOENT).
      await mkdir(join(dir, 'run-1', STREAM_FILE), { recursive: true });
      await expect(readStreamTranscript(dir, 'run-1')).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns [] when the transcript file exists but is empty', async () => {
    const dir = await freshDir();
    try {
      const runDir = join(dir, 'run-1');
      // Seed the directory via the sink, then truncate to empty.
      new StreamTranscriptSink({ path: join(runDir, STREAM_FILE), now: fixedNow }).record('agent', { kind: 'done', status: 'x' });
      await writeFile(join(runDir, STREAM_FILE), '', 'utf8');
      expect(await readStreamTranscript(dir, 'run-1')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---- end-to-end: the transcript is a SEPARATE file; resume/replay is unaffected ----

/** A harness that mutates the workspace (so there is a diff) and emits canned stream events. */
class StreamingHarness implements HarnessAdapter {
  readonly name = 'streaming-fake';
  constructor(
    private readonly ws: FakeWorkspace,
    private readonly events: AgentStreamEvent[],
  ) {}
  async run(_prompt: string, sessionId?: SessionId, onEvent?: AgentEventSink): Promise<HarnessRunResult> {
    this.ws.setHash('bbbbbbb');
    for (const e of this.events) onEvent?.(e);
    return HarnessRunResult.parse({
      output: 'done',
      sessionId: sessionId ?? SessionId.parse('s1'),
      status: 'completed',
    });
  }
}

const canned: AgentStreamEvent[] = [
  { kind: 'session', sessionId: 's1' },
  { kind: 'tool_use', name: 'command', input: 'npm test' },
  { kind: 'message', text: 'done' },
];

describe('stream transcript end-to-end (issue #28)', () => {
  it('writes stream.jsonl separately from log.jsonl; replay over the log is unaffected', async () => {
    const dir = await freshDir();
    try {
      const runId = asRunId('run-e2e');
      const runDir = join(dir, runId);
      const ws = new FakeWorkspace('aaaaaaa');
      const runlog = new FileRunLog(runDir);
      const transcript = new StreamTranscriptSink({ path: join(runDir, STREAM_FILE), now: fixedNow });
      const deps: DriverDeps = {
        compiler: new FakeCompiler(makeFakeContract()),
        gateA: new FakeGate({ kind: 'approve' }),
        harness: new StreamingHarness(ws, canned),
        makeLadder: () => new FakeVerifier([passVerdict()]),
        approver: new FakeApprover([approve()]),
        workspace: ws,
        clock: new ManualClock(),
        budget: new ManualBudgetMeter(),
        runlog,
        onStreamEvent: (phase, event) => transcript.record(phase, event),
      };

      const outcome = await drive(deps, makeConfig({ autonomous: true }), runId);
      expect(outcome.status).toBe('DONE');

      // The two files are distinct and both present.
      expect((await stat(join(runDir, 'log.jsonl'))).isFile()).toBe(true);
      expect((await stat(join(runDir, STREAM_FILE))).isFile()).toBe(true);

      // The replay log holds ONLY OrchestratorEvents (`tag`), never AgentStreamEvents (`kind`).
      const stored = await runlog.read();
      expect(stored).not.toBeNull();
      for (const entry of stored!.entries) {
        expect(entry.event).toHaveProperty('tag');
        expect(entry.event).not.toHaveProperty('kind');
      }
      // Replay over the log reconstructs the terminal state with no dependence on the transcript.
      expect(replay(stored!.header.config, stored!.entries).state.tag).toBe('DONE');

      // The transcript holds the agent-phase events verbatim, readable offline.
      const events = await readStreamTranscript(dir, runId);
      expect(events).toEqual(canned.map((e) => ({ ...e, phase: 'agent', ts: fixedNow() })));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
