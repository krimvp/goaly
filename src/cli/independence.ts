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
};

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

  const judgeApproverCollapse = sameModel(resolved.judge, resolved.approver);
  const workerApproverCollapse =
    harnessFamily(harness) === llmProvider && sameModel(resolved.harness, resolved.approver);

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

  return warnings;
}
