import type {
  RunsIndex,
  RunDetailResponse,
  WorktreesResponse,
  VersionResponse,
  SseFrame,
  StartRunRequest,
  ResumeRequest,
  GateDecision,
  PendingGate,
  StartRunResponse,
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

async function send<T>(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
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
  createWorktree: (name: string, base?: string): Promise<WorktreeInfo> =>
    send('POST', '/api/worktrees', { name, ...(base !== undefined && base !== '' ? { base } : {}) }),
  removeWorktree: (name: string, opts: { force?: boolean; deleteBranch?: boolean }): Promise<{ removed: string }> =>
    send(
      'DELETE',
      `/api/worktrees/${encodeURIComponent(name)}?force=${opts.force === true}&deleteBranch=${opts.deleteBranch === true}`,
    ),
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
