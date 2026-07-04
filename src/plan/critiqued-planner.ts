import type { RunConfig } from '../domain/config';
import { criticalFindings, renderCritiqueFeedback } from '../domain/critique';
import type { PhasePlan } from '../domain/plan';
import { runCriticPanel } from '../llm/critic-panel';
import type { LlmProvider } from '../llm/provider';
import { noopLogger, type Logger } from '../log/logger';
import type { Planner } from './planner';

const SYSTEM_PROMPT =
  'You are an adversarial reviewer of a decomposition plan for an automated goal loop. Each phase ' +
  'will run as its own frozen, independently verified contract, in order. Your only job is to find ' +
  'how this plan FAILS: a phase whose success cannot be concretely verified (vague or vacuous); an ' +
  'ordering that makes a later phase impossible or forces rework of an earlier one; a phase so ' +
  'large its diff cannot be meaningfully reviewed; overlapping or redundant phases; or a plan ' +
  'that, taken together, does not add up to the stated goal. Do NOT rubber-stamp. Mark a finding ' +
  '"critical" ONLY if the plan would produce a wrong, unverifiable, or unachievable run — style ' +
  'preferences are "minor". Respond with ONLY a single JSON object, no prose, no markdown fences, ' +
  'matching exactly: { "verdict": "pass" | "revise", "findings": Array<{ "severity": "critical" | ' +
  '"minor", "lens"?: string, "claim": string, "fix"?: string }> }. A "revise" verdict MUST carry ' +
  'at least one finding.';

/** The plan-critic lens taxonomy, cycled across the panel. */
export const PLAN_CRITIC_LENSES: readonly string[] = [
  'VERIFIABILITY — can each phase be verified on its own with a concrete, non-vacuous check, or is ' +
    'some phase only "done" by assertion?',
  'ORDERING/DEPENDENCY — does every phase only depend on phases before it, and does no later phase ' +
    'force rework that invalidates an earlier phase’s frozen bar?',
  'SCOPE — is each phase small enough that its diff stays reviewable, while still carrying real, ' +
    'testable work (no filler phases)?',
  'GOAL-COVERAGE — do the phases, taken together, actually add up to the stated goal, with no ' +
    'silent gaps a worker could leave unfilled?',
];

export type CritiquedPlannerOpts = {
  inner: Planner;
  llm: LlmProvider;
  /** Plan-critic panel size per round. `<= 0` disables the critique (pass-through). */
  critics: number;
  /** Max critique→re-plan rounds. `<= 0` disables the critique (pass-through). */
  rounds: number;
  logger?: Logger;
};

/**
 * Plan critique (`--adversarial`, phased runs) — a decorator BEHIND the unchanged {@link Planner}
 * seam: plan, let an adversarial panel attack the not-yet-sealed plan, and on any critical finding
 * re-plan with the findings as authoring feedback (the same free-text channel a plan-Seal "revise"
 * uses), bounded by `rounds`. Strictly pre-freeze-approval: every attempt is frozen + logged on its
 * own and the plan Seal still decides. ADVISORY, fail-open like the contract red-team: a broken
 * panel passes the plan through. Compose wraps the LLM {@link AgentPlanner} only — a `--plan-file`
 * StaticPlanner is the user's explicit plan and is never critiqued.
 */
export class CritiquedPlanner implements Planner {
  readonly #inner: Planner;
  readonly #llm: LlmProvider;
  readonly #critics: number;
  readonly #rounds: number;
  readonly #logger: Logger;

  constructor(opts: CritiquedPlannerOpts) {
    this.#inner = opts.inner;
    this.#llm = opts.llm;
    this.#critics = opts.critics;
    this.#rounds = opts.rounds;
    this.#logger = opts.logger ?? noopLogger;
  }

  async plan(config: RunConfig, feedback?: string): Promise<PhasePlan> {
    let plan = await this.#inner.plan(config, feedback);
    if (this.#critics <= 0 || this.#rounds <= 0) return plan;

    for (let round = 1; round <= this.#rounds; round += 1) {
      const outputs = await runCriticPanel({
        llm: this.#llm,
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(config.goal, plan),
        lenses: PLAN_CRITIC_LENSES,
        count: this.#critics,
      });
      if (outputs.length === 0) {
        this.#logger.warn('plan critique produced no parseable critiques; passing through', {
          round,
        });
        return plan;
      }
      const findings = criticalFindings(outputs);
      if (findings.length === 0) {
        this.#logger.info('plan critique found no critical issues', { round });
        return plan;
      }
      const critique = renderCritiqueFeedback(findings);
      this.#logger.info('plan critique found critical issues; re-planning', {
        round,
        findings: findings.length,
      });
      const combined =
        feedback !== undefined && feedback.length > 0 ? `${feedback}\n\n${critique}` : critique;
      plan = await this.#inner.plan(config, combined);
    }
    // Rounds exhausted: the last re-authored plan passes through — the plan Seal still stands.
    return plan;
  }
}

function buildPrompt(goal: string, plan: PhasePlan): string {
  const phases = plan.phases
    .map((p, i) => {
      const intent = p.intent !== undefined ? `\n     intent: ${p.intent}` : '';
      const rubric = p.rubric !== undefined ? `\n     rubric: ${p.rubric}` : '';
      return `  ${i + 1}. ${p.goal}${intent}${rubric}`;
    })
    .join('\n');
  return [
    `GOAL:\n${goal}`,
    `PROPOSED PLAN (ordered; each phase runs as its own frozen contract; a cumulative acceptance ` +
      `phase on the ORIGINAL goal is appended automatically after these):\n${phases}`,
    'Attack this plan. Reply with ONLY the JSON critique object.',
  ].join('\n\n');
}
