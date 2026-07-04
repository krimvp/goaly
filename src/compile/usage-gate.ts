import { z } from 'zod';
import type { LlmProvider } from '../llm/provider';
import { extractBalancedJson } from '../util/json-extract';

/**
 * Anti-reimplementation gate (the "reimplementation cheating" hole).
 *
 * A goal of the shape "BUILD a reusable artifact X and USE it to do Y" can be satisfied by a worker
 * that writes a PARALLEL reimplementation of the physics/logic straight inside the Y-solvers and never
 * calls X. A naive bar (X's unit tests pass AND Y's numbers are correct) greens that reimplementation:
 * both keys pass while the artifact the goal is actually about is dead code. Observed in the wild on a
 * "build a physics engine and solve hard problems with it" run — the solvers re-derived the physics
 * standalone and `World.step`/`resolve_collision` were never exercised by any hard problem.
 *
 * The defense has two halves:
 *  1. an INDEPENDENT shape classifier ({@link classifyUsageShape}) — a separate, neutral LLM call that
 *     judges only the GOAL (never the worker-authored contract), so it is not swayed by an authoring
 *     model's incentive to author a bar it can clear cheaply; and
 *  2. a deterministic gate ({@link enforceUsageAssertion}) — for a confident build-and-use goal, the
 *     authored contract MUST carry a runtime usage assertion (a spy/call-through check that the built
 *     artifact's public entry points are actually invoked while the verified result is produced),
 *     embedded in a frozen test file. Missing/hollow → a typed error the Driver maps to COMPILE_FAILED,
 *     which the bounded compile-retry loop re-authors WITH the assertion.
 *
 * The classifier is fail-OPEN (any error/uncertainty → not build-and-use → the gate is a no-op) so a
 * misfire can never wrongly abort a legitimate run; it only bites on a confident build-and-use verdict.
 * This mirrors the pre-flight soundness philosophy (a wrong "broken" would kill a good run; a wrong
 * "sound" only proceeds).
 */

/** How the authoring LLM classifies the goal's shape (only the neutral classifier emits this). */
export const UsageShape = z.object({
  /** True when the goal builds a reusable artifact AND requires using it to accomplish the goal. */
  buildAndUse: z.boolean(),
  /** The artifact that must be exercised (module/class/API), or null when not build-and-use. */
  targetArtifact: z.string().nullable(),
  /** One-line justification (auditability). */
  reason: z.string(),
});
export type UsageShape = z.infer<typeof UsageShape>;

/**
 * The usage-assertion DECLARATION the verification author emits alongside the command/rubric/files.
 * `targetSymbols` are the built artifact's public entry points the consumer MUST exercise (e.g.
 * "World.step", "resolve_collision"); the gate checks they actually appear in an authored (frozen)
 * verification file, so the declaration cannot be hollow.
 */
export const UsageAssertion = z.object({
  targetSymbols: z.array(z.string().min(1)).min(1),
  description: z.string().min(1),
});
export type UsageAssertion = z.infer<typeof UsageAssertion>;

const SHAPE_SYSTEM =
  'You classify a software GOAL by its SHAPE, not by whether it is achievable. Reply with ONLY a ' +
  'single JSON object, no prose, no markdown fences. Shape: ' +
  '{ "buildAndUse": boolean, "targetArtifact": string|null, "reason": string }. ' +
  'Set "buildAndUse" to true when the goal asks to BUILD a reusable artifact (a module, engine, ' +
  'library, class, data structure, framework, or API) AND then USE that artifact to accomplish ' +
  'something (solve problems, power a feature, drive a demo, back an endpoint) — i.e. any correct ' +
  'solution MUST route its higher-level behavior THROUGH the artifact\'s own public API, so a parallel ' +
  'reimplementation that bypassed the artifact would be a wrong solution even if its outputs were ' +
  'correct. Set "buildAndUse" to false for a plain bugfix, a refactor, a one-off script, a config or ' +
  'docs change, or any goal that names no reusable artifact whose use is part of the goal. ' +
  '"targetArtifact" names that artifact when true, else null. Judge only the goal text.';

