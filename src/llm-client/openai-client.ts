/**
 * The shared HTTP transport for every OpenAI-compatible endpoint — the one place goaly speaks the
 * chat-completions wire protocol. BOTH the read-only {@link ../llm/openai-provider.ts} (Slice 0:
 * judge/approver/compiler) and the write-role goaly-code harness loop (Slice 1) drive their inference
 * through this client, so base-url/auth/retry/usage-parsing live once.
 *
 * Design contract:
 *   - injectable `fetch` + `sleep` so unit tests never touch the network or a real timer;
 *   - bounded retries on transient failure (network error, 429, 5xx) with linear backoff, then a
 *     fail-closed throw — never a fabricated empty completion (invariant #4);
 *   - the response is Zod-validated at the seam (invariant #6); a malformed envelope throws;
 *   - per-request wall-clock timeout via `AbortController`.
 * It returns a NORMALIZED {@link ChatResult} (minted tool-call ids, usage → `TokenBreakdown`) so the
 * provider and the loop never re-handle wire quirks.
 */

import type { TokenBreakdown } from '../domain/usage';
import { breakdownTotal } from '../domain/usage';
import { errorMessage } from '../util/errors';
import {
  ChatResponse,
  ChatToolCall,
  usageToBreakdown,
  type ChatRequest,
  type ResponseToolCall,
} from './schema';

/** Default per-request wall-clock budget. */
export const DEFAULT_LLM_HTTP_TIMEOUT_MS = 10 * 60 * 1000;
/** Default number of retries (so total attempts = retries + 1) on a transient failure. */
const DEFAULT_RETRIES = 2;
/** Exponential backoff base between attempts (500ms, 1s, 2s, …). */
const BACKOFF_MS = 500;
/** Cap on a server-requested Retry-After wait, so a hostile/buggy header can't stall the run. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Minimal `fetch` shape the client depends on — a subset of the WHATWG/undici `fetch`, so the
 * transport carries no DOM-lib dependency and a test can pass a trivial fake. The default binds
 * `globalThis.fetch` (Node ≥ 18).
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** Optional response headers (the WHATWG shape) — used to honor `Retry-After` on 429/503. */
  headers?: { get(name: string): string | null };
}>;

/** The normalized result of one chat-completions call — wire quirks already resolved. */
export type ChatResult = {
  /** Assistant text (may be null on a pure tool-calling turn). */
  content: string | null;
  /** Requested tool calls, each with a guaranteed id (minted when the server omitted one). */
  toolCalls: ChatToolCall[];
  /** The provider's own `finish_reason` (e.g. `stop`, `tool_calls`, `length`), when present. */
  finishReason: string | undefined;
  /** Reported usage as a per-category breakdown plus an all-inclusive total; absent when unreported. */
  usage: { total: number | undefined; breakdown: TokenBreakdown } | undefined;
};

/** The transport seam. A test fake implements this directly; production is {@link OpenAiClient}. */
export interface LlmClient {
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

/** Thrown (fail-closed) when a call cannot produce a usable, validated completion. */
export class LlmClientError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmClientError';
    if (status !== undefined) this.status = status;
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const defaultFetch: FetchLike = (url, init) => {
  const f = (globalThis as { fetch?: unknown }).fetch as FetchLike | undefined;
  if (f === undefined) {
    throw new LlmClientError('global fetch is unavailable; inject a fetch implementation');
  }
  return f(url, init);
};

export type OpenAiClientOptions = {
  /** Endpoint base, e.g. `https://api.openai.com/v1`. `/chat/completions` is appended. */
  baseUrl: string;
  /** Bearer token; omitted (no `Authorization` header) for keyless local endpoints (e.g. ollama). */
  apiKey?: string;
  /** Per-request wall-clock timeout. Default {@link DEFAULT_LLM_HTTP_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Retries on transient failure (network/429/5xx). Default {@link DEFAULT_RETRIES}. */
  retries?: number;
  /** Injected HTTP fetch (tests). Default binds `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Injected backoff sleep (tests pass a no-op). Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Extra headers (e.g. an org id). Merged after the defaults. */
  headers?: Record<string, string>;
};

export class OpenAiClient implements LlmClient {
  readonly name: string;
  readonly #url: string;
  readonly #apiKey: string | undefined;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #headers: Record<string, string>;

