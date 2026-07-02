import { join } from 'node:path';
import { listRuns as realListRuns, readRun as realReadRun } from '../runlog/inspect';
import type { RunReadResult, RunListItem } from '../runlog/inspect';
import { runLockActive } from '../runlog/lock';
import { WorktreeManager, type WorktreeInfo } from '../workspace/worktree-manager';
import { enumerateRoots, type RunRoot } from './roots';
import {
  RunIdParam,
  AfterParam,
  StartRunRequest,
  GateDecision,
  ResumeRequest,
  WorktreeCreateRequest,
  BoolQueryParam,
  type ApiRunListItem,
  type RunsIndex,
  type RunDetailResponse,
  type TranscriptResponse,
  type VersionResponse,
} from './api-schema';
import { readStreamTranscript } from '../runlog/stream-transcript';
import { WorktreeError } from '../workspace/worktree-manager';
import type { UiActions } from './start-run';

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
  /**
   * The interactive actions (ADR 0015): start / resume / stop / gates / worktree mutation.
   * Absent ⇒ the server is read-only and every state-changing route answers 503.
   */
  actions?: UiActions;
};

/** What the HTTP layer should do with a request the router understood. */
export type ApiResponse =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'empty'; status: number }
  /** An SSE tail on this run directory — the HTTP layer owns the long-lived stream. */
  | { kind: 'sse'; runDir: string; runId: string }
  /** Not an API route: fall through to static assets. */
  | { kind: 'static' };

export async function route(
  ctx: RouterCtx,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body?: unknown,
): Promise<ApiResponse> {
  if (!pathname.startsWith('/api/')) return { kind: 'static' };

  if (method === 'GET') {
    if (pathname === '/api/version') return { kind: 'json', status: 200, body: ctx.version };
    if (pathname === '/api/runs') return runsIndex(ctx);
    if (pathname === '/api/worktrees') return worktrees(ctx);

    const runMatch = /^\/api\/runs\/([^/]+)(\/events|\/transcript|\/gate)?$/.exec(pathname);
    if (runMatch !== null) {
      const runId = parseRunId(runMatch[1]);
      if (runId === null) return { kind: 'json', status: 400, body: { error: 'invalid run id' } };
      if (runMatch[2] === '/events') return events(ctx, runId);
      if (runMatch[2] === '/transcript') return transcript(ctx, runId, query);
      if (runMatch[2] === '/gate') return gateStatus(ctx, runId);
      return runDetail(ctx, runId);
    }
    return { kind: 'json', status: 404, body: { error: 'unknown API route' } };
  }

  // ---- state-changing routes (ADR 0015) — the HTTP layer already enforced X-Goaly-Ui + Origin.
  const actions = ctx.actions;
  if (actions === undefined) {
    return { kind: 'json', status: 503, body: { error: 'this server is read-only' } };
  }

  if (method === 'POST' && pathname === '/api/runs') return startRun(actions, body);
  if (method === 'POST' && pathname === '/api/worktrees') return createWorktree(actions, body);

  if (method === 'DELETE') {
    const wtMatch = /^\/api\/worktrees\/([^/]+)$/.exec(pathname);
    if (wtMatch !== null) return removeWorktree(actions, decodeURIComponent(wtMatch[1] ?? ''), query);
    return { kind: 'json', status: 404, body: { error: 'unknown API route' } };
  }

  if (method === 'POST') {
    const runMatch = /^\/api\/runs\/([^/]+)\/(stop|resume|gate\/([^/]+))$/.exec(pathname);
    if (runMatch !== null) {
      const runId = parseRunId(runMatch[1]);
      if (runId === null) return { kind: 'json', status: 400, body: { error: 'invalid run id' } };
      if (runMatch[2] === 'stop') return stopRun(actions, runId);
      if (runMatch[2] === 'resume') return resumeRun(actions, runId, body);
      const gateId = decodeURIComponent(runMatch[3] ?? '');
      return answerGate(actions, runId, gateId, body);
    }
    return { kind: 'json', status: 404, body: { error: 'unknown API route' } };
  }

  return { kind: 'json', status: 405, body: { error: 'method not allowed' } };
}

