import type { Plan } from '../domain/plan';
import type { GateDecision } from '../domain/verdict';

/**
 * The plan gate (issue #48) — the plan-level Gate A. `--autonomous` moves ONLY this gate (and the
 * per-phase Gate A): it auto-accepts the frozen plan but still freezes + logs it loudly. A human
 * may approve, reject, or revise (bounded by `maxGateARevisions`, mirroring the contract Gate A).
 */
export interface PlanGate {
  approvePlan(plan: Plan): Promise<GateDecision>;
}
