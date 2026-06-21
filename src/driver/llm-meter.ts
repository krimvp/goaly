import type { LlmCompletion, LlmProvider, LlmRequest } from '../llm/provider';
import type { TokenUsage } from '../domain/usage';

/**
 * Spend accrued since the last {@link LlmTokenMeter.take}. `tokens` sums only the completions that
 * reported usage; `unknownCalls` counts the rest so a missing count degrades to "unknown" rather
 * than a silent zero.
 */
export type LlmDelta = {
  tokens: number;
  calls: number;
  unknownCalls: number;
  /** The portion of `tokens` that came from a local estimate rather than a self-report (issue #24). */
  estimatedTokens: number;
};

/**
 * Meters LLM token spend AT THE DRIVER (issue #17, invariant #1: the reducer never sees this). The
 * composition root wraps every workflow-step provider (compiler / judge / approver) with
 * {@link meterLlm} feeding ONE shared meter; because the loop is strictly sequential, the Driver
 * reads `take()` immediately after each LLM-bearing command to attribute that step's spend.
 */
export class LlmTokenMeter {
  #tokens = 0;
  #calls = 0;
  #unknownCalls = 0;
  #estimatedTokens = 0;

  /**
   * Record one completion's usage. An undefined count means the provider did not report tokens.
   * `estimatedTokens` is the portion of `tokensUsed` that is a local estimate (issue #24), so the
   * report can mark it approximate; it is clamped into `[0, tokensUsed]`.
   */
  record(tokensUsed: number | undefined, estimatedTokens = 0): void {
    this.#calls += 1;
    if (tokensUsed !== undefined && tokensUsed > 0) {
      this.#tokens += tokensUsed;
      this.#estimatedTokens += Math.min(Math.max(estimatedTokens, 0), tokensUsed);
    } else if (tokensUsed === undefined) this.#unknownCalls += 1;
  }

  /** Read and reset the accrued spend. */
  take(): LlmDelta {
    const delta: LlmDelta = {
      tokens: this.#tokens,
      calls: this.#calls,
      unknownCalls: this.#unknownCalls,
      estimatedTokens: this.#estimatedTokens,
    };
    this.#tokens = 0;
    this.#calls = 0;
    this.#unknownCalls = 0;
    this.#estimatedTokens = 0;
    return delta;
  }
}

/**
 * Decorate a provider so each completion's reported usage feeds `meter`. Transparent otherwise —
 * it returns the inner completion verbatim and never throws on its own.
 */
export function meterLlm(inner: LlmProvider, meter: LlmTokenMeter): LlmProvider {
  return {
    name: inner.name,
    async complete(req: LlmRequest): Promise<LlmCompletion> {
      const completion = await inner.complete(req);
      // A completion whose count is an estimate (issue #24) feeds the estimated portion through so
      // the per-run report can mark it approximate; a reported/absent count estimates nothing.
      const estimated =
        completion.tokenSource === 'estimated' && completion.tokensUsed !== undefined
          ? completion.tokensUsed
          : 0;
      meter.record(completion.tokensUsed, estimated);
      return completion;
    },
  };
}

/**
 * Turn a raw delta into the persisted per-event {@link TokenUsage}, or `undefined` when the step
 * made no LLM call at all (e.g. an existing-command compile, or a deterministic-only verify) — so
 * "no call" stays distinct from "a call that reported no tokens".
 */
export function deltaToUsage(delta: LlmDelta): TokenUsage | undefined {
  if (delta.calls === 0) return undefined;
  return {
    tokens: delta.tokens,
    calls: delta.calls,
    unknownCalls: delta.unknownCalls,
    ...(delta.estimatedTokens > 0 ? { estimatedTokens: delta.estimatedTokens } : {}),
  };
}
