import type { BudgetConfig } from '../domain/config';
import type { BudgetSnapshot } from '../domain/events';
import type { Clock } from './clock';

/**
 * Seam #4b. Meters token/wall-clock spend independently of iteration count. The Driver
 * `record`s each run's usage and stamps a `snapshot` into the AGENT_RAN event; the pure
 * reducer only ever reads `snapshot.exceeded`.
 */
export interface BudgetMeter {
  record(tokensUsed: number | undefined): void;
  snapshot(): BudgetSnapshot;
}

/** Real meter: wall-clock from an injected Clock, tokens accumulated from run usage. */
export class SystemBudgetMeter implements BudgetMeter {
  #tokens = 0;
  readonly #budget: BudgetConfig;
  readonly #clock: Clock;
  readonly #startedAt: number;

  constructor(budget: BudgetConfig, clock: Clock) {
    this.#budget = budget;
    this.#clock = clock;
    this.#startedAt = clock.now();
  }

  record(tokensUsed: number | undefined): void {
    if (tokensUsed !== undefined && tokensUsed > 0) this.#tokens += tokensUsed;
  }

  snapshot(): BudgetSnapshot {
    const wallClockMs = this.#clock.now() - this.#startedAt;
    const tokenCapHit = this.#budget.tokens !== undefined && this.#tokens >= this.#budget.tokens;
    const timeCapHit =
      this.#budget.wallClockMs !== undefined && wallClockMs >= this.#budget.wallClockMs;
    return {
      tokensSpent: this.#tokens,
      wallClockMs,
      exceeded: tokenCapHit || timeCapHit,
    };
  }
}
