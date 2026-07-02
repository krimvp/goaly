import type {
  RunsIndex,
  RunDetailResponse,
  WorktreesResponse,
  VersionResponse,
  SseFrame,
} from '../api-schema';

/**
 * Typed client for the goaly ui API. Types only cross this seam (`import type` — no zod, no node
 * code in the browser bundle); the server did the fail-closed parsing.
 */

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  version: (): Promise<VersionResponse> => getJson('/api/version'),
  runs: (): Promise<RunsIndex> => getJson('/api/runs'),
  run: (runId: string): Promise<RunDetailResponse> => getJson(`/api/runs/${encodeURIComponent(runId)}`),
  worktrees: (): Promise<WorktreesResponse> => getJson('/api/worktrees'),
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
  const names: SseFrame['event'][] = ['hello', 'entry', 'liveness', 'terminal', 'stream'];
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
