import { z } from 'zod';
import type { CompiledContract } from '../domain/contract';
import type { LlmProvider } from '../llm/provider';
import { extractJson } from '../util/json-extract';
import { UNTRUSTED_SYSTEM_CLAUSE, wrapUntrusted } from '../verify/prompt-safety';
import { errorMessage } from '../util/errors';
import { noopLogger, type Logger } from '../log/logger';

/**
 * Language-agnostic pre-flight soundness classifier (replaces the old text/exit-code heuristic).
 *
 * The pre-flight runs the frozen deterministic verifier ONCE against the STARTING tree (before any
 * implementation exists), so it is red either because (a) a defect lives INSIDE the frozen verification
 * files themselves — a syntax/compile/collection/import error the agent can NEVER fix, since those files
 * are frozen — or (b) the work the agent still has to do is not done yet: the implementation is missing,
 * OR project scaffolding the implementation must create (a dependency manifest like go.mod/package.json,
 * uninstalled deps, an unresolved import of a not-yet-written module) is absent. Case (b) is the expected
 * HONEST red the loop fixes — agent-fixable, NOT a broken verifier. On a from-scratch tree (no
 * implementation source yet) case (b) is the overwhelmingly likely cause, so the caller threads an
 * `emptyOfSource` signal into the prompt to bias the classifier even harder toward "honest red" — but the
 * rung is still run and classified, so a non-compiling AUTHORED verifier (case (a)) is caught even there
 * (issue #78: the old Fix B1 short-circuited the rung entirely on a from-scratch tree, letting a frozen,
 * agent-unfixable broken verifier render the whole run un-completable).
 *
 * Telling those apart from the failure text is inherently language-specific (pytest exit 1 vs 2-5, but
 * `cargo` exits 101 for both a compile error AND a failing test; `go test` uses 1 vs 2; tsc 2 vs …) — a
 * regex/exit-code rule cannot be both correct and generic. So we ask the model that just authored the
 * verification, which reads the output the way a human would, regardless of language or runner.
 *
 * Fail-OPEN to "sound" (proceed): a wrong "broken" aborts a legitimate run at zero iterations (the very
 * bug this replaces), whereas a wrong "sound" only proceeds — the real verifier ladder still runs
 * fail-closed every iteration and a genuinely broken frozen verifier is caught generically by
 * repeat-failure stuck detection (STUCK_REPEATED_FAILURE). So only a confident `brokenVerification: true`
 * aborts; an LLM error, an unparseable response, or any uncertainty proceeds.
 */
const SYSTEM_PROMPT = [
  'You are a pre-flight soundness checker in an automated goal-orchestration loop.',
  'A frozen, auto-authored VERIFICATION (test files / a check command) was just run ONCE against the',
  'STARTING codebase — before the implementation has been written. It failed (a red). Your ONLY job is',
  'to decide WHY it is red, choosing exactly one:',
  ' - brokenVerification=true: the defect is INSIDE THE FROZEN VERIFICATION FILES THEMSELVES — a',
  '   syntax error, a compile/type error, a collection/import error, or a usage error in an authored',
  '   test/check file. Because those files are frozen, NO amount of implementation code can fix it.',
  ' - brokenVerification=false: the verification RAN correctly and is failing only because the work the',
  '   AGENT still has to do is not done yet. This is the normal starting state and the loop will fix it.',
  '   It includes BOTH: (a) the implementation does not exist yet — missing files/functions, assertion',
  '   failures; AND (b) project scaffolding the IMPLEMENTATION is expected to create is not present yet',
  '   — a missing dependency manifest/module the agent must author (go.mod, package.json, Cargo.toml,',
  '   pyproject.toml, requirements.txt, tsconfig.json), uninstalled project dependencies, or an',
  '   unresolved import of a not-yet-written module. All of those are AGENT-FIXABLE, so answer false.',
  'Worked example: `go build ./...` failing with "no required module provides package X; go.mod not',
  '   found" → false (the agent will create go.mod and write the package). By contrast,',
  '   "verify/x.test.ts(3,5): error TS2339: Property \'foo\' does not exist" inside the FROZEN authored',
  '   test → true (the defect lives in the verification the agent cannot change).',
  'When in doubt, answer false — a verifier that merely names a not-yet-created file, a not-yet-created',
  'manifest, or a not-yet-installed dependency in its output is almost always a healthy red. Reserve',
  'true for a defect you can point to INSIDE the authored verification files listed below.',
  'Respond with ONLY a single JSON object of the form {"brokenVerification": boolean, "reason": string}.',
  'No prose, no markdown, no code fences — JSON only.',
  UNTRUSTED_SYSTEM_CLAUSE,
].join(' ');

