import { z } from 'zod';
import type { RunDetail, RunSummary } from '../runlog/inspect';
import { WorktreeName, type WorktreeInfo } from '../workspace/worktree-manager';
import type { WorktreeChanges } from '../workspace/landing';
import type { RunLogEntry, RunLogHeader } from '../runlog/runlog';
import type { StreamTranscriptEntry } from '../runlog/stream-transcript';
import type { CompiledContract } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';
import { SealEditPatch } from '../domain/verdict';

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

/**
 * `POST /api/runs/:id/gate/:gateId` — answer a parked Seal / plan-Seal. `edited` (ADR 0016)
 * triggers the manual-edit refreeze: authored files are re-read from disk (the operator's edits —
 * saved from the review station or made in their own editor), the optional field `patch` is
 * applied, and a NEW frozen contract is re-presented under a fresh gateId. Seal gates only —
 * a plan gate refuses it (400).
 */
export const GateDecision = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approve') }).strict(),
  z.object({ decision: z.literal('reject') }).strict(),
  z.object({ decision: z.literal('revise'), feedback: z.string().min(1) }).strict(),
  z.object({ decision: z.literal('edited'), patch: SealEditPatch.optional() }).strict(),
]);
export type GateDecision = z.infer<typeof GateDecision>;

/**
 * `GET /api/runs/:id/gate/:gateId/files` — the review station's artifact contents: one entry per
 * generated file the PARKED contract pins. `dirty` compares the full-content on-disk hash to the
 * frozen pin (truncation never lies about dirtiness); a missing/unreadable/out-of-root file is
 * `sha256OnDisk: null` (rendered fail-closed as missing).
 */
export type GateFileEntry = {
  path: string;
  frozenSha256: string;
  sha256OnDisk: string | null;
  content: string | null;
  truncated: boolean;
  dirty: boolean;
};
export type GateFilesResponse = { gateId: string; files: GateFileEntry[] };

/**
 * `PUT /api/runs/:id/gate/:gateId/files` — save one in-UI file edit. The path must be strictly
 * one of the parked contract's `generatedFiles` paths (allowlisted server-side); the write goes
 * through the same guarded, git-excluding writer the compiler uses. Writing never refreezes by
 * itself — the client answers the gate with `edited` when review should re-run.
 */
export const GateFileWrite = z
  .object({ path: z.string().min(1), content: z.string().max(500_000) })
  .strict();
export type GateFileWrite = z.infer<typeof GateFileWrite>;

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

// ---- post-run landing (ADR 0017) -------------------------------------------

/** `GET /api/worktrees/:name/changes` — the read-only landing projection (see `LandingManager`). */
export type WorktreeChangesResponse = WorktreeChanges;

/** `POST /api/worktrees/:name/commit` — commit the worktree's changes onto its branch. */
export const CommitRequest = z.object({ message: z.string().min(1).max(10_000) }).strict();
export type CommitRequest = z.infer<typeof CommitRequest>;

/** `POST /api/worktrees/:name/merge` — merge the branch into main; optional commit-if-dirty message. */
export const MergeRequest = z
  .object({ commitMessage: z.string().min(1).max(10_000).optional() })
  .strict();
export type MergeRequest = z.infer<typeof MergeRequest>;

/** `POST /api/worktrees/:name/pr` — commit-if-dirty, push, then `gh pr create`. */
export const OpenPrRequest = z
  .object({
    title: z.string().min(1).max(1_000),
    body: z.string().max(50_000).optional(),
    base: z.string().min(1).max(255).optional(),
    commitMessage: z.string().min(1).max(10_000).optional(),
  })
  .strict();
export type OpenPrRequest = z.infer<typeof OpenPrRequest>;

/** `POST /api/worktrees/:name/pr` 200 body. */
export type OpenPrResponse = { url: string };

/**
 * `POST /api/worktrees/:name/pr/draft` — the agent drafts a PR title + body from the worktree diff
 * (the "agent fills in the MR" step). `goal` gives the model context (the run's goal); `harness`
 * picks which CLI backs the completion (defaults to `claude`). Both optional, `.strict()`.
 */
export const PrDraftRequest = z
  .object({
    goal: z.string().max(100_000).optional(),
    harness: z.enum(['claude', 'codex', 'droid', 'pi', 'goaly-code', 'fake']).optional(),
  })
  .strict();
export type PrDraftRequest = z.infer<typeof PrDraftRequest>;

/** `POST /api/worktrees/:name/pr/draft` 200 body — pre-fills the Open PR form for review. */
export type PrDraftResponse = { title: string; body: string };

// ---- main-workspace landing (ADR 0017) -------------------------------------
// A run made WITHOUT --worktree lands in the main workspace on its checked-out branch. `changes`
// and `commit` reuse the worktree shapes (GET /api/workspace/changes, POST /api/workspace/commit
// with CommitRequest); a PR must first EJECT the work onto a fresh goaly/<name> branch.

/**
 * `POST /api/workspace/pr` — eject the main workspace's uncommitted changes onto a new
 * `goaly/<name>` branch, push, open the PR, and return the workspace to its original branch.
 */
export const WorkspacePrRequest = z
  .object({
    name: WorktreeName,
    title: z.string().min(1).max(1_000),
    body: z.string().max(50_000).optional(),
    base: z.string().min(1).max(255).optional(),
    commitMessage: z.string().min(1).max(10_000).optional(),
  })
  .strict();
export type WorkspacePrRequest = z.infer<typeof WorkspacePrRequest>;

/** `POST /api/workspace/pr` 200 body — the PR URL and the branch the work was ejected onto. */
export type WorkspacePrResponse = { url: string; branch: string };

/** `DELETE /api/worktrees/:name?force=&deleteBranch=` boolean query params. */
export const BoolQueryParam = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** `POST /api/runs` 201 body. */
export type StartRunResponse = { runId: string };
