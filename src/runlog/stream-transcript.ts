/**
 * Durable, standardized cross-agent stream transcript (issue #28). Where the run log
 * ({@link ./file-runlog.ts}) is the write-ahead source of truth for resume, this is its
 * OBSERVATIONAL sibling: a per-run JSONL file capturing the canonical, tool-neutral
 * {@link AgentStreamEvent} taxonomy (issue #23) verbatim, one `{ phase, ts, ...event }` object per
 * line, so any consumer — a UI, a cost report, an analyzer — can replay a run's stream offline
 * without re-running the agent, independent of `--log-level`.
 *
 * Because the events are already tool-neutral, the transcript is identical in shape across
 * claude / codex / droid / future goaly-code harnesses — that is the whole point.
 *
 * Two invariants govern this module:
 * - It is a SEPARATE file from `log.jsonl` and is NEVER the state replay source, so resume stays a
 *   pure fold over `OrchestratorEvent` only (invariant #7).
 * - It is fail-closed everywhere (invariant #4): a write failure degrades to "no transcript" and a
 *   corrupt line on read is DROPPED — never a crash, never a changed outcome.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AgentStreamEvent, StreamPhase, type PhasedStreamSink } from '../agent-cli/stream';
import { nodeLogFs, type LogFs } from '../log/sinks';

/** The per-run stream transcript filename, co-located with the run log under `.goaly/<runId>/`. */
export const STREAM_FILE = 'stream.jsonl';

/**
 * One persisted transcript line: the canonical {@link AgentStreamEvent} verbatim, tagged with the
 * originating {@link StreamPhase} and a capture timestamp (epoch ms). The flat `{ phase, ts, ...event }`
 * shape means a consumer reads one uniform object per line, identical across every harness. The
 * taxonomy is versioned by extension (older readers stay forward-compatible), so no header line is
 * needed — every line is a complete, self-describing entry.
 */
export const StreamTranscriptEntry = z.intersection(
  AgentStreamEvent,
  z.object({ phase: StreamPhase, ts: z.number() }),
);
export type StreamTranscriptEntry = z.infer<typeof StreamTranscriptEntry>;

export type StreamTranscriptOptions = {
  /** Absolute path to the transcript file (default `<stateDir>/<runId>/stream.jsonl`). */
  path: string;
  /** Capture-time clock for the `ts` field (epoch ms). */
  now: () => number;
  /** Injected synchronous filesystem (tests). Default {@link nodeLogFs}. */
  fs?: LogFs;
};

/**
 * Durable, append-only stream transcript. Subscribe its {@link record} method to the phase-tagged
 * stream (it IS a {@link PhasedStreamSink}); it writes one {@link StreamTranscriptEntry} per line.
 *
 * Writes are synchronous (the same discipline as the rotating diagnostics sink — an observability
 * file, not a hot path) and never split a line, so the `void` sink contract stays honest (no
 * floating promise). The transcript is deliberately UNCAPPED: it is per-run and is the substrate
 * features fold over, so it must be complete — a size-rotation that dropped early `usage`/`tool`
 * events would silently corrupt an offline cost report or analyzer.
 *
 * Fail-closed: any write error latches the sink OFF, degrading to "no transcript" rather than
 * crashing the run, changing an outcome, or retrying a failing syscall every event.
 */
export class StreamTranscriptSink {
  readonly #path: string;
  readonly #now: () => number;
  readonly #fs: LogFs;
  #dirReady = false;
  #disabled = false;

  constructor(opts: StreamTranscriptOptions) {
    this.#path = opts.path;
    this.#now = opts.now;
    this.#fs = opts.fs ?? nodeLogFs;
  }

  /** The {@link PhasedStreamSink} this transcript exposes — bind once, hand to the fan-out. */
  readonly record: PhasedStreamSink = (phase, event) => {
    if (this.#disabled) return;
    try {
      if (!this.#dirReady) {
        this.#fs.ensureDir(dirname(this.#path));
        this.#dirReady = true;
      }
      // `event` is already Zod-validated upstream by the StreamTap; serialize the flat entry.
      this.#fs.append(this.#path, `${JSON.stringify({ ...event, phase, ts: this.#now() })}\n`);
    } catch {
      // Fail-closed: a transcript write failure must never change a run's outcome.
      this.#disabled = true;
    }
  };
}

/**
 * Read a run's durable stream transcript for offline replay. Returns the canonical entries in write
 * order, or `null` when no transcript was captured (the file is absent). The transcript is
 * OBSERVATIONAL, not the state source, so — unlike the run log, where a corrupt line is a hard error
 * — a corrupt line here is DROPPED (the same "parse at the seam, skip garbage, never throw"
 * discipline as the live {@link StreamTap}). Every surviving line is validated against
 * {@link StreamTranscriptEntry}.
 */
export async function readStreamTranscript(
  stateDir: string,
  runId: string,
): Promise<StreamTranscriptEntry[] | null> {
  let raw: string;
  try {
    raw = await readFile(join(stateDir, runId, STREAM_FILE), 'utf8');
  } catch (err: unknown) {
    if (isNotFound(err)) return null;
    throw err;
  }
  const out: StreamTranscriptEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      continue; // a non-JSON line is dropped — observability, never the state source
    }
    const parsed = StreamTranscriptEntry.safeParse(json);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