  constructor(opts: OpenAiClientOptions) {
    this.#url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.name = `openai:${opts.baseUrl.replace(/\/+$/, '')}`;
    this.#apiKey = opts.apiKey;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_LLM_HTTP_TIMEOUT_MS;
    this.#retries = opts.retries ?? DEFAULT_RETRIES;
    this.#fetch = opts.fetch ?? defaultFetch;
    this.#sleep = opts.sleep ?? realSleep;
    this.#headers = opts.headers ?? {};
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const body = JSON.stringify(req);
    let lastError = 'unknown error';
    // Exponential backoff; a server-provided Retry-After (rate-limit window) overrides the base
    // wait when LONGER, capped so a bad header can't stall the run — real 429 windows are tens of
    // seconds, which a fixed sub-second backoff would burn through pointlessly.
    let retryAfterMs: number | undefined;
    for (let attempt = 0; attempt <= this.#retries; attempt++) {
      if (attempt > 0) {
        const backoff = BACKOFF_MS * 2 ** (attempt - 1);
        await this.#sleep(Math.max(backoff, retryAfterMs ?? 0));
      }
      const outcome = await this.#attempt(body);
      if (outcome.ok) return normalize(outcome.value);
      lastError = outcome.error;
      retryAfterMs = outcome.retryAfterMs;
      if (!outcome.retriable) {
        throw new LlmClientError(outcome.error, outcome.status);
      }
    }
    throw new LlmClientError(`chat-completions failed after ${this.#retries + 1} attempts: ${lastError}`);
  }

  /** One HTTP attempt. Returns a discriminated outcome so retry policy lives in {@link chat}. */
  async #attempt(
    body: string,
  ): Promise<
    | { ok: true; value: ChatResponse }
    | { ok: false; retriable: boolean; error: string; status?: number; retryAfterMs?: number }
  > {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: this.#requestHeaders(),
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // 429 / 5xx are transient (retry); other 4xx (auth, bad request) fail closed immediately.
        const retriable = res.status === 429 || res.status >= 500;
        const retryAfterMs = parseRetryAfterMs(res.headers?.get('retry-after'));
        return {
          ok: false,
          retriable,
          status: res.status,
          error: `HTTP ${res.status}: ${text.slice(0, 500)}`,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        };
      }
      return this.#parseBody(text);
    } catch (e) {
      // Network error / abort (timeout) — transient, so retry.
      return { ok: false, retriable: true, error: errorMessage(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  #requestHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#apiKey !== undefined ? { authorization: `Bearer ${this.#apiKey}` } : {}),
      ...this.#headers,
    };
  }

  /** Parse + Zod-validate the response body. A malformed envelope is a NON-retriable fail-closed error. */
  #parseBody(
    text: string,
  ): { ok: true; value: ChatResponse } | { ok: false; retriable: false; error: string } {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, retriable: false, error: `response was not JSON: ${text.slice(0, 300)}` };
    }
    const parsed = ChatResponse.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        retriable: false,
        error: `response failed schema validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      };
    }
    return { ok: true, value: parsed.data };
  }
}

/**
 * Parse a `Retry-After` header value (delta-seconds form) into milliseconds, capped at
 * {@link MAX_RETRY_AFTER_MS}. The HTTP-date form and garbage both return undefined (base backoff
 * applies) — fail-open to the client's own policy, never a stall.
 */
function parseRetryAfterMs(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const seconds = Number.parseFloat(value.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
}

/** Normalize the first choice into a {@link ChatResult}: minted tool-call ids + usage breakdown. */
function normalize(res: ChatResponse): ChatResult {
  const choice = res.choices[0]!;
  const toolCalls = (choice.message.tool_calls ?? []).map((tc, i) => normalizeToolCall(tc, i));
  const breakdown = usageToBreakdown(res.usage);
  const explicitTotal = res.usage?.total_tokens;
  const total = explicitTotal !== undefined ? Math.trunc(explicitTotal) : breakdownTotal(breakdown);
  return {
    content: choice.message.content ?? null,
    toolCalls,
    finishReason: choice.finish_reason ?? undefined,
    usage: res.usage !== undefined ? { total, breakdown } : undefined,
  };
}

/** Turn a loose response tool-call into a strict one: mint a stable id and default empty args. */
function normalizeToolCall(tc: ResponseToolCall, index: number): ChatToolCall {
  return ChatToolCall.parse({
    id: tc.id ?? `call_${index}`,
    type: 'function',
    function: { name: tc.function.name, arguments: tc.function.arguments ?? '' },
  });
}
