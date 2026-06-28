import { z } from 'zod';
import type { CompiledContract } from '../domain/contract';
import type { LlmProvider } from '../llm/provider';
import { extractJson } from '../verify/judge';
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
 * HONEST red the loop fixes — agent-fixable, NOT a broken verifier. (A fully empty from-scratch tree is
 * short-circuited to proceed upstream in `prepare.ts` before this classifier is ever consulted — Fix B1.)
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

function buildPrompt(contract: CompiledContract, detail: string): string {
  const authored = contract.generatedFiles.map((f) => `  - ${f.path}`).join('\n');
  return [
    `GOAL:\n${contract.goal}`,
    `AUTHORED VERIFICATION FILES (frozen — the agent cannot change these):\n${authored}`,
    `VERIFICATION OUTPUT ON THE STARTING TREE (it failed):\n${wrapUntrusted(detail, { label: 'OUTPUT' })}`,
    'Is the verification itself broken (cannot run), or is this an expected red because the implementation is missing?',
    'Reply with ONLY the JSON {"brokenVerification": boolean, "reason": string}.',
  ].join('\n\n');
}

/**
 * Ask the model whether a failing pre-flight deterministic rung means the FROZEN verification is broken
 * (→ CONTRACT_UNSOUND) or is an honest red (→ proceed). Fail-open to NOT broken on any LLM error or
 * unparseable response (see the module doc): the runtime ladder + repeat-failure detection are the real
 * fail-closed backstop, and a false abort is the worse outcome.
 */
export async function classifyPreflightSoundness(
  deps: ClassifyDeps,
  contract: CompiledContract,
  detail: string,
): Promise<SoundnessVerdict> {
  const log = deps.logger ?? noopLogger;
  let raw: string;
  try {
    raw = (
      await deps.llm.complete({ system: SYSTEM_PROMPT, prompt: buildPrompt(contract, detail), temperature: 0 })
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