const PreflightClassification = z.object({
  brokenVerification: z.boolean(),
  reason: z.string().optional(),
});

/** The classifier's verdict. `broken: true` aborts (CONTRACT_UNSOUND); `false` proceeds to the loop. */
export type SoundnessVerdict = { broken: boolean; reason: string };

export type ClassifyDeps = { llm: LlmProvider; logger?: Logger };

function buildPrompt(contract: CompiledContract, detail: string, emptyOfSource: boolean): string {
  const authored = contract.generatedFiles.map((f) => `  - ${f.path}`).join('\n');
  // On a from-scratch tree the implementation does not exist yet, so an implementation-missing /
  // scaffolding-missing red is the expected starting state. Bias the classifier hard toward "honest red"
  // there — reserve brokenVerification=true for a defect you can point to INSIDE the frozen files.
  const fromScratch = emptyOfSource
    ? 'CONTEXT: the starting tree is EMPTY OF IMPLEMENTATION SOURCE (a from-scratch build) — no ' +
      'implementation files exist yet, so an implementation-missing or scaffolding-missing red is the ' +
      'expected, overwhelmingly likely cause. Answer brokenVerification=true ONLY if you can point to a ' +
      'defect INSIDE the frozen verification files themselves (a syntax/compile/collection/import/usage ' +
      'error those frozen files would hit no matter what implementation is written).'
    : null;
  return [
    `GOAL:\n${contract.goal}`,
    `AUTHORED VERIFICATION FILES (frozen — the agent cannot change these):\n${authored}`,
    ...(fromScratch !== null ? [fromScratch] : []),
    `VERIFICATION OUTPUT ON THE STARTING TREE (it failed):\n${wrapUntrusted(detail, { label: 'OUTPUT' })}`,
    'Is the verification itself broken (cannot run), or is this an expected red because the implementation is missing?',
    'Reply with ONLY the JSON {"brokenVerification": boolean, "reason": string}.',
  ].join('\n\n');
}

/**
 * Ask the model whether a failing pre-flight deterministic rung means the FROZEN verification is broken
 * (→ CONTRACT_UNSOUND) or is an honest red (→ proceed). Fail-open to NOT broken on any LLM error or
 * unparseable response (see the module doc): the runtime ladder + repeat-failure detection are the real
 * fail-closed backstop, and a false abort is the worse outcome. `emptyOfSource` (from-scratch tree) is
 * threaded into the prompt to bias even harder toward "honest red" — see the module doc and issue #78.
 */
export async function classifyPreflightSoundness(
  deps: ClassifyDeps,
  contract: CompiledContract,
  detail: string,
  emptyOfSource: boolean,
): Promise<SoundnessVerdict> {
  const log = deps.logger ?? noopLogger;
  let raw: string;
  try {
    raw = (
      await deps.llm.complete({
        system: SYSTEM_PROMPT,
        prompt: buildPrompt(contract, detail, emptyOfSource),
        temperature: 0,
      })
    ).text;
  } catch (e) {
    log.warn('pre-flight soundness check: LLM call failed — proceeding (honest red assumed)', {
      reason: errorMessage(e),
    });
    return { broken: false, reason: `soundness check could not run: ${errorMessage(e)}` };
  }

  const extracted = extractJson(raw);
  const parsed = extracted === null ? null : PreflightClassification.safeParse(extracted);
  if (parsed === null || !parsed.success) {
    log.warn('pre-flight soundness check: unparseable response — proceeding (honest red assumed)', {});
    return { broken: false, reason: 'soundness check produced no parseable verdict' };
  }

  return { broken: parsed.data.brokenVerification, reason: parsed.data.reason ?? '' };
}

