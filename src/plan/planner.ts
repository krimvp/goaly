import type { RunConfig } from '../domain/config';
import type { PhasePlan } from '../domain/plan';

/**
 * The planner seam (issue #48) — a READ-ONLY LLM step, like the {@link VerifierCompiler}. It turns one
 * big goal into a FROZEN, ordered plan of sub-goals (`PhasePlan`, its `planHash` set), parsed
 * fail-closed. It never edits the working tree (planning is authoring, not building) and never weakens
 * a bar — the freeze + the bounded, gated revise path keep re-planning honest. May throw; the Driver
 * turns a thrown error into a typed, fail-closed `PLAN_FAILED` event.
 *
 * `feedback` carries the human's free-text note from a plan-Seal "revise" round: when present, an
 * authoring planner should re-author the plan steered by it. Each attempt is frozen + logged on its
 * own; only the approved plan drives the phase loop.
 */
export interface Planner {
  plan(config: RunConfig, feedback?: string): Promise<PhasePlan>;
}
