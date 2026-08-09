import type { HarnessRunResult } from '../domain/events';
import type { CompiledContract, Rung } from '../domain/contract';

/**
 * The reducer's PURE prompt builders — extracted verbatim from `step.ts` so that file stays inside
 * the repo's 800-line convention. Nothing here reads a clock, spawns a process, or touches an
 * adapter: every function is a total, synchronous projection of the FROZEN contract (+ the already
 * resolved feedback / run status) onto the text handed to the worker. That keeps them reducer-safe
 * (invariant #1) — `src/orchestrator/**` still has no IO, no LLM, and no `Promise`.
 */

export function describeRungs(rungs: readonly Rung[]): string {
  return rungs
    .map((r, i) =>
      r.kind === 'deterministic'
        ? `${i + 1}. Run \`${r.command}\` — it must exit 0.`
        : `${i + 1}. Judged against the frozen rubric: ${r.rubric}`,
    )
    .join('\n');
}

export function buildInitialPrompt(
  contract: CompiledContract,
  installTools?: readonly string[],
  setupHint?: string,
): string {
  return [
    '# Goal',
    contract.goal,
    '',
    buildBootstrapSection(contract, installTools),
    buildSetupNoteSection(setupHint),
    '# Frozen success contract (you cannot modify it)',
    'Your work is accepted only when ALL of the following pass:',
    describeRungs(contract.rungs),
    contract.rubric ? `\nOverall rubric:\n${contract.rubric}` : '',
    '',
    'Make the changes needed to satisfy the contract. Do not weaken or rewrite the checks themselves.',
    '',
    VERIFICATION_DIVISION_OF_LABOR,
  ].join('\n');
}

/**
 * The division-of-labor note carried by every worker prompt. The worker's ONE job each turn is to
 * EDIT the tree toward the goal; goaly runs the frozen contract itself after the turn and feeds the
 * result back next iteration. Spelling this out prevents the failure mode where the agent treats
 * "run the verification command" as a required submit step and — when that command can't run in its
 * environment — burns the whole turn flailing on it and ends with no edits (a no-diff stall). Running
 * its own quick checks is fine; getting stuck on one is not.
 */
const VERIFICATION_DIVISION_OF_LABOR = [
  '# How verification works (do not run it yourself to "submit")',
  'goaly runs the frozen success contract above for you AUTOMATICALLY after this turn ends, and gives',
  'you the result on the next turn. You do NOT need to run the verification command to submit your',
  'work — your job each turn is to EDIT the code toward the goal. Running your own quick checks is',
  'fine, but if a command is unavailable or blocked in this environment, do NOT get stuck on it:',
  'make your best-effort code changes and end the turn. A turn that changes no files makes no progress.',
].join('\n');

/**
 * The bootstrap instruction prepended to the first prompt when required tools are missing and goaly is
 * delegating their install to the agent (the default `--install-missing-tools` path). goaly skipped its
 * own one-time setup (it would only fail on the absent toolchain), so the agent must install the tools
 * AND run the project setup itself before the verification can pass. Empty when nothing is missing.
 */
function buildBootstrapSection(
  contract: CompiledContract,
  installTools?: readonly string[],
): string {
  if (installTools === undefined || installTools.length === 0) return '';
  const setupNote =
    contract.setup !== undefined
      ? ` Then run the project's one-time setup: \`${contract.setup}\`.`
      : '';
  return [
    '# Bootstrap required first',
    `The verification needs these tools, which are NOT installed on PATH: ${installTools.join(', ')}.`,
    `Install them first (you have shell access; use the standard installer and make sure each ends up on PATH).${setupNote}`,
    'Only then implement the goal — the verification cannot pass until the toolchain is present.',
    '',
  ].join('\n');
}

/**
 * The setup note prepended to the first prompt when a COMPILER-AUTHORED setup command failed and the
 * prepare phase degraded to best-effort proceed (Fix A). It tells the agent the bootstrap was attempted,
 * presupposes scaffolding that does not exist yet, and must be scaffolded + run by the agent. Empty when
 * there is no such hint (setup ran clean, was absent, or was a fatal user `--setup-cmd`).
 */
function buildSetupNoteSection(setupHint?: string): string {
  if (setupHint === undefined || setupHint.length === 0) return '';
  return ['# Setup note', setupHint, ''].join('\n');
}

export function buildLoopPrompt(
  contract: CompiledContract,
  feedback: string,
  runStatus?: HarnessRunResult['status'],
): string {
  const statusNote =
    runStatus !== undefined && runStatus !== 'completed'
      ? `Note: your previous run ended as '${runStatus}' (it did not finish cleanly) — pick up where it left off.\n\n`
      : '';
  return [
    '# Goal',
    contract.goal,
    '',
    '# The contract is not yet satisfied',
    `${statusNote}Feedback from verification:`,
    feedback,
    '',
    'Continue working toward the goal. Do not modify the success contract or its tests.',
    '',
    VERIFICATION_DIVISION_OF_LABOR,
  ].join('\n');
}