/**
 * The GREEN-case mirror of {@link classifyPreflightSoundness}: the frozen, auto-authored verifier
 * PASSES on a from-scratch tree BEFORE the worker has written anything. On a tree with no
 * implementation source, that can only mean the contract is UNSOUND — either the compiler authored
 * the implementation INTO the frozen verification set (so the bar tests code the worker didn't write,
 * and the anti-tamper guard then deadlocks the worker against a no-diff abort) or the bar is vacuous
 * (it doesn't actually exercise the goal). The caller fires this ONLY when there is an authored
 * verifier AND the tree is confidently from-scratch, so the rare legitimate alternative — "the goal
 * is genuinely already satisfied by the starting tree" — is what the model is asked to rule in.
 *
 * Fail-OPEN to NOT unsound (proceed), exactly like the red classifier and for the same reason: a
 * wrong "unsound" aborts a legitimate run at zero iterations, whereas a wrong "sound" only proceeds
 * (the real ladder + the two-key gate still govern every iteration). So an LLM error, an unparseable
 * response, or any uncertainty proceeds — only a confident `unsound: true` aborts (CONTRACT_UNSOUND).
 */
const GREEN_SYSTEM_PROMPT = [
  'You are a pre-flight soundness checker in an automated goal-orchestration loop.',
  'A frozen, auto-authored VERIFICATION (test files / a check command) was just run ONCE against a',
  'FROM-SCRATCH starting tree — there is NO implementation source yet, the worker has written nothing.',
  'It PASSED (a green). On an empty tree a real bar for the goal should be RED, so a green is suspicious.',
  'Decide, choosing exactly one:',
  ' - unsound=true: the contract is NOT actually testing the goal. Either the IMPLEMENTATION was',
  '   authored into the frozen verification set itself (the bar passes off code the worker did not',
  '   write — and since those files are frozen, the worker is deadlocked), OR the bar is VACUOUS /',
  "   trivially true (e.g. it checks nothing that depends on the goal's implementation).",
  ' - unsound=false: the goal is GENUINELY already satisfied by the pre-existing starting tree (rare on',
  '   a from-scratch build), so passing is legitimate and the loop should proceed.',
  'When in doubt, answer false — only a confident "the bar is not exercising the goal" is unsound.',
  'Respond with ONLY a single JSON object {"unsound": boolean, "reason": string}. No prose, no markdown.',
  UNTRUSTED_SYSTEM_CLAUSE,
].join(' ');

const GreenClassification = z.object({
  unsound: z.boolean(),
  reason: z.string().optional(),
});

function buildGreenPrompt(contract: CompiledContract, detail: string): string {
  const authored = contract.generatedFiles.map((f) => `  - ${f.path}`).join('\n');
  return [
    `GOAL:\n${contract.goal}`,
    `AUTHORED VERIFICATION FILES (frozen — the worker cannot change these):\n${authored}`,
    'CONTEXT: the starting tree is EMPTY OF IMPLEMENTATION SOURCE (a from-scratch build) — the worker ' +
      'has written nothing yet, so a bar that genuinely exercises the goal should be RED here.',
    `VERIFICATION OUTPUT ON THE STARTING TREE (it PASSED):\n${wrapUntrusted(detail, { label: 'OUTPUT' })}`,
    'Is the contract unsound (the bar is not actually testing the goal — the implementation was ' +
      'authored into the frozen files, or the bar is vacuous), or is the goal genuinely already satisfied?',
    'Reply with ONLY the JSON {"unsound": boolean, "reason": string}.',
  ].join('\n\n');
}

