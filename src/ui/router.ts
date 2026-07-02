import { join } from 'node:path';
import { listRuns as realListRuns, readRun as realReadRun } from '../runlog/inspect';
import type { RunReadResult, RunListItem } from '../runlog/inspect';
import { runLockActive } from '../runlog/lock';
import { WorktreeManager, type WorktreeInfo } from '../workspace/worktree-manager';
import { enumerateRoots, type RunRoot } from './roots';
import {
  RunIdParam,
  AfterParam,
  type ApiRunListItem,
  type RunsIndex,
  type RunDetailResponse,
  type TranscriptResponse,
  type VersionResponse,
} from './api-schema';
import { readStreamTranscript } from '../runlog/stream-transcript';

/**
 * The `goaly ui` API router: pure-ish dispatch (no sockets) so every route is testable with plain
 * calls. Reads go through the SAME projections `goaly runs list/show` use (`listRuns`/`readRun` —
 * pure replay of the write-ahead log), so the browser can never see a state the CLI wouldn't.
 * Corrupt runs are FLAGGED in responses, never dropped (invariant #6); every path/query param is
 * Zod-parsed fail-closed.
 */

export type RouterCtx = {
  workspaceRoot: string;
  version: VersionResponse;
  /** Injected read seams (tests). Defaults: the real inspection projections. */
  inspect?: {
    listRuns: typeof realListRuns;
    readRun: typeof realReadRun;
  };
  /** Injected run-liveness probe (tests). Default: the run.lock pid check. */
  isActive?: (runDir: string) => Promise<boolean>;
  /** Injected worktree enumeration (tests). Default: the real WorktreeManager. */
  listWorktrees?: () => Promise<WorktreeInfo[]>;
  /** Injected transcript reader (tests). */
  readTranscript?: typeof readStreamTranscript;
};

/** What the HTTP layer should do with a request the router understood. */
export type ApiResponse =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'empty'; status: number }
  /** An SSE tail on this run directory — the HTTP layer owns the long-lived stream. */
  | { kind: 'sse'; runDir: string; runId: string }
  /** Not an API route: fall through to static assets. */
  | { kind: 'static' };

export async function route(ctx: RouterCtx, method: string, pathname: string, query: URLSearchParams): Promise<ApiResponse> {
  if (!pathname.startsWith('/api/')) return { kind: 'static' };
  if (method !== 'GET') return { kind: 'json', status: 405, body: { error: 'method not allowed' } };

  if (pathname === '/api/version') return { kind: 'json', status: 200, body: ctx.version };
  if (pathname === '/api/runs') return runsIndex(ctx);
  if (pathname === '/api/worktrees') return worktrees(ctx);

  const runMatch = /^\/api\/runs\/([^/]+)(\/events|\/transcript)?$/.exec(pathname);
  if (runMatch !== null) {
    const idParse = RunIdParam.safeParse(decodeURIComponent(runMatch[1] ?? ''));
    if (!idParse.success) {
      return { kind: 'json', status: 400, body: { error: 'invalid run id' } };
    }
    const runId = idParse.data;
    if (runMatch[2] === '/events') return events(ctx, runId);
    if (runMatch[2] === '/transcript') return transcript(ctx, runId, query);
    return runDetail(ctx, runId);
  }

  return { kind: 'json', status: 404, body: { error: 'unknown API route' } };
}

async function roots(ctx: RouterCtx): Promise<RunRoot[]> {
  return enumerateRoots(
    ctx.workspaceRoot,
    ctx.listWorktrees ?? (() => new WorktreeManager({ root: ctx.workspaceRoot }).list()),
  );
}

async function runsIndex(ctx: RouterCtx): Promise<ApiResponse> {
  const listRuns = ctx.inspect?.listRuns ?? realListRuns;
  const isActive = ctx.isActive ?? runLockActive;
  const body: RunsIndex = { roots: [] };
  for (const root of await roots(ctx)) {
    const items = await listRuns(root.stateDir);
    const runs: ApiRunListItem[] = await Promise.all(
      items.map(async (item: RunListItem) =>
        item.ok
          ? { ok: true as const, summary: item.summary, live: await isActive(join(root.stateDir, item.summary.runId)) }
          : { ok: false as const, runId: item.runId, error: item.error },
      ),
    );
    body.roots.push({ root: root.ref, runs });
  }
  return { kind: 'json', status: 200, body };
}

async function worktrees(ctx: RouterCtx): Promise<ApiResponse> {
  try {
    const list = ctx.listWorktrees ?? (() => new WorktreeManager({ root: ctx.workspaceRoot }).list());
    return { kind: 'json', status: 200, body: { worktrees: await list() } };
  } catch {
    return { kind: 'json', status: 200, body: { worktrees: [] } }; // not a git repo — nothing to list
  }
}

/** Find which root holds this run. Returns the first root whose state dir has it. */
async function findRun(
  ctx: RouterCtx,
  runId: string,
): Promise<{ root: RunRoot; result: RunReadResult } | null> {
  const readRun = ctx.inspect?.readRun ?? realReadRun;
  for (const root of await roots(ctx)) {
    const result = await readRun(root.stateDir, runId);
    if (result !== null) return { root, result };
  }
  return null;
}

async function runDetail(ctx: RouterCtx, runId: string): Promise<ApiResponse> {
  const found = await findRun(ctx, runId);
  if (found === null) return { kind: 'json', status: 404, body: { error: `no such run: ${runId}` } };
  if (!found.result.ok) {
    // Corrupt is FLAGGED, never dropped: a distinct status + the parse error (invariant #6).
    return { kind: 'json', status: 409, body: { error: `run ${runId} is corrupt: ${found.result.error}` } };
  }
  const isActive = ctx.isActive ?? runLockActive;
  const body: RunDetailResponse = {
    root: found.root.ref,
    live: await isActive(join(found.root.stateDir, runId)),
    detail: found.result.detail,
  };
  return { kind: 'json', status: 200, body };
}

async function events(ctx: RouterCtx, runId: string): Promise<ApiResponse> {
  const found = await findRun(ctx, runId);
  if (found === null) return { kind: 'json', status: 404, body: { error: `no such run: ${runId}` } };
  return { kind: 'sse', runDir: join(found.root.stateDir, runId), runId };
}

async function transcript(ctx: RouterCtx, runId: string, query: URLSearchParams): Promise<ApiResponse> {
  const afterParse = AfterParam.safeParse(query.get('after') ?? undefined);
  if (!afterParse.success) return { kind: 'json', status: 400, body: { error: 'invalid ?after' } };
  const found = await findRun(ctx, runId);
  if (found === null) return { kind: 'json', status: 404, body: { error: `no such run: ${runId}` } };
  const read = ctx.readTranscript ?? readStreamTranscript;
  const entries = await read(found.root.stateDir, runId);
  if (entries === null) return { kind: 'empty', status: 204 }; // no transcript recorded (opt-in)
  const body: TranscriptResponse = { entries: entries.slice(afterParse.data), total: entries.length };
  return { kind: 'json', status: 200, body };
}
