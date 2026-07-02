import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { FileRunLog } from '../runlog/file-runlog';
import { runLockActive } from '../runlog/lock';
import { STREAM_FILE, StreamTranscriptEntry } from '../runlog/stream-transcript';
import type { SseFrame } from './api-schema';

/**
 * Injectable seams for the live tail (tests script them; production uses the real ones).
 * Mirrors `runsWatch` (src/cli/watch.ts) — the same poll-the-write-ahead-log loop, re-skinned to
 * emit typed frames instead of human lines.
 */
export type TailDeps = {
  /** Poll interval between reads. Default 500 ms. */
  pollMs?: number;
  /** Injected sleep (tests pass a scripted one). Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected run-activity probe. Default: a live pid holds `run.lock`. */
  isActive?: (runDir: string) => Promise<boolean>;
  /** Emit a heartbeat after this many idle polls. Default 30 (≈15 s at the default poll). */
  heartbeatPolls?: number;
};

const DEFAULT_POLL_MS = 500;
const DEFAULT_HEARTBEAT_POLLS = 30;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Follow one run's write-ahead log (and, when present, its stream transcript) as typed SSE frames.
 * Strictly READ-ONLY: it never takes the run lock, so it can watch a run any process is driving —
 * terminal-started runs included. The generator ends after `terminal` (the LAST entry is
 * DONE/FAILED/ABORTED — a terminal tag mid-log is a superseded outcome that a RUN_EXTENDED revived,
 * exactly the `runs watch` rule). It throws on a missing/corrupt run — the router maps that to
 * 404/409 BEFORE any SSE bytes are written. `signal` aborts the loop when the client disconnects.
 */
export async function* tailRun(
  runDir: string,
  runId: string,
  deps: TailDeps = {},
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const log = new FileRunLog(runDir);
  const sleep = deps.sleep ?? realSleep;
  const isActive = deps.isActive ?? runLockActive;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;
  const heartbeatPolls = deps.heartbeatPolls ?? DEFAULT_HEARTBEAT_POLLS;

  const transcript = makeTranscriptTail(join(runDir, STREAM_FILE));
  let sentEntries = 0;
  let lastLive: boolean | undefined;
  let idlePolls = 0;
  let announced = false;

  for (;;) {
    if (signal?.aborted) return;
    const stored = await log.read(); // throws on a TERMINATED corrupt line — the caller maps it
    if (stored === null) throw new NoSuchRunError(runId);

    if (!announced) {
      announced = true;
      yield { event: 'hello', data: { runId, header: stored.header } };
    }

    let sentSomething = false;
    for (const entry of stored.entries.slice(sentEntries)) {
      yield { event: 'entry', data: entry };
      sentSomething = true;
    }
    sentEntries = stored.entries.length;

    for (const entry of await transcript.readNew()) {
      yield { event: 'stream', data: entry };
      sentSomething = true;
    }

    const last = stored.entries[stored.entries.length - 1];
    if (last !== undefined && isTerminalTag(last.stateTagAfter)) {
      yield { event: 'terminal', data: { stateTag: last.stateTagAfter } };
      return;
    }

    const live = await isActive(runDir);
    if (live !== lastLive) {
      lastLive = live;
      yield { event: 'liveness', data: { live } };
      sentSomething = true;
    }

    idlePolls = sentSomething ? 0 : idlePolls + 1;
    if (idlePolls >= heartbeatPolls) {
      idlePolls = 0;
      yield { event: 'heartbeat', data: {} };
    }
    await sleep(pollMs);
  }
}

/** Thrown when the run directory has no header — the router maps it to a 404. */
export class NoSuchRunError extends Error {
  constructor(runId: string) {
    super(`no such run: ${runId}`);
    this.name = 'NoSuchRunError';
  }
}

function isTerminalTag(tag: string): boolean {
  return tag === 'DONE' || tag === 'FAILED' || tag === 'ABORTED';
}

/**
 * Incremental reader over `stream.jsonl`: reads only the bytes appended since the last poll,
 * buffers a partial trailing line, and Zod-parses each complete line — a corrupt/torn line is
 * dropped, never a crash (the transcript is observability, not state; same tolerance as
 * `readStreamTranscript`). A missing file just yields nothing (transcripts are opt-in).
 */
function makeTranscriptTail(path: string): { readNew(): Promise<StreamTranscriptEntry[]> } {
  let offset = 0;
  let pending = '';
  return {
    async readNew(): Promise<StreamTranscriptEntry[]> {
      let handle;
      try {
        handle = await open(path, 'r');
      } catch {
        return []; // no transcript (opt-in) — nothing to tail
      }
      try {
        const { size } = await handle.stat();
        if (size <= offset) return [];
        const buf = Buffer.alloc(size - offset);
        await handle.read(buf, 0, buf.length, offset);
        offset = size;
        const text = pending + buf.toString('utf8');
        const lines = text.split('\n');
        pending = lines.pop() ?? '';
        const out: StreamTranscriptEntry[] = [];
        for (const line of lines) {
          if (line.trim().length === 0) continue;
          try {
            const parsed = StreamTranscriptEntry.safeParse(JSON.parse(line));
            if (parsed.success) out.push(parsed.data);
          } catch {
            // corrupt line — drop it (fail-soft: observability only)
          }
        }
        return out;
      } finally {
        await handle.close();
      }
    },
  };
}
