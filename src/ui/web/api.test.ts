// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, subscribeRunEvents } from './api';
import type { SseFrame } from '../api-schema';

/**
 * The browser API client, run under happy-dom with a stubbed `fetch`/`EventSource`. What matters
 * at this seam: every state-changing call carries `X-Goaly-Ui: 1`, errors surface the server's
 * `error` body, and the SSE subscription closes itself on `terminal`.
 */

type FetchCall = { url: string; init: RequestInit | undefined };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
  } as unknown as Response;
}

let calls: FetchCall[];

function stubFetch(reply: (url: string) => Response): void {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return reply(url);
    }),
  );
}

beforeEach(() => stubFetch(() => jsonResponse({})));
afterEach(() => vi.unstubAllGlobals());

describe('api GET routes', () => {
  it('version() GETs /api/version and returns the parsed body', async () => {
    stubFetch(() => jsonResponse({ name: 'goaly', version: '1.2.3' }));
    const v = await api.version();
    expect(v).toEqual({ name: 'goaly', version: '1.2.3' });
    expect(calls[0]?.url).toBe('/api/version');
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it('run() URL-encodes the run id', async () => {
    await api.run('run with space');
    expect(calls[0]?.url).toBe('/api/runs/run%20with%20space');
  });

  it('a non-ok GET throws the server error body, falling back to the status line', async () => {
    stubFetch(() => jsonResponse({ error: 'log corrupt' }, 500));
    await expect(api.runs()).rejects.toThrow('log corrupt');
    stubFetch(
      () =>
        ({
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          json: async () => {
            throw new Error('not json');
          },
        }) as unknown as Response,
    );
    await expect(api.runs()).rejects.toThrow('502 Bad Gateway');
  });
});

describe('api state-changing routes', () => {
  it('startRun POSTs with the CSRF header and a JSON body', async () => {
    stubFetch(() => jsonResponse({ runId: 'r1' }));
    const res = await api.startRun({ goal: 'g', verifyCmd: 'true', autonomous: false });
    expect(res).toEqual({ runId: 'r1' });
    const { url, init } = calls[0] ?? { url: '', init: undefined };
    expect(url).toBe('/api/runs');
    expect(init?.method).toBe('POST');
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-goaly-ui']).toBe('1');
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toMatchObject({ goal: 'g', verifyCmd: 'true' });
  });

  it('stopRun POSTs without a body and therefore without content-type', async () => {
    stubFetch(() => jsonResponse({ stopping: true }));
    await api.stopRun('r1');
    const { init } = calls[0] ?? { init: undefined };
    expect(init?.body).toBeUndefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-goaly-ui']).toBe('1');
    expect(headers['content-type']).toBeUndefined();
  });

  it('a non-ok POST throws the server error body', async () => {
    stubFetch(() => jsonResponse({ error: 'gate moved on' }, 409));
    await expect(
      api.answerGate('r1', 'g1', { decision: 'approve' }),
    ).rejects.toThrow('gate moved on');
  });

  it('removeWorktree encodes force/deleteBranch as query booleans', async () => {
    stubFetch(() => jsonResponse({ removed: 'wt' }));
    await api.removeWorktree('wt', { force: true });
    expect(calls[0]?.url).toBe('/api/worktrees/wt?force=true&deleteBranch=false');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });
});

describe('nullable gate routes', () => {
  it('pendingGate returns null on a non-200 (no parked gate)', async () => {
    stubFetch(() => jsonResponse({}, 204));
    expect(await api.pendingGate('r1')).toBeNull();
  });

  it('pendingGate returns the parked gate on 200', async () => {
    stubFetch(() => jsonResponse({ gateId: 'g1', kind: 'seal' }));
    expect(await api.pendingGate('r1')).toMatchObject({ gateId: 'g1' });
  });

  it('gateFiles returns null on a non-200 (gate moved on / nothing to review)', async () => {
    stubFetch(() => jsonResponse({}, 404));
    expect(await api.gateFiles('r1', 'g1')).toBeNull();
  });
});

describe('subscribeRunEvents', () => {
  class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    static instances: FakeEventSource[] = [];
    readonly url: string;
    readyState = FakeEventSource.OPEN;
    onerror: (() => void) | null = null;
    closed = false;
    private readonly listeners = new Map<string, (raw: MessageEvent<string>) => void>();
    constructor(url: string) {
      this.url = url;
      FakeEventSource.instances.push(this);
    }
    addEventListener(name: string, fn: (raw: MessageEvent<string>) => void): void {
      this.listeners.set(name, fn);
    }
    close(): void {
      this.closed = true;
      this.readyState = FakeEventSource.CLOSED;
    }
    emit(name: string, data: unknown): void {
      this.listeners.get(name)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }

  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('forwards typed frames and closes the stream on terminal', () => {
    const frames: SseFrame[] = [];
    subscribeRunEvents('r1', (f) => frames.push(f));
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error('no EventSource created');
    expect(source.url).toBe('/api/runs/r1/events');

    source.emit('liveness', { live: true });
    expect(frames).toEqual([{ event: 'liveness', data: { live: true } }]);
    expect(source.closed).toBe(false);

    source.emit('terminal', { stateTag: 'DONE' });
    expect(frames[1]).toEqual({ event: 'terminal', data: { stateTag: 'DONE' } });
    expect(source.closed).toBe(true);
  });

  it('invokes onError only once the source is CLOSED, and unsubscribe closes it', () => {
    const onError = vi.fn();
    const unsubscribe = subscribeRunEvents('r1', () => {}, onError);
    const source = FakeEventSource.instances[0];
    if (source === undefined) throw new Error('no EventSource created');

    source.readyState = FakeEventSource.CONNECTING; // transient reconnect — not an error yet
    source.onerror?.();
    expect(onError).not.toHaveBeenCalled();

    source.readyState = FakeEventSource.CLOSED;
    source.onerror?.();
    expect(onError).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(source.closed).toBe(true);
  });
});