function parseRunId(raw: string | undefined): string | null {
  const parsed = RunIdParam.safeParse(decodeURIComponent(raw ?? ''));
  return parsed.success ? parsed.data : null;
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

// ---- interactive handlers (ADR 0015) ---------------------------------------

async function startRun(actions: UiActions, body: unknown): Promise<ApiResponse> {
  const parsed = StartRunRequest.safeParse(body);
  if (!parsed.success) {
    return { kind: 'json', status: 400, body: { error: firstIssue(parsed.error) } };
  }
  const outcome = await actions.start(parsed.data);
  return outcome.ok
    ? { kind: 'json', status: 201, body: { runId: outcome.runId } }
    : { kind: 'json', status: outcome.status, body: { error: outcome.error } };
}

async function resumeRun(actions: UiActions, runId: string, body: unknown): Promise<ApiResponse> {
  const parsed = ResumeRequest.safeParse(body ?? {});
  if (!parsed.success) {
    return { kind: 'json', status: 400, body: { error: firstIssue(parsed.error) } };
  }
  const outcome = await actions.resume(runId, parsed.data);
  return outcome.ok
    ? { kind: 'json', status: 201, body: { runId: outcome.runId } }
    : { kind: 'json', status: outcome.status, body: { error: outcome.error } };
}

function stopRun(actions: UiActions, runId: string): ApiResponse {
  if (!actions.stop(runId)) {
    return {
      kind: 'json',
      status: 404,
      body: {
        error:
          `run ${runId} is not a live UI-owned run — a terminal-owned run stops with Ctrl-C in ` +
          `its terminal, then continues with: goaly --resume ${runId}`,
      },
    };
  }
  // 202: the stop is COOPERATIVE (between steps); the SSE feed shows the ABORTED land.
  return { kind: 'json', status: 202, body: { stopping: true } };
}

function gateStatus(ctx: RouterCtx, runId: string): ApiResponse {
  const actions = ctx.actions;
  if (actions === undefined) return { kind: 'json', status: 503, body: { error: 'this server is read-only' } };
  const gate = actions.pendingGate(runId);
  if (gate === null) return { kind: 'json', status: 404, body: { error: `run ${runId} is not a live UI-owned run` } };
  if (gate === undefined) return { kind: 'empty', status: 204 };
  return { kind: 'json', status: 200, body: gate };
}

function answerGate(actions: UiActions, runId: string, gateId: string, body: unknown): ApiResponse {
  const parsed = GateDecision.safeParse(body);
  if (!parsed.success) {
    return { kind: 'json', status: 400, body: { error: firstIssue(parsed.error) } };
  }
  const result = actions.resolveGate(runId, gateId, parsed.data);
  if (result === 'no-session') {
    return { kind: 'json', status: 404, body: { error: `run ${runId} is not a live UI-owned run` } };
  }
  if (result === 'stale') {
    // A double-submit (or a decision for a superseded gate) must never answer a LATER gate.
    return { kind: 'json', status: 409, body: { error: 'that gate is no longer pending' } };
  }
  return { kind: 'json', status: 200, body: { resolved: gateId } };
}

async function createWorktree(actions: UiActions, body: unknown): Promise<ApiResponse> {
  const parsed = WorktreeCreateRequest.safeParse(body);
  if (!parsed.success) {
    return { kind: 'json', status: 400, body: { error: firstIssue(parsed.error) } };
  }
  try {
    const info = await actions.createWorktree(parsed.data.name, parsed.data.base);
    return { kind: 'json', status: 201, body: info };
  } catch (e) {
    if (e instanceof WorktreeError) return { kind: 'json', status: 422, body: { error: e.message } };
    throw e;
  }
}

async function removeWorktree(actions: UiActions, name: string, query: URLSearchParams): Promise<ApiResponse> {
  const force = parseBoolQuery(query.get('force'));
  const deleteBranch = parseBoolQuery(query.get('deleteBranch'));
  if (force === null || deleteBranch === null) {
    return { kind: 'json', status: 400, body: { error: 'invalid boolean query param' } };
  }
  try {
    await actions.removeWorktree(name, { force, deleteBranch });
    return { kind: 'json', status: 200, body: { removed: name } };
  } catch (e) {
    // The manager's refusal ladder (live run / dirty / unknown) surfaces verbatim as a 409.
    if (e instanceof WorktreeError) return { kind: 'json', status: 409, body: { error: e.message } };
    throw e;
  }
}

function parseBoolQuery(raw: string | null): boolean | null {
  if (raw === null) return false;
  const parsed = BoolQueryParam.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function firstIssue(error: { issues: Array<{ path: Array<string | number>; message: string }> }): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'invalid request';
  const at = issue.path.length > 0 ? ` (at ${issue.path.join('.')})` : '';
  return `${issue.message}${at}`;
}
