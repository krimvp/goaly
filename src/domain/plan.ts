import { z } from 'zod';
import { PlanHash } from './ids';
import {
  describePlanGraphViolation,
  planDependencies,
  readyFrontier,
  validatePlanGraph,
} from './plan-graph';

/**
 * One sub-goal of a phased run (issue #48). Each sub-goal is executed as its own normal, frozen,
 * two-key contract (its verification is authored per phase, like `--generate`), so a SubGoal carries
 * only the *intent* of a phase — the goal, an optional authoring hint, and an optional rubric for any
 * LLM-judge portion. The concrete ladder/command is compiled per phase, never declared here.
 *
 * A sub-goal may also declare its position in the plan's DEPENDENCY GRAPH (issue #123): `id` names it
 * plan-locally and `dependsOn` lists the ids that must complete first.
 */
export const SubGoal = z.object({
  goal: z.string().min(1),
  /** Free-form guidance for the per-phase authoring compiler (e.g. "add a vitest for the parser"). */
  intent: z.string().optional(),
  /** Optional rubric guidance for this phase's LLM-judge portion (frozen with the phase contract). */
  rubric: z.string().optional(),
  /**
   * Stable, plan-local name for this phase — what other phases reference in `dependsOn` (issue #123).
   * Optional: a phase nothing depends on needs no id, and a plan authored before ids existed keeps
   * its exact `planHash` (ids canonicalize only when present).
   */
  id: z.string().min(1).optional(),
  /**
   * The phases that must COMPLETE before this one may run, by `id` (issue #123). Declaring edges is
   * how independence becomes checked rather than inferred from position: `[]` means "no
   * prerequisites" (a root), and an absent field falls back to the conservative positional default
   * (everything before this phase, or before its `group` band). Unknown ids, self-references,
   * cycles, and forward edges are typed, fail-closed parse failures — never a linearized plan.
   */
  dependsOn: z.array(z.string().min(1)).optional(),
  /**
   * SUGAR for `dependsOn` (kept for compatibility): CONSECUTIVE phases sharing a `group` value form
   * a band that lowers to "every member depends on everything before the band" — i.e. the band is
   * one topological frontier and executes concurrently under `--parallel-phases` (each phase as its
   * own frozen, two-key child run in an isolated worktree), then merges and RE-VERIFIES fail-closed.
   * Absent (the default) ⇒ the phase is strictly sequential, byte-for-byte the classic plan. The
   * grouping is part of the frozen plan (hashed), so no transition can re-shuffle it.
   */
  group: z.number().int().nonnegative().optional(),
});
export type SubGoal = z.infer<typeof SubGoal>;

/**
 * The plan's phase list, plus the fail-closed graph check every plan seam shares (issue #123).
 * Attached to BOTH `Plan` and `PhasePlan` so an unknown id, a self-reference, a cycle, or a
 * non-topological (forward) edge is a typed parse failure at the planner, the `--plan-file` reader,
 * the freeze, and the run-log read alike (invariant #6).
 */
const planPhases = { phases: z.array(SubGoal).min(1) };

function refinePlanGraph(value: { phases: readonly SubGoal[] }, ctx: z.RefinementCtx): void {
  const violation = validatePlanGraph(value.phases);
  if (violation === undefined) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ['phases'],
    message: describePlanGraphViolation(violation),
    params: { planGraph: violation },
  });
}

/**
 * A decomposition plan: a DAG of sub-goals carried as a topologically ORDERED list (issue #123 —
 * before that it was a strictly linear list with contiguous parallel bands). Authored by the
 * {@link Planner} seam (LLM) or read from a `--plan-file`, parsed fail-closed, then FROZEN. The plan
 * does NOT include the final cumulative-acceptance phase — that is derived from the ORIGINAL
 * goal/verifier and run after every phase (so decomposition can't green a goal whose parts pass but
 * whole doesn't).
 */
export const Plan = z.object(planPhases).superRefine(refinePlanGraph);
export type Plan = z.infer<typeof Plan>;
/** The plan minus its hash — what the planner produces before freezing. */
export type UnhashedPlan = z.input<typeof Plan>;

/**
 * The FROZEN plan: the sub-goal list plus its content hash. Authored once, hashed + logged, and never
 * rewritten by any transition (invariant #2, extended to the plan level). Re-planning is only the
 * bounded, human-gated revise path at the plan Seal — each attempt produces its own logged `planHash`.
 */
export const PhasePlan = z
  .object({ ...planPhases, planHash: PlanHash })
  .superRefine(refinePlanGraph);
export type PhasePlan = z.infer<typeof PhasePlan>;

/**
 * Canonical, stable serialization of a plan's *semantic* content (the ordered sub-goals and their
 * dependency edges), excluding the hash itself. Pure and deterministic: phase order is preserved (the
 * list is the plan's topological order) and key order is fixed here, never left to `JSON.stringify`'s
 * insertion order. Absent optional fields canonicalize to `null` so the string is stable across
 * equivalent plans.
 */
export function canonicalPlanString(p: UnhashedPlan): string {
  const phases = p.phases.map((s) => ({
    goal: s.goal,
    intent: s.intent ?? null,
    rubric: s.rubric ?? null,
    // `group` and the graph fields (`id`/`dependsOn`) are included ONLY when set, so every
    // pre-existing plan keeps the planHash it always had (back-compat), while a grouped or
    // graph-carrying plan freezes its structure into the hash — no transition can re-shuffle it.
    ...(s.group !== undefined ? { group: s.group } : {}),
    ...(s.id !== undefined ? { id: s.id } : {}),
    // Edge ORDER is not semantic, so the edge SET is canonicalized (sorted + deduplicated).
    ...(s.dependsOn !== undefined
      ? { dependsOn: [...new Set(s.dependsOn)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }
      : {}),
  }));
  return JSON.stringify({ phases });
}

/**
 * The topological FRONTIER to start at `index`: the phases that may run concurrently once every
 * phase before `index` (plus any already-`completed` index a wave merged out of order) is done.
 *
 * This is the pointer-model view of {@link readyFrontier} used by the reducer's phase walk. It
 * reproduces the pre-#123 `group` behaviour exactly — a band head fans out over its band, an
 * ungrouped phase is a singleton, and a MID-band entry (a sequential fallback / resume) never
 * re-fans-out — while a declared `dependsOn` graph fans out its real frontier instead. Pure and
 * total: an out-of-range `index` (the cumulative acceptance phase) is always the singleton `[index]`.
 */
export function waveIndicesAt(
  plan: PhasePlan,
  index: number,
  completed: readonly number[] = [],
): readonly number[] {
  const phase = plan.phases[index];
  if (phase === undefined) return [index];
  // Legacy `group` sugar: entering mid-band (a sequential fallback / resume) walks members one at a
  // time and never re-fans-out. A phase with declared edges has no band, so this never applies to it.
  if (
    phase.dependsOn === undefined &&
    phase.group !== undefined &&
    index > 0 &&
    plan.phases[index - 1]?.group === phase.group
  ) {
    return [index];
  }
  const done = new Set<number>(completed);
  for (let i = 0; i < index; i += 1) done.add(i);
  const frontier = readyFrontier(plan, done);
  // A validated plan is a DAG in topological order, so `index` is always ready here; the fallback
  // keeps the function total (and fail-closed to sequential) for any plan that dodged the parse seam.
  return frontier.length > 0 ? frontier : [index];
}

/** Re-exported so the plan's graph vocabulary lives behind one import. */
export { planDependencies, readyFrontier, validatePlanGraph, describePlanGraphViolation };
export type { PlanGraphViolation } from './plan-graph';
