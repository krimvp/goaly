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

  /** Record one completion's usage. An undefined count means the provider did not report tokens. */
  record(tokensUsed: number | undefined): void {
    this.#calls += 1;
    if (tokensUsed !== undefined && tokensUsed > 0) this.#tokens += tokensUsed;
    else if (tokensUsed === undefined) this.#unknownCalls += 1;
  }

  /** Read and reset the accrued spend. */
  take(): LlmDelta {
    const delta: LlmDelta = {
      tokens: this.#tokens,
      calls: this.#calls,
      unknownCalls: this.#unknownCalls,
    };
    this.#tokens = 0;
    this.#calls = 0;
    this.#unknownCalls = 0;
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
      meter.record(completion.tokensUsed);
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
  return { tokens: delta.tokens, calls: delta.calls, unknownCalls: delta.unknownCalls };
}
