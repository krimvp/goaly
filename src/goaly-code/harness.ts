/**
 * `GoalyCodeHarness` — the FIRST non-codec {@link HarnessAdapter} (seam #1). Where a CLI harness delegates
 * the whole agent loop to a hardened binary, this adapter makes goaly itself the coding agent: it
 * drives an OpenAI-compatible endpoint through goaly's OWN tool-use loop ({@link runAgentLoop}), so we
 * own the inference path (the substrate for the trained-model arc, Slices 2–5). It is purely additive
 * behind `--harness goaly-code`; the codec harnesses are byte-for-byte unchanged.
 *
 * `run()` (spec §2.2): resolve the session (load prior history, or start `[system, user]`; a
 * corrupt/missing session degrades to fresh, logged loudly, never throws) → run the loop → persist the
 * updated history write-ahead → return a Zod-parsed {@link HarnessRunResult} with a typed status. It
 * NEVER rejects (invariant #4) — the dedicated adversarial test pass proves hostile/empty/throwing
 * inputs map to a typed status, mirroring `adapter.contract.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import type { HarnessAdapter } from '../harness/adapter';
import type { SessionId } from '../domain/ids';
import { coerceSessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { AgentEventSink } from '../agent-cli/stream';
import type { Logger } from '../log/logger';
import { errorMessage } from '../util/errors';
import type { LlmClient } from '../llm-client/openai-client';
import type { ChatMessage } from '../llm-client/schema';
import { runAgentLoop } from './loop';
import { GOALY_CODE_SYSTEM_PROMPT } from './prompt';
import { DEFAULT_TOOLS, type ToolHost, type ToolSpec } from './tools';
import type { SessionStore } from './session-store';

/** Default cap on model turns per `run()` — a hard bound so a wandering agent ends as `truncated`. */
export const DEFAULT_GOALY_CODE_MAX_TURNS = 50;

export type GoalyCodeHarnessOptions = {
  client: LlmClient;
  model: string;
  /** Path-guarded fs + sandboxed shell. Composed by the composition root; faked in tests. */
  host: ToolHost;
  sessionStore: SessionStore;
  /** Max model turns per run (default {@link DEFAULT_GOALY_CODE_MAX_TURNS}). */
  maxTurns?: number;
  /** Wall-clock budget per run; a turn started past it ends the run as `timeout`. */
  timeoutMs?: number;
  now?: () => number;
  logger?: Logger;
  /** Override the tool set (tests); default {@link DEFAULT_TOOLS}. */
  tools?: ToolSpec[];
  /** Mint a fresh session id when none is resumed (injected in tests for determinism). */
  mintSessionId?: () => string;
};

export class GoalyCodeHarness implements HarnessAdapter {
  readonly name = 'goaly-code';
  readonly #client: LlmClient;
  readonly #model: string;
  readonly #host: ToolHost;
  readonly #store: SessionStore;
  readonly #maxTurns: number;
  readonly #timeoutMs: number | undefined;
  readonly #now: () => number;
  readonly #logger: Logger | undefined;
  readonly #tools: ToolSpec[];
  readonly #mint: () => string;

  constructor(opts: GoalyCodeHarnessOptions) {
    this.#client = opts.client;
    this.#model = opts.model;
    this.#host = opts.host;
    this.#store = opts.sessionStore;
    this.#maxTurns = opts.maxTurns ?? DEFAULT_GOALY_CODE_MAX_TURNS;
    this.#timeoutMs = opts.timeoutMs;
    this.#now = opts.now ?? (() => Date.now());
    this.#logger = opts.logger;
    this.#tools = opts.tools ?? DEFAULT_TOOLS;
    this.#mint = opts.mintSessionId ?? (() => `goaly-code-${randomUUID()}`);
  }

  async run(prompt: string, sessionId?: SessionId, onEvent?: AgentEventSink): Promise<HarnessRunResult> {
    const id: SessionId = sessionId ?? coerceSessionId(this.#mint(), 'goaly-code-unknown');
    const messages = await this.#resolveSession(sessionId, prompt);

    const deadlineMs = this.#timeoutMs !== undefined ? this.#now() + this.#timeoutMs : undefined;
    let loop;
    try {
      loop = await runAgentLoop({
        client: this.#client,
        model: this.#model,
        tools: this.#tools,
        host: this.#host,
        messages,
        maxTurns: this.#maxTurns,
        now: this.#now,
        ...(deadlineMs !== undefined ? { deadlineMs } : {}),
        ...(onEvent !== undefined ? { onEvent } : {}),
      });
    } catch (e) {
      // The loop is designed never to throw; fail closed if it ever does (invariant #4).
      return HarnessRunResult.parse({ output: errorMessage(e), sessionId: id, status: 'crashed' });
    }

    await this.#persist(id, loop.messages);

    // Build the result; if any token field is somehow unparseable (defense-in-depth — the wire seam
    // already drops non-finite usage), degrade to a token-less result rather than reject. The adapter
    // must NEVER throw out of run() (invariant #4), even on a future accounting bug.
    const full = HarnessRunResult.safeParse({
      output: loop.output,
      sessionId: id,
      status: loop.status,
      ...(loop.tokens.tokensUsed !== undefined ? { tokensUsed: loop.tokens.tokensUsed } : {}),
      ...(loop.tokens.tokenSource !== undefined ? { tokenSource: loop.tokens.tokenSource } : {}),
      ...(loop.tokens.tokenBreakdown !== undefined ? { tokenBreakdown: loop.tokens.tokenBreakdown } : {}),
    });
    if (full.success) return full.data;
    this.#logger?.warn('goaly-code dropped an unparseable token count from the run result', {
      sessionId: id,
    });
    return HarnessRunResult.parse({ output: loop.output, sessionId: id, status: loop.status });
  }

  /** Load prior history for a resumed session, or start fresh `[system, user]`. Never throws. */
  async #resolveSession(sessionId: SessionId | undefined, prompt: string): Promise<ChatMessage[]> {
    if (sessionId !== undefined) {
      const prior = await this.#safeLoad(sessionId);
      if (prior !== null && prior.length > 0) {
        return [...prior, { role: 'user', content: prompt }];
      }
      this.#logger?.warn('goaly-code session missing/unreadable — starting a fresh session', {
        sessionId,
      });
    }
    return [
      { role: 'system', content: GOALY_CODE_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ];
  }

  async #safeLoad(id: SessionId): Promise<ChatMessage[] | null> {
    try {
      return await this.#store.load(id);
    } catch {
      return null; // a throwing store degrades to a fresh session (fail-closed)
    }
  }

  /** Persist write-ahead before returning (invariant #7); a persist failure degrades to "no resume". */
  async #persist(id: SessionId, messages: ChatMessage[]): Promise<void> {
    try {
      await this.#store.save(id, messages);
    } catch (e) {
      this.#logger?.warn('goaly-code session persist failed — resume may restart this session fresh', {
        sessionId: id,
        detail: errorMessage(e),
      });
    }
  }
}
