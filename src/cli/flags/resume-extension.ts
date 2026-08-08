import type { RunConfig } from '../../domain/config';
import type { RunExtension } from '../../domain/events';
import { parseDelegationDirective } from '../delegation';
import { MAX_CANDIDATES } from './budget-flags';
import { UsageError, str, type RawFlags } from './tokens';

/**
 * The `--resume` operator-extension collector (ADR 0012), split out of `args.ts` so that module
 * stays about assembling {@link ParsedArgs}. Pure flag→extension policy: no IO, no defaults of its
 * own — every value is read off the ALREADY-validated {@link RunConfig}.
 */

/**
 * A natural-language parallel delegation recognised in a resume note ("try 4 parallel attempts"),
 * mapped onto the best-of-N tournament. Carried so the CLI can log the interpretation loudly.
 */
export type Delegation = { candidates: number; phrase: string; overriddenByFlag: boolean };

/**
 * Collect the operator extension for a `--resume` (ADR 0012) from EXPLICITLY-passed CLI flags
 * (never the config-file overlay — an extension is a per-invocation operator act). The values are
 * read off the already-validated RunConfig (so every coercion/floor is applied once); only flags
 * actually present become part of the extension — absent ones keep whatever the run log's
 * effective config says. `--note` is resume-only: on a fresh run there is no next-turn boundary to
 * attach it to, so it fails closed with the fix.
 */
export function collectResumeExtension(
  flags: RawFlags,
  config: RunConfig,
): { extension: RunExtension | undefined; delegation: Delegation | undefined } {
  const resuming = str(flags, 'resume') !== undefined;
  let note = str(flags, 'note');
  if (!resuming) {
    if (note !== undefined) {
      throw new UsageError(
        '--note steers a RESUMED run (it is appended to the next agent prompt) — pair it with ' +
          '--resume <runId>. To guide a fresh run, put the guidance in the goal or --intent.',
      );
    }
    return { extension: undefined, delegation: undefined };
  }
  const has = (key: string): boolean => flags[key] !== undefined;
  // Natural-language delegation in a resume note ("try 4 parallel attempts"): the steering intent
  // is goaly's to ACT on (a `candidates` overlay on the extension), not the worker's to read — so
  // the directive clause is stripped and any remaining guidance stays the note. The explicit
  // `--candidates` / `--best-of` flag wins, exactly as on a fresh run.
  const explicit = has('candidates') || has('best-of');
  let delegation: Delegation | undefined;
  if (note !== undefined) {
    const directive = parseDelegationDirective(note);
    if (directive !== null) {
      if (directive.candidates > MAX_CANDIDATES) {
        throw new UsageError(
          `"${directive.phrase}": at most ${MAX_CANDIDATES} parallel candidates are supported ` +
            `(each is a full concurrent worker + worktree) — ask for ${MAX_CANDIDATES} or fewer`,
        );
      }
      delegation = {
        candidates: directive.candidates,
        phrase: directive.phrase,
        overriddenByFlag: explicit,
      };
      note = directive.cleaned.length > 0 ? directive.cleaned : undefined;
    }
  }
  const stuck = {
    ...(has('stuck-no-diff') ? { noDiff: config.stuckPolicy.noDiff } : {}),
    ...(has('stuck-repeat-threshold')
      ? { repeatFailureThreshold: config.stuckPolicy.repeatFailureThreshold }
      : {}),
    ...(has('stuck-oscillation') ? { oscillation: config.stuckPolicy.oscillation } : {}),
    ...(has('stuck-crash-threshold')
      ? { harnessCrashThreshold: config.stuckPolicy.harnessCrashThreshold }
      : {}),
    ...(has('stuck-unevaluable-threshold')
      ? { unevaluableThreshold: config.stuckPolicy.unevaluableThreshold }
      : {}),
    ...(has('stuck-timeout-no-diff-threshold')
      ? { timeoutNoDiffThreshold: config.stuckPolicy.timeoutNoDiffThreshold }
      : {}),
  };
  const extension: RunExtension = {
    ...(has('max-iterations') ? { maxIterations: config.maxIterations } : {}),
    ...(has('budget-tokens') && config.budget.tokens !== undefined
      ? { budgetTokens: config.budget.tokens }
      : {}),
    ...(has('budget-wall-ms') && config.budget.wallClockMs !== undefined
      ? { budgetWallMs: config.budget.wallClockMs }
      : {}),
    ...(Object.keys(stuck).length > 0 ? { stuck } : {}),
    ...(explicit
      ? { candidates: config.candidates }
      : delegation !== undefined
        ? { candidates: delegation.candidates }
        : {}),
    ...(note !== undefined ? { note } : {}),
  };
  return {
    extension: Object.keys(extension).length > 0 ? extension : undefined,
    delegation,
  };
}