/**
 * Ask the model whether a frozen verifier that ALREADY PASSES on a from-scratch tree means the
 * contract is unsound (→ CONTRACT_UNSOUND) or the goal is genuinely already met (→ proceed). Reuses
 * {@link SoundnessVerdict} (`broken` = unsound). Fail-open to NOT unsound on any LLM error or
 * unparseable response — see the doc above.
 */
export async function classifyVacuousContract(
  deps: ClassifyDeps,
  contract: CompiledContract,
  detail: string,
): Promise<SoundnessVerdict> {
  const log = deps.logger ?? noopLogger;
  let raw: string;
  try {
    raw = (
      await deps.llm.complete({
        system: GREEN_SYSTEM_PROMPT,
        prompt: buildGreenPrompt(contract, detail),
        temperature: 0,
      })
    ).text;
  } catch (e) {
    log.warn('pre-flight green-soundness check: LLM call failed — proceeding (assumed sound)', {
      reason: errorMessage(e),
    });
    return { broken: false, reason: `green-soundness check could not run: ${errorMessage(e)}` };
  }

  const extracted = extractJson(raw);
  const parsed = extracted === null ? null : GreenClassification.safeParse(extracted);
  if (parsed === null || !parsed.success) {
    log.warn('pre-flight green-soundness check: unparseable response — proceeding (assumed sound)', {});
    return { broken: false, reason: 'green-soundness check produced no parseable verdict' };
  }

  return { broken: parsed.data.unsound, reason: parsed.data.reason ?? '' };
}

/**
 * IN-LOOP contract-fault adjudication (issue #116) — the third sibling, and the only one that runs
 * with evidence instead of without it.
 *
 * Both classifiers above are asked at t=0, against a tree with no implementation in it. For one
 * defect class that timing is not unlucky but UNDECIDABLE: when a frozen assertion is impossible to
 * satisfy, its t=0 failure is byte-identical to an honest "not written yet" red — nothing exists
 * either way. The evidence that settles it ("a real implementation now exists and the same assertion
 * still reds") only comes into being several iterations later, exactly when the repeat-failure
 * detector fires. This asks the question THEN.
 *
 * Fail-CLOSED to `defective: false`, the INVERSE of its two pre-flight siblings — and for the same
 * underlying reason (never let a classifier make things worse). There, a wrong verdict would ABORT a
 * legitimate run at zero iterations, so uncertainty must proceed. Here the run is ALREADY aborting on
 * the repeat streak, so the conservative answer is today's abort: an LLM error, an unparseable reply,
 * a schema miss, or any uncertainty all leave the pre-#116 output untouched. Only a confident
 * `defective: true` relabels it. Read-only in every sense — nothing here can produce a green.
 */
const FAULT_SYSTEM_PROMPT = [
  'You are adjudicating a FROZEN, auto-authored success contract in an automated coding loop.',
  'A coding agent has been working for several iterations. The working tree now contains a real,',
  'substantially complete implementation — the agent has repeatedly changed it. Yet the SAME frozen',
  'check has produced the SAME failure every iteration. The check files are FROZEN: the agent cannot',
  'edit them. Decide, choosing exactly one:',
  ' - defective=true: the frozen assertion is IMPOSSIBLE to satisfy — NO correct implementation of',
  '   the stated goal could make it pass. For example it asserts on a function/parameter/message the',
  '   goal never implies, requires a side effect the goal forbids, contradicts another rung, or',
  '   depends on something outside any implementation\'s control.',
  ' - defective=false: the assertion IS satisfiable by some correct implementation — the agent simply',
  '   has not written that implementation yet, or is failing for an ordinary reason (a bug, a missing',
  '   case, an environment problem). This is the normal meaning of a repeated failure.',
  'When in doubt, answer FALSE. A repeated failure is USUALLY the implementation\'s fault; reserve',
  'true for a defect you can point to IN THE FROZEN CHECK and justify as unsatisfiable in principle.',
  'When (and only when) you answer true, also give "pattern": a ONE-SENTENCE GENERALIZED description',
  'of the authoring anti-pattern — no file contents, no identifiers from this repo, no mention of how',
  'hard the agent found the work.',
  'Respond with ONLY a single JSON object {"defective": boolean, "reason": string, "pattern": string}.',
  'No prose, no markdown, no code fences — JSON only.',
  UNTRUSTED_SYSTEM_CLAUSE,
].join(' ');

