import type { HarnessChoice, LlmProviderChoice } from './args';
import type { ResolvedModels } from './models';

/**
 * "Two independent keys" (invariant #3) is only real if the verifier's judge rung and the Gate B
 * approver — and ideally the worker — do not collapse onto a single model with correlated blind
 * spots. The cascade in {@link resolveModels} makes that collapse the DEFAULT: with a
 * single `--model X` (or no overrides at all) the judge and the approver resolve to the same model.
 * These are advisory warnings, surfaced loudly at composition; they never fail a run.
 */

/** The llm-provider family whose model vendor matches a given harness CLI. */
function harnessFamily(harness: HarnessChoice): LlmProviderChoice | undefined {
  switch (harness) {
    case 'claude-code':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'droid':
      return 'droid';
    case 'fake':
      return undefined;
  }
}

/** `undefined` means "that tool's own default"; two undefineds are the same default model. */
const sameModel = (a: string | undefined, b: string | undefined): boolean => a === b;

const label = (m: string | undefined): string => m ?? 'the tool default';

/**
 * Compute the model-independence warnings for a resolved wiring. Pure and order-stable so it is
 * unit-testable without building the whole driver.
 */
export function independenceWarnings(
  resolved: ResolvedModels,
  harness: HarnessChoice,
  llmProvider: LlmProviderChoice,
): string[] {
  const warnings: string[] = [];

  // The judge rung and the approver always run on the same llm-provider, so they share one model
  // whenever their resolved models match — the second key then inherits the first key's blind spots.
  if (sameModel(resolved.judge, resolved.approver)) {
    warnings.push(
      `the LLM judge rung and the Gate B approver run on the same model (${label(resolved.approver)}); ` +
        'pass --approver-model to keep the two keys independent',
    );
  }

  // The worker and the approver collapse only when they are the same vendor family AND model — then
  // the agent grading the work is effectively the agent that wrote it.
  if (harnessFamily(harness) === llmProvider && sameModel(resolved.harness, resolved.approver)) {
    warnings.push(
      `the coding agent and the Gate B approver share the same model (${label(resolved.approver)}); ` +
        'pass --approver-model (or a different --llm-provider) so the approver stays an independent skeptic',
    );
  }

  return warnings;
}
