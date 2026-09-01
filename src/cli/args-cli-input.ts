import { z } from 'zod';
import { CliInput } from '../domain/config';
import type { ResolvedInputs } from './input-sources';
import { UsageError, str, boolFlag, type RawFlags } from './flags/tokens';
import { parseResumeBestOfIncomplete } from './flags/budget-flags';
import {
  parseAdversarialCount,
  parseApproverDiversityTemp,
  parseContractDryRun,
  parseApproverLenses,
  parseApproverQuorum,
  parseSatisfiabilityCritic,
} from './flags/review-flags';

/**
 * The merged flag overlay → `CliInput` step of a `run`: every flag that feeds the frozen
 * {@link RunConfig} is picked off the flags here and handed to the domain schema, with Zod failures
 * translated into a {@link UsageError} that names the flag as the user spells it.
 */

/**
 * Build and validate the `CliInput` for a run. `goal` is the (directive-stripped) goal text or the
 * resume placeholder; `candidates` is the explicit `--candidates` value, else the count a goal
 * delegation directive asked for, else absent.
 */
export function buildCliInput(
  flags: RawFlags,
  resolved: ResolvedInputs,
  goal: string,
  candidates: string | undefined,
): z.infer<typeof CliInput> {
  return parseCliInput({
    goal,
    ...taskFields(flags, resolved, candidates),
    ...stuckAndBudgetFields(flags),
    ...reviewFields(flags),
  });
}

/** Verification source, inputs, loop caps and the phased-plan shape. */
function taskFields(
  flags: RawFlags,
  resolved: ResolvedInputs,
  candidates: string | undefined,
): Record<string, unknown> {
  return {
    ...(str(flags, 'verify-cmd') !== undefined ? { verifyCmd: str(flags, 'verify-cmd') } : {}),
    ...(flags['generate'] !== undefined ? { generate: true } : {}),
    ...(str(flags, 'smoke') !== undefined ? { smoke: str(flags, 'smoke') } : {}),
    ...(str(flags, 'setup-cmd') !== undefined ? { setupCmd: str(flags, 'setup-cmd') } : {}),
    ...(flags['no-setup'] !== undefined ? { noSetup: true } : {}),
    ...(boolFlag(flags, 'install-missing-tools') !== undefined
      ? { installMissingTools: boolFlag(flags, 'install-missing-tools') }
      : {}),
    ...(resolved.intent !== undefined ? { intent: resolved.intent } : {}),
    ...(resolved.rubric !== undefined ? { rubric: resolved.rubric } : {}),
    ...(flags['autonomous'] !== undefined ? { autonomous: true } : {}),
    ...(str(flags, 'max-iterations') !== undefined
      ? { maxIterations: str(flags, 'max-iterations') }
      : {}),
    ...(candidates !== undefined ? { candidates } : {}),
    ...(parseResumeBestOfIncomplete(flags) !== undefined
      ? { resumeBestOfIncomplete: parseResumeBestOfIncomplete(flags) }
      : {}),
    ...(flags['phased'] !== undefined ? { phased: true } : {}),
    ...(flags['parallel-phases'] !== undefined ? { parallelPhases: true } : {}),
    ...(str(flags, 'max-phases') !== undefined ? { maxPhases: str(flags, 'max-phases') } : {}),
    ...(str(flags, 'max-plan-revisions') !== undefined
      ? { maxPlanRevisions: str(flags, 'max-plan-revisions') }
      : {}),
    ...(str(flags, 'max-seal-revisions') !== undefined
      ? { maxSealRevisions: str(flags, 'max-seal-revisions') }
      : {}),
    ...(str(flags, 'max-compile-retries') !== undefined
      ? { maxCompileRetries: str(flags, 'max-compile-retries') }
      : {}),
    ...(str(flags, 'max-plan-retries') !== undefined
      ? { maxPlanRetries: str(flags, 'max-plan-retries') }
      : {}),
  };
}

