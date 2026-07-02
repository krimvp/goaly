import { z } from 'zod';
import type { RunDetail, RunSummary } from '../runlog/inspect';
import type { WorktreeInfo } from '../workspace/worktree-manager';
import type { RunLogEntry, RunLogHeader } from '../runlog/runlog';
import type { StreamTranscriptEntry } from '../runlog/stream-transcript';

/**
 * The `goaly ui` HTTP wire shapes. Requests parse with Zod fail-closed (invariant #6); responses
 * are the EXISTING run-log projections serialized as-is, so the browser reads exactly what
 * `goaly runs list/show` render and nothing bespoke can drift from the log.
 *
 * The types here are shared with the browser bundle — `src/ui/web/` imports them **as types only**
 * (`import type`), so no zod ships to the client.
 */

/**
 * A run id as a URL path segment. Deliberately stricter than "any string": it becomes a directory
 * name under the state dir, so this schema is ALSO the path-traversal guard (no `/`, no `..`).
 */
export const RunIdParam = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);

/** Which checkout a run lives in: the main workspace or a goaly-managed worktree. */
export type RootRef = { kind: 'main' } | { kind: 'worktree'; name: string };

/** One run in the index: the `runs list` projection plus a liveness badge. */
export type ApiRunListItem =
  | { ok: true; summary: RunSummary; live: boolean }
  | { ok: false; runId: string; error: string };

/** `GET /api/runs` — every run across every root, most-recent first per root. */
export type RunsIndex = {
  roots: Array<{ root: RootRef; runs: ApiRunListItem[] }>;
};

/** `GET /api/runs/:id` — the full `runs show` projection plus where it lives and liveness. */
export type RunDetailResponse = {
  root: RootRef;
  live: boolean;
  detail: RunDetail;
};

/** `GET /api/worktrees` — the `worktree list` projection. */
export type WorktreesResponse = { worktrees: WorktreeInfo[] };

/** `GET /api/version`. */
export type VersionResponse = { name: string; version: string };

/** `GET /api/runs/:id/transcript` — parsed stream.jsonl entries (absent file ⇒ 204). */
export type TranscriptResponse = { entries: StreamTranscriptEntry[]; total: number };

/**
 * The SSE frames `GET /api/runs/:id/events` emits (one `event:`/`data:` pair each):
 *  - `hello`     — the run header, once, on connect
 *  - `entry`     — one write-ahead {@link RunLogEntry} as it lands (seq-ordered)
 *  - `liveness`  — `{ live }` on every change of "a live process is driving this run"
 *  - `terminal`  — `{ stateTag }` when the LAST entry is DONE/FAILED/ABORTED; the stream then ends
 *  - `stream`    — one per-turn {@link StreamTranscriptEntry} (only when the run records a transcript)
 *  - `heartbeat` — keepalive when nothing else was sent (proxies drop idle connections)
 */
export type SseFrame =
  | { event: 'hello'; data: { runId: string; header: RunLogHeader } }
  | { event: 'entry'; data: RunLogEntry }
  | { event: 'liveness'; data: { live: boolean } }
  | { event: 'terminal'; data: { stateTag: string; error?: string } }
  | { event: 'stream'; data: StreamTranscriptEntry }
  | { event: 'heartbeat'; data: Record<string, never> };

/** `?after=<n>` pagination for the transcript route (a non-negative integer, fail-closed). */
export const AfterParam = z.coerce.number().int().nonnegative().default(0);