const FaultClassification = z.object({
  defective: z.boolean(),
  reason: z.string().optional(),
  pattern: z.string().optional(),
});

/** The adjudicator's verdict. `defective: true` relabels the abort as CONTRACT_DEFECTIVE. */
export type ContractFaultVerdict = { defective: boolean; reason: string; pattern?: string };

function buildFaultPrompt(
  contract: CompiledContract,
  signature: string,
  diffSummary: string,
  repeatCount: number,
): string {
  const authored = contract.generatedFiles.map((f) => `  - ${f.path}`).join('\n');
  return [
    `GOAL:\n${contract.goal}`,
    `FROZEN VERIFICATION FILES (the agent cannot change these):\n${authored}`,
    `THE FAILURE, REPEATED IDENTICALLY ${repeatCount} ITERATIONS IN A ROW:\n` +
      wrapUntrusted(signature, { label: 'FAILURE' }),
    `THE IMPLEMENTATION THE AGENT HAS WRITTEN SO FAR:\n${wrapUntrusted(diffSummary, { label: 'DIFF' })}`,
    'Given this implementation: could ANY correct implementation of the goal make that frozen check ' +
      'pass, or is the frozen check itself defective (unsatisfiable in principle)?',
    'Reply with ONLY the JSON {"defective": boolean, "reason": string, "pattern": string}.',
  ].join('\n\n');
}

/**
 * Ask the model whether the frozen bar a repeat-failure streak keeps tripping is itself defective.
 * Fail-closed to `{ defective: false }` on EVERY failure mode (see the doc above), so the caller's
 * behavior is unchanged unless a confident positive comes back. `signature` and `diffSummary` are
 * model/tool text, so both are wrapped as untrusted input.
 */
export async function classifyContractFault(
  deps: ClassifyDeps,
  contract: CompiledContract,
  signature: string,
  diffSummary: string,
  repeatCount: number,
): Promise<ContractFaultVerdict> {
  const log = deps.logger ?? noopLogger;
  let raw: string;
  try {
    raw = (
      await deps.llm.complete({
        system: FAULT_SYSTEM_PROMPT,
        prompt: buildFaultPrompt(contract, signature, diffSummary, repeatCount),
        temperature: 0,
      })
    ).text;
  } catch (e) {
    log.warn('contract-fault adjudication: LLM call failed — keeping the repeat-failure abort', {
      reason: errorMessage(e),
    });
    return { defective: false, reason: `adjudication could not run: ${errorMessage(e)}` };
  }

  const extracted = extractJson(raw);
  const parsed = extracted === null ? null : FaultClassification.safeParse(extracted);
  if (parsed === null || !parsed.success) {
    log.warn('contract-fault adjudication: unparseable response — keeping the repeat-failure abort', {});
    return { defective: false, reason: 'adjudication produced no parseable verdict' };
  }

  const { defective, reason, pattern } = parsed.data;
  return {
    defective,
    reason: reason ?? '',
    // The generalized anti-pattern is only meaningful for a positive verdict; never carry it out of
    // a "sound" answer, where it would be a stray description of a bar that is fine.
    ...(defective && pattern !== undefined && pattern.length > 0 ? { pattern } : {}),
  };
}
