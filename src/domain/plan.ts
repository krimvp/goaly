import { z } from 'zod';
import { createHash } from 'node:crypto';
import { PlanHash, asPlanHash } from './ids';
import { RunConfig, type VerifierIntent } from './config';

/**
 * One ordered sub-goal of a phased plan (issue #48). A phase is executed as its OWN normal
 * frozen-contract run scoped to `goal`: the compiler authors verification for it (steered by
 * the optional `intent`), and `rubric` seeds the LLM-judge / Gate-B criteria for that phase.
 */
export const SubGoal = z.object({
  goal: z.string().min(1),
  /** Free-form guidance for authoring this phase's verification (like `--intent`). */
  intent: z.string().optional(),
  /** Frozen judging criteria for this phase's judge rung / approver. */
  rubric: z.string().optional(),
});
export type SubGoal = z.infer<typeof SubGoal>;

/**
 * The compiled, FROZEN plan: an ordered list of sub-goals plus its `planHash`. Authored once in the
 * planning phase, approved at the plan gate, then NEVER rewritten — the plan-level analogue of the
 * frozen success contract (invariant #2). The hash is logged so an audit can prove the decomposition
 * the run executed is exactly the one that was approved; re-planning is only the bounded, gated revise
 * path, and each attempt freezes its own hash.
 */
export const Plan = z.object({
  /** Ordered phases, executed front-to-back. At least one. */
  phases: z.array(SubGoal).min(1),
  planHash: PlanHash,
});
export type Plan = z.infer<typeof Plan>;

/** The plan minus its hash — what the planner produces before freezing. */
export type UnhashedPlan = Omit<z.input<typeof Plan>, 'planHash'>;

/**
 * Canonical, stable serialization of a plan's semantic content (the ordered sub-goals), excluding
 * the hash itself. Pure and deterministic: key order is fixed here, never left to `JSON.stringify`'s
 * insertion order. The order of phases is significant (it IS the plan) and is preserved.
 */
export function canonicalPlanString(p: UnhashedPlan): string {
  const phases = p.phases.map((s) => ({
    goal: s.goal,
    intent: s.intent ?? null,
    rubric: s.rubric ?? null,
  }));
  return JSON.stringify({ phases });
}

/** Deterministic content hash of a plan's frozen, decomposition-defining content. */
export function hashPlan(p: UnhashedPlan): PlanHash {
  return asPlanHash(createHash('sha256').update(canonicalPlanString(p)).digest('hex'));
}

/**
 * Freeze an unhashed plan: compute its hash and parse the whole thing through the schema so what
 * leaves here is guaranteed valid and immutable in shape (mirrors `freezeContract`).
 */
export function freezePlan(p: UnhashedPlan): Plan {
  return Plan.parse({ ...p, planHash: hashPlan(p) });
}

/**
 * Derive the per-phase `RunConfig` for phase `phaseIndex` of `plan`, from the original `base` config.
 * PURE — the reducer calls this to scope each phase to its sub-goal; no IO. A phase index past the
 * last sub-goal is the FINAL CUMULATIVE ACCEPTANCE phase: it runs the ORIGINAL goal + the user's
 * original verifier unchanged (prefer a deterministic full-suite/build rung — it runs on the whole
 * tree, is ungameable, and costs no prompt size). A sub-goal phase re-authors its own verification
 * via `--generate` steered by the sub-goal's `intent`, and adopts the sub-goal's `rubric`.
 */
export function phaseConfig(base: RunConfig, plan: Plan, phaseIndex: number): RunConfig {
  // Acceptance phase: the cumulative contract on the ORIGINAL goal + verifier, unchanged.
  if (phaseIndex >= plan.phases.length) return base;

  const sub = plan.phases[phaseIndex];
  if (sub === undefined) return base; // unreachable (index < length), keeps the type total
  const verifier: VerifierIntent = {
    kind: 'generate',
    ...(sub.intent !== undefined ? { intent: sub.intent } : {}),
  };
  // Drop the base rubric so a phase without its own rubric carries none (exactOptionalPropertyTypes).
  const { rubric: _baseRubric, ...rest } = base;
  return {
    ...rest,
    goal: sub.goal,
    verifier,
    ...(sub.rubric !== undefined ? { rubric: sub.rubric } : {}),
  };
}

/** True when `phaseIndex` addresses the final cumulative acceptance phase (past the last sub-goal). */
export function isAcceptancePhase(plan: Plan, phaseIndex: number): boolean {
  return phaseIndex >= plan.phases.length;
}

/** Total number of frozen contracts a phased run executes: one per sub-goal + the acceptance phase. */
export function totalPhases(plan: Plan): number {
  return plan.phases.length + 1;
}
