import { z } from 'zod';
import type { RunDetail, RunSummary } from '../runlog/inspect';
import { WorktreeName, type WorktreeInfo } from '../workspace/worktree-manager';
import type { RunLogEntry, RunLogHeader } from '../runlog/runlog';
import type { StreamTranscriptEntry } from '../runlog/stream-transcript';
import type { CompiledContract } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';

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
 *  - `gate`      — a Seal / plan-Seal is PARKED awaiting the browser's decision (UI-owned runs)
 *  - `gate-resolved` — that gate was answered (from this tab or another)
 *  - `heartbeat` — keepalive when nothing else was sent (proxies drop idle connections)
 */
export type SseFrame =
  | { event: 'hello'; data: { runId: string; header: RunLogHeader } }
  | { event: 'entry'; data: RunLogEntry }
  | { event: 'liveness'; data: { live: boolean } }
  | { event: 'terminal'; data: { stateTag: string; error?: string } }
  | { event: 'stream'; data: StreamTranscriptEntry }
  | { event: 'gate'; data: PendingGate }
  | { event: 'gate-resolved'; data: { gateId: string } }
  | { event: 'heartbeat'; data: Record<string, never> };

/** `?after=<n>` pagination for the transcript route (a non-negative integer, fail-closed). */
export const AfterParam = z.coerce.number().int().nonnegative().default(0);

// ---- interactive routes (ADR 0015) -----------------------------------------

/** A parked Seal / plan-Seal awaiting a browser decision. `gateId` guards double-submits. */
export type PendingGate =
  | { gateId: string; kind: 'seal'; contract: CompiledContract }
  | { gateId: string; kind: 'plan'; plan: PhasePlan };

/**
 * `POST /api/runs` — start a UI-owned run. `.strict()` fail-closed: an unknown field is a 400,
 * never silently ignored (invariant #6). Exactly one of `verifyCmd` / `generate` picks the
 * verification source, mirroring the CLI. `autonomous: false` (the default) parks the run at the
 * browser Seal gate — the whole point of starting it from the UI.
 */
export const StartRunRequest = z
  .object({
    goal: z.string().min(1).max(100_000),
    verifyCmd: z.string().min(1).optional(),
    generate: z.boolean().optional(),
    intent: z.string().min(1).optional(),
    rubric: z.string().min(1).optional(),
    harness: z.enum(['claude', 'codex', 'droid', 'pi', 'goaly-code', 'fake']).optional(),
    autonomous: z.boolean().default(false),
    phased: z.boolean().optional(),
    maxIterations: z.number().int().positive().max(1000).optional(),
    budgetTokens: z.number().int().positive().optional(),
    model: z.string().min(1).optional(),
    worktree: z.object({ name: WorktreeName, base: z.string().min(1).optional() }).strict().optional(),
  })
  .strict()
  .refine((r) => (r.verifyCmd !== undefined) !== (r.generate === true), {
    message: 'choose exactly one of verifyCmd / generate',
  });
export type StartRunRequest = z.infer<typeof StartRunRequest>;

/** `POST /api/runs/:id/gate/:gateId` — answer a parked Seal / plan-Seal. */
export const GateDecision = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('reject') }).strict(),
  z.object({ decision: z.literal('revise'), feedback: z.string().min(1) }).strict(),
]);
export type GateDecision = z.infer<typeof GateDecision>;

/**
 * `POST /api/runs/:id/resume` — continue a non-live run, optionally extending the OPERATIONAL
 * caps and steering with a note (the ADR 0012 extension mechanics, reused verbatim). The schema
 * structurally has no field for the goal / verifier / rubric — the bar is unreachable (invariant #2).
 */
export const ResumeRequest = z
  .object({
    note: z.string().min(1).optional(),
    maxIterations: z.number().int().positive().max(1000).optional(),
    budgetTokens: z.number().int().positive().optional(),
    budgetWallMs: z.number().int().positive().optional(),
    stuckNoDiff: z.boolean().optional(),
  })
  .strict();
export type ResumeRequest = z.infer<typeof ResumeRequest>;

/** `POST /api/worktrees`. */
export const WorktreeCreateRequest = z
  .object({ name: WorktreeName, base: z.string().min(1).optional() })
  .strict();
export type WorktreeCreateRequest = z.infer<typeof WorktreeCreateRequest>;

/** `DELETE /api/worktrees/:name?force=&deleteBranch=` boolean query params. */
export const BoolQueryParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** `POST /api/runs` 201 body. */
export type StartRunResponse = { runId: string };
