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
  /**
   * Resume this provider session (AUTHORING continuity only — the compiler/planner revise loops
   * resuming their OWN prior authoring turn so a revision is a small delta instead of a full
   * re-send). A caller may only send a delta prompt after checking {@link LlmProvider.supportsResume}
   * — a provider without sessions ignores this field, and a delta prompt to an amnesiac model would
   * be meaningless. NEVER used by the verification panels (judge/approver/refuters): their votes
   * must be independent, and resuming a sibling's session would let reviewer N see reviewer N-1's
   * verdict — fresh sessions there are a security property.
   */
  resumeSessionId?: string;
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
  /**
   * The provider session this completion belongs to, when the transport has resumable sessions
   * (the agent-CLI provider reads it off the CLI's structured output). A caller that wants
   * authoring continuity stores it and passes it back as {@link LlmRequest.resumeSessionId}.
   */
  sessionId?: string;
};

export interface LlmProvider {
  readonly name: string;
  /**
   * True when the transport can resume a prior session via {@link LlmRequest.resumeSessionId}
   * (capability-gated per agent-CLI codec; the direct HTTP providers have no sessions). Callers
   * MUST check this before sending a resume-shaped delta prompt.
   */
  readonly supportsResume?: boolean;
  complete(req: LlmRequest): Promise<LlmCompletion>;
}

/**
 * Scripted provider for tests. Cycles through canned responses; repeats the last one. A response
 * may be a bare string (text only, tokens unknown) or a full {@link LlmCompletion} when a test
 * wants to script token usage.
 */
export class FakeLlm implements LlmProvider {
  readonly name = 'fake-llm';
  /** Default false so existing scripted tests keep the no-session, full-prompt behavior. */
  readonly supportsResume: boolean;
  #i = 0;
  readonly #responses: (string | LlmCompletion)[];
  readonly requests: LlmRequest[] = [];
  constructor(responses: (string | LlmCompletion)[], opts?: { supportsResume?: boolean }) {
    this.#responses = responses;
    this.supportsResume = opts?.supportsResume ?? false;
  }
  async complete(req: LlmRequest): Promise<LlmCompletion> {
    this.requests.push(req);
    const r = this.#responses[this.#i] ?? this.#responses[this.#responses.length - 1];
    this.#i += 1;
    if (r === undefined) throw new Error('FakeLlm has no responses scripted');
    return typeof r === 'string' ? { text: r } : r;
  }
}
