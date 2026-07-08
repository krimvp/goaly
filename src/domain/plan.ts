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
  /**
   * EXPERIMENTAL — cooperative parallel waves (opt-in via `--parallel-phases`): CONSECUTIVE phases
   * sharing a `group` value form a WAVE that executes concurrently (each phase as its own frozen,
   * two-key child run in an isolated worktree) and is then merged and RE-VERIFIED fail-closed.
   * Absent (the default) ⇒ the phase is strictly sequential, byte-for-byte the classic plan. The
   * grouping is part of the frozen plan (hashed), so no transition can re-shuffle it.
   */
  group: z.number().int().nonnegative().optional(),
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
    // `group` (parallel waves) is included ONLY when set, so every pre-existing plan keeps the
    // planHash it always had (back-compat), while a grouped plan's grouping is frozen into the hash.
    ...(s.group !== undefined ? { group: s.group } : {}),
  }));
  return JSON.stringify({ phases });
}

/**
 * The CONSECUTIVE indices sharing `plan.phases[index]`'s wave group, starting at `index` (which must
 * be the group's first member for a fan-out to trigger). Returns `[index]` alone when the phase has
 * no group, the group has one member, or `index` is mid-group (a resumed sequential fallback walks
 * the remaining members one at a time — never re-fans-out from the middle). Pure and total.
 */
export function waveIndicesAt(plan: PhasePlan, index: number): readonly number[] {
  const phase = plan.phases[index];
  if (phase === undefined || phase.group === undefined) return [index];
  // Mid-group entry (a sequential fallback / resume) never re-fans-out.
  if (index > 0 && plan.phases[index - 1]?.group === phase.group) return [index];
  const wave: number[] = [index];
  for (let i = index + 1; i < plan.phases.length; i += 1) {
    if (plan.phases[i]?.group !== phase.group) break;
    wave.push(i);
  }
  return wave;
}
