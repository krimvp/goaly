import type { HarnessChoice, LlmProviderChoice } from './args';
import type { ResolvedModels } from './models';

/**
 * "Two independent keys" (invariant #3) is only real if the verifier's judge rung and the Sign-off
 * approver — and ideally the worker — do not collapse onto a single model with correlated blind
 * spots. The cascade in {@link resolveModels} makes that collapse the DEFAULT: with a
 * single `--model X` (or no overrides at all) the judge and the approver resolve to the same model.
 * These are advisory warnings, surfaced loudly at composition; they never fail a run.
 */

/** The llm-provider family whose model vendor matches a given harness CLI. */
function harnessFamily(harness: HarnessChoice): LlmProviderChoice | undefined {
  switch (harness) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'droid':
      return 'droid';
    case 'goaly-code':
      // The goaly-code harness drives an OpenAI-compatible endpoint — the same family as the openai provider.
      return 'openai';
    case 'pi':
    case 'fake':
      return undefined;
  }
}

/** `undefined` means "that tool's own default"; two undefineds are the same default model. */
const sameModel = (a: string | undefined, b: string | undefined): boolean => a === b;

const label = (m: string | undefined): string => m ?? 'the tool default';

/**
 * Run-shape context (follow-on H) that lets the independence check ESCALATE for the most
 * deadlock-prone wiring: `--generate --autonomous`, where the model both self-authors its bar AND
 * self-judges it with no human in the loop. Both default to false so a caller that omits them gets
 * the plain advisory warnings (back-compat with the 3-arg callers).
 */
export type IndependenceContext = {
  /** The verification is LLM-authored (`--generate`), not a user-supplied `--verify-cmd`. */
  generate?: boolean;
  /** Seal (and the plan) are auto-accepted (`--autonomous`) — no human reviews the frozen bar. */
  autonomous?: boolean;
  /**
   * Sign-off approver panel size (issue #84). A `> 1` quorum on ONE model is VARIANCE REDUCTION, not
   * perspective independence — it does not break the judge↔/worker↔approver collapse below. Surfaced
   * so a multi-vote panel on the same model isn't mistaken for a genuinely independent second key.
   * Default 1 ⇒ the single-call approver (no extra note).
   */
  approverQuorum?: number;
  /**
   * Per-reviewer Sign-off models (follow-up to issue #84). When this lists ≥2 DISTINCT models, the
   * panel IS perspective-independent — distinct vendors/models with uncorrelated blind spots, not one
   * model re-sampled. That genuinely supplies the independent second key, so the judge↔approver,
   * worker↔approver, and variance-reduction warnings are all SUPPRESSED. A single distinct model (a
   * one-entry list, or every entry the same) collapses back to the single-model panel and the
   * warnings still apply. Absent ⇒ the single-model approver.
   */
  approverModels?: string[];
};

/** True when the per-reviewer list supplies ≥2 DISTINCT models — a genuinely independent panel. */
function panelIsModelIndependent(models: string[] | undefined): boolean {
  if (models === undefined) return false;
  return new Set(models).size >= 2;
}

/**
 * Compute the model-independence warnings for a resolved wiring. Pure and order-stable so it is
 * unit-testable without building the whole driver.
 */
export function independenceWarnings(
  resolved: ResolvedModels,
  harness: HarnessChoice,
  llmProvider: LlmProviderChoice,
  context: IndependenceContext = {},
): string[] {
  const warnings: string[] = [];

  // A `--approver-models` panel with ≥2 DISTINCT models is the genuinely independent second key: the
  // approver no longer collapses onto the judge's or the worker's model, so EVERY approver-collapse
  // warning below (judge↔approver, worker↔approver, the self-judge escalation, and the
  // variance-reduction note) is suppressed. (A one-model panel — a single entry or all-identical
  // entries — falls back to the single-model approver and the warnings still apply.)
  const panelIndependent = panelIsModelIndependent(context.approverModels);
  const judgeApproverCollapse = !panelIndependent && sameModel(resolved.judge, resolved.approver);
  const workerApproverCollapse =
    !panelIndependent &&
    harnessFamily(harness) === llmProvider &&
    sameModel(resolved.harness, resolved.approver);

  // Follow-on H: in `--generate --autonomous` the model self-authors its bar AND self-judges it. When
  // the coding agent, the judge rung, AND the Sign-off approver all collapse onto ONE model, that is
  // the self-author + self-judge deadlock gpt-oss hit (a compiling 484-LOC server that `completed`
  // with no diff against its own judge rung): the model can author a bar it then cannot satisfy and
  // cannot recognize as satisfied, so it stalls. Escalate it ABOVE the plain advisories — it is the
  // most deadlock-prone setup, and the two-key guarantee (invariant #3) is only nominal here.
  if (context.generate === true && context.autonomous === true && judgeApproverCollapse && workerApproverCollapse) {
    warnings.push(
      `SELF-JUDGE RISK (--generate --autonomous): the coding agent, the LLM judge rung, AND the ` +
        `Sign-off approver all resolve to the same model (${label(resolved.approver)}) — the model ` +
        'self-authors its bar and self-judges it with no human in the loop, the most deadlock-prone ' +
        'setup (it can stall on a bar it cannot satisfy or recognize as satisfied). Strongly consider ' +
        '--approver-model (and/or --judge-model) on a DIFFERENT model/provider so the second key is a ' +
        'genuinely independent skeptic.',
    );
  }

  // The judge rung and the approver always run on the same llm-provider, so they share one model
  // whenever their resolved models match — the second key then inherits the first key's blind spots.
  if (judgeApproverCollapse) {
    warnings.push(
      `the LLM judge rung and the Sign-off approver run on the same model (${label(resolved.approver)}); ` +
        'pass --approver-model to keep the two keys independent',
    );
  }

  // The worker and the approver collapse only when they are the same vendor family AND model — then
  // the agent grading the work is effectively the agent that wrote it.
  if (workerApproverCollapse) {
    warnings.push(
      `the coding agent and the Sign-off approver share the same model (${label(resolved.approver)}); ` +
        'pass --approver-model (or a different --llm-provider) so the approver stays an independent skeptic',
    );
  }

  // A multi-vote approver panel (issue #84) on ONE model is variance reduction, not perspective
  // independence — it samples the SAME model N times, so it does not break either collapse above. Note
  // it only when the panel is actually multi-vote AND it shares a model with the judge or the worker
  // (a panel on a genuinely separate --approver-model already is the independent second key).
  const quorum = context.approverQuorum ?? 1;
  if (quorum > 1 && (judgeApproverCollapse || workerApproverCollapse)) {
    warnings.push(
      `the Sign-off approver runs a ${quorum}-reviewer quorum on a SINGLE model ` +
        `(${label(resolved.approver)}) that it shares with the judge rung and/or the coding agent — ` +
        'that is VARIANCE REDUCTION, not perspective independence (the panel re-samples one model). ' +
        'For a genuinely independent second key, pair --approver-quorum with --approver-model on a ' +
        'DIFFERENT model/provider.',
    );
  }

  return warnings;
}
