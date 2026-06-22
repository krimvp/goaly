import { z } from 'zod';
import type { RunConfig } from '../domain/config';
import { freezePlan, type Plan, type UnhashedPlan } from '../domain/plan';
import type { LlmProvider } from '../llm/provider';
import type { Planner } from './planner';

/** Schema for the JSON the planning LLM must emit (validated fail-closed). */
const GeneratedPlan = z.object({
  phases: z
    .array(
      z.object({
        goal: z.string().min(1),
        intent: z.string().optional(),
        rubric: z.string().optional(),
      }),
    )
    .min(1),
});
type GeneratedPlan = z.infer<typeof GeneratedPlan>;

const SYSTEM_PROMPT =
  'You decompose one large software goal into a SMALL, ORDERED plan of independently-verifiable ' +
  'sub-goals. Each phase builds on the previous one and must be individually testable. Reply with ' +
  'ONLY a single JSON object, no prose, no markdown fences. Shape: ' +
  '{ "phases": Array<{ "goal": string, "intent"?: string, "rubric"?: string }> }. ' +
  'Order matters: phase N may assume phases 1..N-1 are done. Keep each phase as small as is ' +
  'reasonable so its diff stays reviewable. Do NOT include a final "run all the tests" phase — the ' +
  'orchestrator adds a cumulative acceptance phase for the original goal automatically.';

/**
 * Extract the first balanced JSON object from a string. Tolerant of surrounding prose or markdown
 * fences the LLM may emit despite instructions. String-literal aware (ignores braces in strings).
 */
function extractBalancedJson(text: string): string | undefined {
  const start = text.indexOf('{');
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function parseGenerated(raw: string): GeneratedPlan {
  const json = extractBalancedJson(raw);
  if (json === undefined) throw new Error('AgentPlanner: LLM response contained no JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown parse error';
    throw new Error(`AgentPlanner: LLM response was not valid JSON: ${message}`);
  }
  return GeneratedPlan.parse(parsed);
}

/**
 * AgentPlanner — the planning phase. Has the LLM author an ordered plan of sub-goals, validates it
 * fail-closed with Zod, enforces the `maxPhases` cap, and FREEZES the result (its `planHash` set
 * once). A throw here is turned into PLAN_FAILED by the Driver. Read-only: it never edits the tree.
 */
export class AgentPlanner implements Planner {
  readonly #llm: LlmProvider;

  constructor(opts: { llm: LlmProvider }) {
    this.#llm = opts.llm;
  }

  async plan(config: RunConfig, feedback?: string): Promise<Plan> {
    const parts = [`Goal: ${config.goal}`];
    if (config.verifier.kind === 'existing') {
      parts.push(`The original goal is verified by running: ${config.verifier.ref}`);
    } else if (config.verifier.intent !== undefined && config.verifier.intent.length > 0) {
      parts.push(`Verification intent: ${config.verifier.intent}`);
    }
    if (config.rubric !== undefined && config.rubric.length > 0) {
      parts.push(`Rubric guidance: ${config.rubric}`);
    }
    parts.push(`Emit at most ${config.maxPhases} phases.`);
    if (feedback !== undefined && feedback.length > 0) {
      parts.push(`Reviewer feedback on the previous plan (revise accordingly): ${feedback}`);
    }
    parts.push('Author the plan as JSON only.');

    const { text: raw } = await this.#llm.complete({
      system: SYSTEM_PROMPT,
      prompt: parts.join('\n'),
      temperature: 0,
    });

    const generated = parseGenerated(raw);
    if (generated.phases.length > config.maxPhases) {
      throw new Error(
        `AgentPlanner: plan has ${generated.phases.length} phases, exceeding --max-phases ` +
          `(${config.maxPhases}) — refusing to freeze an over-long plan`,
      );
    }

    const unhashed: UnhashedPlan = {
      phases: generated.phases.map((p) => ({
        goal: p.goal,
        ...(p.intent !== undefined ? { intent: p.intent } : {}),
        ...(p.rubric !== undefined ? { rubric: p.rubric } : {}),
      })),
    };
    return freezePlan(unhashed);
  }
}
