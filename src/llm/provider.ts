import type { TokenBreakdown } from '../domain/usage';

/**
 * An INTERNAL seam — deliberately NOT one of the four real seams. The LLM provider varies
 * *inside* the judge/approver/compiler, not across the Verifier/Approver interfaces, so it
 * never leaks through them (ARCHITECTURE: "don't leak internal seams through the interface").
 */
export type LlmRequest = {
  system?: string;
  prompt: string;
  /** Default 0 — judging/approval must be as stable as possible. */
  temperature?: number;
};

/**
 * One completion. `tokensUsed` is the total tokens the provider reports for this call; it is
 * OPTIONAL because not every CLI surfaces usage, and a missing count must degrade to "unknown"
 * in the per-run report rather than be mistaken for zero (the Driver meters these for issue #17).
 */
export type LlmCompletion = {
  text: string;
  tokensUsed?: number;
  /**
   * Whether `tokensUsed` is the provider's own `reported` count or a local `estimated` fallback
   * (issue #24), counted from the streamed turns when the CLI emits no usage. Absent when
   * `tokensUsed` is absent. A bare-string scripted {@link FakeLlm} response leaves it unset
   * (treated as reported/unknown), so existing token-metering behavior is unchanged.
   */
  tokenSource?: 'reported' | 'estimated';
  /**
   * Per-category split of `tokensUsed` (input/output/cache-read/cache-write) when the provider
   * reports one. Present only for a `reported` count; lets the cost overlay price per category.
   */
  tokenBreakdown?: TokenBreakdown;
};

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmCompletion>;
}

/**
 * Scripted provider for tests. Cycles through canned responses; repeats the last one. A response
 * may be a bare string (text only, tokens unknown) or a full {@link LlmCompletion} when a test
 * wants to script token usage.
 */
export class FakeLlm implements LlmProvider {
  readonly name = 'fake-llm';
  #i = 0;
  readonly #responses: (string | LlmCompletion)[];
  readonly requests: LlmRequest[] = [];
  constructor(responses: (string | LlmCompletion)[]) {
    this.#responses = responses;
  }
  async complete(req: LlmRequest): Promise<LlmCompletion> {
    this.requests.push(req);
    const r = this.#responses[this.#i] ?? this.#responses[this.#responses.length - 1];
    this.#i += 1;
    if (r === undefined) throw new Error('FakeLlm has no responses scripted');
    return typeof r === 'string' ? { text: r } : r;
  }
}
