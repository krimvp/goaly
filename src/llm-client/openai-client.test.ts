import { describe, it, expect } from 'vitest';
import { OpenAiClient, LlmClientError, type FetchLike } from './openai-client';
import type { ChatRequest } from './schema';

/** A scripted fetch: each call shifts the next canned outcome (a response or a thrown network error). */
type Canned =
  | { kind: 'res'; status: number; body: unknown | string; headers?: Record<string, string> }
  | { kind: 'throw'; error: string };

function fakeFetch(script: Canned[]): { fetch: FetchLike; calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> } {
  const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const c = script[Math.min(i, script.length - 1)];
    i += 1;
    if (c === undefined) throw new Error('no canned response');
    if (c.kind === 'throw') throw new Error(c.error);
    const text = typeof c.body === 'string' ? c.body : JSON.stringify(c.body);
    const headers = { get: (name: string) => c.headers?.[name.toLowerCase()] ?? null };
    return { ok: c.status >= 200 && c.status < 300, status: c.status, text: async () => text, headers };
  };
  return { fetch, calls };
}

const REQ: ChatRequest = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };

const okBody = (overrides: Record<string, unknown> = {}) => ({
  choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  ...overrides,
});

function client(fetch: FetchLike): OpenAiClient {
  return new OpenAiClient({ baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test', fetch, sleep: async () => {} });
}

describe('OpenAiClient', () => {
  it('posts to <baseUrl>/chat/completions with a bearer header and returns the normalized result', async () => {
    const { fetch, calls } = fakeFetch([{ kind: 'res', status: 200, body: okBody() }]);
    const result = await client(fetch).chat(REQ);
    expect(calls[0]!.url).toBe('https://api.example.com/v1/chat/completions');
    expect(calls[0]!.init.headers['authorization']).toBe('Bearer sk-test');
    expect(calls[0]!.init.method).toBe('POST');
    expect(result.content).toBe('hello');
    expect(result.finishReason).toBe('stop');
    expect(result.usage?.total).toBe(15);
    expect(result.usage?.breakdown).toEqual({ input: 10, output: 5 });
  });

  it('omits the Authorization header when no api key is given (keyless local endpoints)', async () => {
    const { fetch, calls } = fakeFetch([{ kind: 'res', status: 200, body: okBody() }]);
    await new OpenAiClient({ baseUrl: 'http://localhost:11434/v1', fetch, sleep: async () => {} }).chat(REQ);
    expect(calls[0]!.init.headers['authorization']).toBeUndefined();
  });

  it('strips a trailing slash from the base url', async () => {
    const { fetch, calls } = fakeFetch([{ kind: 'res', status: 200, body: okBody() }]);
    await new OpenAiClient({ baseUrl: 'https://x.test/v1/', fetch, sleep: async () => {} }).chat(REQ);
    expect(calls[0]!.url).toBe('https://x.test/v1/chat/completions');
  });

  it('mints ids for tool calls that omit one, and defaults empty arguments', async () => {
    const body = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ function: { name: 'finish' } }, { function: { name: 'read_file', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    };
    const { fetch } = fakeFetch([{ kind: 'res', status: 200, body }]);
    const result = await client(fetch).chat(REQ);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]).toEqual({ id: 'call_0', type: 'function', function: { name: 'finish', arguments: '' } });
    expect(result.toolCalls[1]!.function.name).toBe('read_file');
  });

  it('retries on a 429 then succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      { kind: 'res', status: 429, body: 'rate limited' },
      { kind: 'res', status: 200, body: okBody() },
    ]);
    const result = await client(fetch).chat(REQ);
    expect(result.content).toBe('hello');
    expect(calls).toHaveLength(2);
  });

  it('retries on a 500 then succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      { kind: 'res', status: 503, body: 'unavailable' },
      { kind: 'res', status: 200, body: okBody() },
    ]);
    await client(fetch).chat(REQ);
    expect(calls).toHaveLength(2);
  });

  it('backs off exponentially between attempts', async () => {
    const slept: number[] = [];
    const { fetch } = fakeFetch([
      { kind: 'res', status: 503, body: 'down' },
      { kind: 'res', status: 503, body: 'down' },
      { kind: 'res', status: 200, body: okBody() },
    ]);
    const c = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      fetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await c.chat(REQ);
    expect(slept).toEqual([500, 1000]);
  });

  it('honors a Retry-After header on 429 when longer than the base backoff (capped)', async () => {
    const slept: number[] = [];
    const { fetch } = fakeFetch([
      { kind: 'res', status: 429, body: 'rate limited', headers: { 'retry-after': '7' } },
      { kind: 'res', status: 200, body: okBody() },
    ]);
    const c = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      fetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await c.chat(REQ);
    expect(slept).toEqual([7000]);
  });

  it('caps an absurd Retry-After and ignores a garbage one', async () => {
    const slept: number[] = [];
    const { fetch } = fakeFetch([
      { kind: 'res', status: 429, body: 'x', headers: { 'retry-after': '99999' } },
      { kind: 'res', status: 429, body: 'x', headers: { 'retry-after': 'Wed, 21 Oct 2026' } },
      { kind: 'res', status: 200, body: okBody() },
    ]);
    const c = new OpenAiClient({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k',
      fetch,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await c.chat(REQ);
    expect(slept).toEqual([60_000, 1000]); // capped at 60s; then garbage → base exponential backoff
  });

  it('retries on a thrown network error then succeeds', async () => {
    const { fetch, calls } = fakeFetch([
      { kind: 'throw', error: 'ECONNRESET' },
      { kind: 'res', status: 200, body: okBody() },
    ]);
    await client(fetch).chat(REQ);
    expect(calls).toHaveLength(2);
  });

  it('does NOT retry a 401 — fails closed immediately with the status', async () => {
    const { fetch, calls } = fakeFetch([{ kind: 'res', status: 401, body: 'bad key' }]);
    await expect(client(fetch).chat(REQ)).rejects.toMatchObject({ status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('fails closed after exhausting retries on persistent 500s', async () => {
    const { fetch, calls } = fakeFetch([{ kind: 'res', status: 500, body: 'boom' }]);
    await expect(client(fetch).chat(REQ)).rejects.toBeInstanceOf(LlmClientError);
    expect(calls).toHaveLength(3); // default 2 retries → 3 attempts
  });

  it('fails closed (no retry) on a non-JSON body', async () => {
    const { fetch, calls } = fakeFetch([{ kind: 'res', status: 200, body: 'not json <<<' }]);
    await expect(client(fetch).chat(REQ)).rejects.toThrow(/not JSON/);
    expect(calls).toHaveLength(1);
  });

  it('fails closed (no retry) on a schema-invalid body (empty choices)', async () => {
    const { fetch, calls } = fakeFetch([{ kind: 'res', status: 200, body: { choices: [] } }]);
    await expect(client(fetch).chat(REQ)).rejects.toThrow(/schema/);
    expect(calls).toHaveLength(1);
  });

  it('reports no usage when the body omits it', async () => {
    const { fetch } = fakeFetch([
      { kind: 'res', status: 200, body: { choices: [{ message: { content: 'x' } }] } },
    ]);
    const result = await client(fetch).chat(REQ);
    expect(result.usage).toBeUndefined();
  });

  it('drops a non-finite reported usage count (1e400 → Infinity) — never returns a non-finite total', async () => {
    // Raw JSON body so the count survives as Infinity (JSON.stringify would coerce it to null).
    const { fetch } = fakeFetch([
      { kind: 'res', status: 200, body: '{"choices":[{"message":{"content":"x"}}],"usage":{"total_tokens":1e400,"completion_tokens":5}}' },
    ]);
    const result = await client(fetch).chat(REQ);
    expect(result.content).toBe('x');
    expect(Number.isFinite(result.usage?.total ?? 0)).toBe(true); // dropped total → falls back to breakdown
  });

  it('aborts on timeout and surfaces a fail-closed error', async () => {
    // A fetch that respects the abort signal: rejects when aborted.
    const slowFetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const c = new OpenAiClient({
      baseUrl: 'https://x.test',
      fetch: slowFetch,
      sleep: async () => {},
      timeoutMs: 5,
      retries: 0,
    });
    await expect(c.chat(REQ)).rejects.toBeInstanceOf(LlmClientError);
  });
});
