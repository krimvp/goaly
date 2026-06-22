import type { BudgetConfig } from '../domain/config';
import type { BudgetSnapshot } from '../domain/events';
import type { Clock } from './clock';

/**
 * Seam #4b. Meters token/wall-clock spend independently of iteration count. The Driver
 * `record`s each run's usage and stamps a `snapshot` into the AGENT_RAN event; the pure
 * reducer only ever reads `snapshot.exceeded`.
 */
export interface BudgetMeter {
  /**
   * Add one call's spend. `estimatedTokens` is the portion of `tokensUsed` that is a local estimate
   * rather than a provider self-report (issue #24) — it still counts against the cap (an estimate is
   * better than a silent zero), but is tracked so the snapshot can mark it approximate. A
   * `tokensUsed` of `undefined` is a call that reported NO usage at all (and couldn't be estimated):
   * it accumulates nothing but is counted as an "unknown" call so the snapshot marks the token cap
   * partially blind instead of silently treating the gap as zero spend. `unknownCalls` lets a
   * batched LLM step (e.g. a judge quorum where some samples reported and some didn't) report its
   * own unaccounted calls even though its summed `tokensUsed` is a number.
   */
  record(
    tokensUsed: number | undefined,
    estimatedTokens?: number,
    opts?: { unknownCalls?: number },
  ): void;
  snapshot(): BudgetSnapshot;
}

/** Real meter: wall-clock from an injected Clock, tokens accumulated from run usage. */
export class SystemBudgetMeter implements BudgetMeter {
  #tokens = 0;
  #estimated = 0;
  #unknownCalls = 0;
  readonly #budget: BudgetConfig;
  readonly #clock: Clock;
  readonly #startedAt: number;

  constructor(budget: BudgetConfig, clock: Clock) {
    this.#budget = budget;
    this.#clock = clock;
    this.#startedAt = clock.now();
  }

  record(tokensUsed: number | undefined, estimatedTokens = 0, opts?: { unknownCalls?: number }): void {
    if (tokensUsed !== undefined && tokensUsed > 0) {
      this.#tokens += tokensUsed;
      this.#estimated += Math.min(Math.max(estimatedTokens, 0), tokensUsed);
    }
    // A call that reported nothing (undefined) is itself one unknown call; a step may also report
    // additional unaccounted sub-calls. Either way the token total now understates true spend.
    const unknown = (tokensUsed === undefined ? 1 : 0) + Math.max(opts?.unknownCalls ?? 0, 0);
    this.#unknownCalls += unknown;
  }

  snapshot(): BudgetSnapshot {
    const wallClockMs = this.#clock.now() - this.#startedAt;
    const tokenCapHit = this.#budget.tokens !== undefined && this.#tokens >= this.#budget.tokens;
    const timeCapHit =
      this.#budget.wallClockMs !== undefined && wallClockMs >= this.#budget.wallClockMs;
    return {
      tokensSpent: this.#tokens,
      ...(this.#estimated > 0 ? { tokensEstimated: this.#estimated } : {}),
      ...(this.#unknownCalls > 0 ? { tokensUnknown: true } : {}),
      wallClockMs,
      exceeded: tokenCapHit || timeCapHit,
    };
  }
}
