import type {
  RunsIndex,
  RunDetailResponse,
  WorktreesResponse,
  VersionResponse,
  SseFrame,
  StartRunRequest,
  ResumeRequest,
  GateDecision,
  GateFilesResponse,
  PendingGate,
  StartRunResponse,
  WorktreeChangesResponse,
  OpenPrRequest,
  OpenPrResponse,
  PrDraftRequest,
  PrDraftResponse,
  WorkspacePrRequest,
  WorkspacePrResponse,
} from '../api-schema';
import type { WorktreeInfo } from '../../workspace/worktree-manager';

/**
 * Typed client for the goaly ui API. Types only cross this seam (`import type` — no zod, no node
 * code in the browser bundle); the server did the fail-closed parsing. Every state-changing call
 * carries `X-Goaly-Ui: 1` (the server refuses it otherwise — CSRF defense in depth).
 */

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

async function send<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      accept: 'application/json',
      'x-goaly-ui': '1',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(parsed.error ?? `${res.status} ${res.statusText}`);
  return parsed;
}

export const api = {
  version: (): Promise<VersionResponse> => getJson('/api/version'),
  runs: (): Promise<RunsIndex> => getJson('/api/runs'),
  run: (runId: string): Promise<RunDetailResponse> => getJson(`/api/runs/${encodeURIComponent(runId)}`),
  worktrees: (): Promise<WorktreesResponse> => getJson('/api/worktrees'),
  startRun: (req: StartRunRequest): Promise<StartRunResponse> => send('POST', '/api/runs', req),
  resumeRun: (runId: string, req: ResumeRequest): Promise<StartRunResponse> =>
    send('POST', `/api/runs/${encodeURIComponent(runId)}/resume`, req),
  stopRun: (runId: string): Promise<{ stopping: boolean }> =>
    send('POST', `/api/runs/${encodeURIComponent(runId)}/stop`),
  pendingGate: async (runId: string): Promise<PendingGate | null> => {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/gate`);
    if (res.status !== 200) return null;
    return (await res.json()) as PendingGate;
  },
  answerGate: (runId: string, gateId: string, decision: GateDecision): Promise<{ resolved: string }> =>
    send('POST', `/api/runs/${encodeURIComponent(runId)}/gate/${encodeURIComponent(gateId)}`, decision),
  gateFiles: async (runId: string, gateId: string): Promise<GateFilesResponse | null> => {
    const res = await fetch(
      `/api/runs/${encodeURIComponent(runId)}/gate/${encodeURIComponent(gateId)}/files`,
    );
    if (res.status !== 200) return null; // no files to review (or the gate moved on)
    return (await res.json()) as GateFilesResponse;
  },
  putGateFile: (
    runId: string,
    gateId: string,
    write: { path: string; content: string },
  ): Promise<{ written: string; sha256: string }> =>
    send('PUT', `/api/runs/${encodeURIComponent(runId)}/gate/${encodeURIComponent(gateId)}/files`, write),
  createWorktree: (name: string, base?: string): Promise<WorktreeInfo> =>
    send('POST', '/api/worktrees', { name, ...(base !== undefined && base !== '' ? { base } : {}) }),
  removeWorktree: (name: string, opts: { force?: boolean; deleteBranch?: boolean }): Promise<{ removed: string }> =>
    send(
      'DELETE',
      `/api/worktrees/${encodeURIComponent(name)}?force=${opts.force === true}&deleteBranch=${opts.deleteBranch === true}`,
    ),
  // ---- post-run landing (ADR 0017) ----
  worktreeChanges: (name: string): Promise<WorktreeChangesResponse> =>
    getJson(`/api/worktrees/${encodeURIComponent(name)}/changes`),
  commitWorktree: (name: string, message: string): Promise<{ head: string }> =>
    send('POST', `/api/worktrees/${encodeURIComponent(name)}/commit`, { message }),
  mergeWorktree: (name: string, opts: { commitMessage?: string }): Promise<{ merged: string; head: string }> =>
    send('POST', `/api/worktrees/${encodeURIComponent(name)}/merge`, opts),
  openPr: (name: string, req: OpenPrRequest): Promise<OpenPrResponse> =>
    send('POST', `/api/worktrees/${encodeURIComponent(name)}/pr`, req),
  draftPr: (name: string, req: PrDraftRequest): Promise<PrDraftResponse> =>
    send('POST', `/api/worktrees/${encodeURIComponent(name)}/pr/draft`, req),
  // ---- main-workspace landing (a run made without --worktree) ----
  workspaceChanges: (): Promise<WorktreeChangesResponse> => getJson('/api/workspace/changes'),
  commitWorkspace: (message: string): Promise<{ head: string }> =>
    send('POST', '/api/workspace/commit', { message }),
  openPrFromMain: (req: WorkspacePrRequest): Promise<WorkspacePrResponse> =>
    send('POST', '/api/workspace/pr', req),
  draftPrWorkspace: (req: PrDraftRequest): Promise<PrDraftResponse> =>
    send('POST', '/api/workspace/pr/draft', req),
};

/**
 * Subscribe to a run's live SSE feed. Returns an unsubscribe function. Frames arrive already
 * typed by event name; `terminal` closes the stream server-side (EventSource would auto-reconnect
 * and replay, so we close on it client-side too).
 */
export function subscribeRunEvents(
  runId: string,
  onFrame: (frame: SseFrame) => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  const names: SseFrame['event'][] = ['hello', 'entry', 'liveness', 'terminal', 'stream', 'gate', 'gate-resolved'];
  for (const name of names) {
    source.addEventListener(name, (raw) => {
      const data = JSON.parse((raw as MessageEvent<string>).data) as never;
      onFrame({ event: name, data } as SseFrame);
      if (name === 'terminal') source.close();
    });
  }
  source.onerror = (): void => {
    if (source.readyState === EventSource.CLOSED) onError?.();
  };
  return () => source.close();
}
