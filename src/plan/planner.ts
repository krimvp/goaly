import type { RunConfig } from '../domain/config';
import type { Plan } from '../domain/plan';

/**
 * The planning seam (issue #48) — an LLM step, READ-ONLY like the verifier compiler. Turns one big
 * goal into a FROZEN, ordered plan of sub-goals. The result is frozen by the caller (its `planHash`
 * set once) — the plan-level analogue of the compile-once-then-freeze invariant. May throw; the
 * Driver turns a thrown error (or an unparseable / over-long plan) into a `PLAN_FAILED` event.
 *
 * `feedback` carries the human's free-text note from a plan-gate "revise" round: when present, the
 * planner should re-author the plan steered by it. This is pre-approval renegotiation and does not
 * weaken the freeze — each attempt is frozen and logged on its own; only the approved plan executes.
 */
export interface Planner {
  plan(config: RunConfig, feedback?: string): Promise<Plan>;
}