/** Stuck-detection policy, budgets and the diff scope. */
function stuckAndBudgetFields(flags: RawFlags): Record<string, unknown> {
  return {
    ...(boolFlag(flags, 'stuck-no-diff') !== undefined
      ? { stuckNoDiff: boolFlag(flags, 'stuck-no-diff') }
      : {}),
    ...(str(flags, 'stuck-repeat-threshold') !== undefined
      ? { stuckRepeatThreshold: str(flags, 'stuck-repeat-threshold') }
      : {}),
    ...(boolFlag(flags, 'stuck-oscillation') !== undefined
      ? { stuckOscillation: boolFlag(flags, 'stuck-oscillation') }
      : {}),
    ...(str(flags, 'stuck-crash-threshold') !== undefined
      ? { stuckCrashThreshold: str(flags, 'stuck-crash-threshold') }
      : {}),
    ...(str(flags, 'stuck-unevaluable-threshold') !== undefined
      ? { stuckUnevaluableThreshold: str(flags, 'stuck-unevaluable-threshold') }
      : {}),
    ...(str(flags, 'stuck-timeout-no-diff-threshold') !== undefined
      ? { stuckTimeoutNoDiffThreshold: str(flags, 'stuck-timeout-no-diff-threshold') }
      : {}),
    ...(boolFlag(flags, 'auto-remediate-stuck') !== undefined
      ? { autoRemediateStuck: boolFlag(flags, 'auto-remediate-stuck') }
      : {}),
    ...(str(flags, 'budget-tokens') !== undefined
      ? { budgetTokens: str(flags, 'budget-tokens') }
      : {}),
    ...(str(flags, 'budget-wall-ms') !== undefined
      ? { budgetWallClockMs: str(flags, 'budget-wall-ms') }
      : {}),
    ...(str(flags, 'diff-ignore') !== undefined ? { diffIgnore: str(flags, 'diff-ignore') } : {}),
    ...(flags['delta-verify'] !== undefined ? { deltaVerify: true } : {}),
  };
}

/** The approver panel, the adversarial critics and the contract dry-run. */
function reviewFields(flags: RawFlags): Record<string, unknown> {
  return {
    ...(parseApproverQuorum(flags) !== undefined
      ? { approverQuorum: parseApproverQuorum(flags) }
      : {}),
    ...(parseApproverDiversityTemp(flags) !== undefined
      ? { approverDiversityTemp: parseApproverDiversityTemp(flags) }
      : {}),
    ...(parseApproverLenses(flags) !== undefined
      ? { approverLenses: parseApproverLenses(flags) }
      : {}),
    ...(flags['adversarial'] !== undefined ? { adversarial: true } : {}),
    ...(parseAdversarialCount(flags, 'adversarial-plan-critics') !== undefined
      ? { adversarialPlanCritics: parseAdversarialCount(flags, 'adversarial-plan-critics') }
      : {}),
    ...(parseAdversarialCount(flags, 'adversarial-contract-critics') !== undefined
      ? { adversarialContractCritics: parseAdversarialCount(flags, 'adversarial-contract-critics') }
      : {}),
    ...(parseAdversarialCount(flags, 'adversarial-refuters') !== undefined
      ? { adversarialRefuters: parseAdversarialCount(flags, 'adversarial-refuters') }
      : {}),
    ...(parseSatisfiabilityCritic(flags) !== undefined
      ? { satisfiabilityCritic: parseSatisfiabilityCritic(flags) }
      : {}),
    ...(parseContractDryRun(flags) !== undefined
      ? { contractDryRun: parseContractDryRun(flags) }
      : {}),
  };
}

/**
 * The user-facing spelling of a `CliInput` field: mechanical camelCase→kebab-case, plus the two
 * fields whose flag spelling is not mechanical.
 */
const FLAG_SPELLING_EXCEPTIONS: Record<string, string> = {
  budgetWallClockMs: 'budget-wall-ms',
  satisfiabilityCritic: 'no-satisfiability-critic',
};

function flagSpelling(field: string): string {
  const kebab =
    FLAG_SPELLING_EXCEPTIONS[field] ?? field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  return `--${kebab}`;
}

/**
 * `CliInput.parse` with Zod failures translated into a clean {@link UsageError} naming the flag as
 * the user spells it. Without this, a bad flag value (`--max-iterations abc`) escapes as a raw
 * ZodError stack with exit 1 — indistinguishable from a failed run — instead of a usage error
 * (exit 2) like every other malformed invocation.
 */
function parseCliInput(input: Record<string, unknown>): z.infer<typeof CliInput> {
  try {
    return CliInput.parse(input);
  } catch (e) {
    if (!(e instanceof z.ZodError)) throw e;
    const lines = e.issues.map((issue) => {
      const field = String(issue.path[0] ?? 'input');
      return `invalid value for ${flagSpelling(field)}: ${issue.message}`;
    });
    throw new UsageError(lines.join('\n'));
  }
}
