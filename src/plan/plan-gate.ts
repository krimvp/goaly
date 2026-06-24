import type { PhasePlan } from '../domain/plan';
import type { SealDecision } from '../domain/verdict';

/**
 * The plan Seal gate (Gate A on the plan, issue #48) — the plan-level analogue of the {@link SealGate}.
 * `--autonomous` moves ONLY this pause:
 *  - default: a human approves / rejects / revises the frozen plan once before the phase loop starts.
 *  - autonomous: auto-accept, but persist the full plan to the run log LOUDLY.
 *
 * Autonomous skips the human *pause*, never the *freeze*. Reuses {@link SealDecision} (approve / reject
 * / revise) so the reducer drives both Seals the same way.
 */
export interface PlanGate {
  approvePlan(plan: PhasePlan): Promise<SealDecision>;
}
