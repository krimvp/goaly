import { z } from 'zod';
import { PlanHash } from './ids';

/**
 * One ordered sub-goal of a phased run (issue #48). Each sub-goal is executed as its own normal,
 * frozen, two-key contract (its verification is authored per phase, like `--generate`), so a SubGoal
 * carries only the *intent* of a phase — the goal, an optional authoring hint, and an optional rubric
 * for any LLM-judge portion. The concrete ladder/command is compiled per phase, never declared here.
 */
export const SubGoal = z.object({
  goal: z.string().min(1),
  /** Free-form guidance for the per-phase authoring compiler (e.g. "add a vitest for the parser"). */
  intent: z.string().optional(),
  /** Optional rubric guidance for this phase's LLM-judge portion (frozen with the phase contract). */
  rubric: z.string().optional(),
});
export type SubGoal = z.infer<typeof SubGoal>;

/**
 * A decomposition plan: an ORDERED, linear list of sub-goals (no DAG/parallelism in v1 — see #48
 * "Out of scope"). Authored by the {@link Planner} seam (LLM) or read from a `--plan-file`, parsed
 * fail-closed, then FROZEN. The plan does NOT include the final cumulative-acceptance phase — that is
 * derived from the ORIGINAL goal/verifier and run after the last sub-goal (so decomposition can't
 * green a goal whose parts pass but whole doesn't).
 */
export const Plan = z.object({
  phases: z.array(SubGoal).min(1),
});
export type Plan = z.infer<typeof Plan>;
/** The plan minus its hash — what the planner produces before freezing. */
export type UnhashedPlan = z.input<typeof Plan>;

/**
 * The FROZEN plan: the sub-goal list plus its content hash. Authored once, hashed + logged, and never
 * rewritten by any transition (invariant #2, extended to the plan level). Re-planning is only the
 * bounded, human-gated revise path at the plan Seal — each attempt produces its own logged `planHash`.
 */
export const PhasePlan = z.object({
  phases: z.array(SubGoal).min(1),
  planHash: PlanHash,
});
export type PhasePlan = z.infer<typeof PhasePlan>;

/**
 * Canonical, stable serialization of a plan's *semantic* content (the ordered sub-goals), excluding
 * the hash itself. Pure and deterministic: order is preserved (the plan IS ordered) and key order is
 * fixed here, never left to `JSON.stringify`'s insertion order. Absent optional fields canonicalize to
 * `null` so the string is stable across equivalent plans.
 */
export function canonicalPlanString(p: UnhashedPlan): string {
  const phases = p.phases.map((s) => ({
    goal: s.goal,
    intent: s.intent ?? null,
    rubric: s.rubric ?? null,
  }));
  return JSON.stringify({ phases });
}