function notBuildAndUse(reason: string): UsageShape {
  return { buildAndUse: false, targetArtifact: null, reason };
}

/**
 * Independent shape classification: one neutral LLM call over the goal (and optional intent). Parsed
 * fail-OPEN — no JSON / bad JSON / a provider error all resolve to "not build-and-use" so the gate
 * degrades to a no-op rather than block a legitimate run. Only a cleanly-parsed `buildAndUse: true`
 * arms the gate.
 */
export async function classifyUsageShape(
  llm: LlmProvider,
  goal: string,
  intent: string | undefined,
): Promise<UsageShape> {
  const promptParts = [`Goal: ${goal}`];
  if (intent !== undefined && intent.length > 0) {
    promptParts.push(`Intent: ${intent}`);
  }
  promptParts.push('Classify this goal by shape as JSON only.');

  let raw: string;
  try {
    ({ text: raw } = await llm.complete({
      system: SHAPE_SYSTEM,
      prompt: promptParts.join('\n'),
      temperature: 0,
    }));
  } catch {
    return notBuildAndUse('shape-classification call failed — proceeding without the usage gate');
  }

  const json = extractBalancedJson(raw);
  if (json === undefined) {
    return notBuildAndUse('shape classification returned no JSON — proceeding without the usage gate');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return notBuildAndUse('shape classification returned invalid JSON — proceeding without the usage gate');
  }
  const result = UsageShape.safeParse(parsed);
  if (!result.success) {
    return notBuildAndUse('shape classification did not match the schema — proceeding without the usage gate');
  }
  return result.data;
}

function missingAssertionMessage(artifact: string | null): string {
  const target = artifact !== null && artifact.length > 0 ? ` (target: ${artifact})` : '';
  return (
    `AgentCompiler: this is a BUILD-AND-USE goal${target} — the verification must prove the solution ` +
    'actually USES the built artifact, not a parallel reimplementation that bypasses it. Author a ' +
    "RUNTIME usage assertion in a frozen test file: spy the artifact's public entry points (wrap or " +
    'monkeypatch them to count calls) and assert the higher-level result is produced THROUGH them ' +
    '(call-count > 0 while the correct value is returned) — a reimplementation records zero calls and ' +
    'FAILS. Declare it in "usageAssertion": { "targetSymbols": [the public symbols the consumer must ' +
    'exercise], "description": how the test asserts they are invoked }.'
  );
}

function hollowAssertionMessage(missing: readonly string[]): string {
  return (
    'AgentCompiler: the declared usageAssertion.targetSymbols are not referenced by any authored ' +
    `verification file (${missing.join(', ')}). The usage assertion must live in a frozen test file ` +
    'that actually spies those symbols — declaring them without embedding the spy in a frozen file ' +
    'leaves the reimplementation hole open. Add the assertion to a file you author.'
  );
}

/**
 * The deterministic half of the gate. When the goal is a confident build-and-use, require the authored
 * contract to carry a real usage assertion embedded in a frozen file:
 *   - the `usageAssertion` declaration must be present, and
 *   - every declared target symbol must actually appear in at least one authored file's content
 *     (so the declaration is not hollow — the spy really lives in the frozen bar).
 * A violation throws; the Driver turns a compile throw into COMPILE_FAILED, and the bounded
 * compile-retry loop re-authors with the missing assertion. A non-build-and-use shape is a no-op.
 */
export function enforceUsageAssertion(args: {
  shape: UsageShape;
  usageAssertion: UsageAssertion | undefined;
  files: readonly { path: string; content: string }[];
}): void {
  if (!args.shape.buildAndUse) return;
  if (args.usageAssertion === undefined) {
    throw new Error(missingAssertionMessage(args.shape.targetArtifact));
  }
  const authored = args.files.map((f) => f.content).join('\n');
  const missing = args.usageAssertion.targetSymbols.filter((sym) => !authored.includes(sym));
  if (missing.length > 0) {
    throw new Error(hollowAssertionMessage(missing));
  }
}
