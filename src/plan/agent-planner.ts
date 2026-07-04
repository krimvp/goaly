import { z } from 'zod';
import type { RunConfig } from '../domain/config';
import { Plan, type PhasePlan } from '../domain/plan';
import { freezePlan } from '../util/hash';
import { extractBalancedJson } from '../util/json-extract';
import type { LlmProvider } from '../llm/provider';
import type { Planner } from './planner';

/** Schema for the JSON the planning LLM must emit (validated fail-closed, invariant #6). */
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

const SYSTEM_PROMPT =
  'You decompose one large software goal into an ORDERED, LINEAR plan of small sub-goals. Reply with ' +
  'ONLY a single JSON object, no prose, no markdown fences. Shape: ' +
  '{ "phases": Array<{ "goal": string, "intent"?: string, "rubric"?: string }> }.\n' +
  'Rules:\n' +
  '- Each phase is built and verified on its own, in order, before the next begins; later phases may ' +
  'build on earlier ones. Order them so each is achievable given the previous ones are done.\n' +
  '- Keep each phase SMALL and independently verifiable, so its diff stays small (that is the whole ' +
  'point of decomposing). Split a big goal into the fewest phases that each carry real, testable work.\n' +
  '- "goal" is a concrete, self-contained instruction for that phase. "intent" optionally hints how to ' +
  'author that phase\'s verification; "rubric" optionally guides its judge portion. Omit what you don\'t need.\n' +
  '- Do NOT include a final "make everything pass" / "run the whole test suite" phase — a cumulative ' +
  'acceptance step on the ORIGINAL goal is added automatically after your phases.';

function parseGenerated(raw: string): Plan {
  const json = extractBalancedJson(raw);
  if (json === undefined) throw new Error('AgentPlanner: LLM response contained no JSON object');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'unknown parse error';
    throw new Error(`AgentPlanner: LLM response was not valid JSON: ${message}`);
  }
  return Plan.parse(GeneratedPlan.parse(parsed));
}

/**
 * AgentPlanner — the LLM-backed {@link Planner}. Has the model author the ordered sub-goal list,
 * validates it fail-closed with Zod, and FREEZES the result (its `planHash` set). A throw here is
 * turned into a typed `PLAN_FAILED` by the Driver. The model never edits the tree (planning is
 * authoring): this consumes the read-only `LlmProvider` seam, exactly like the compiler/judge/approver.
 */
export class AgentPlanner implements Planner {
  readonly #llm: LlmProvider;
  /**
   * The provider session of the LAST authoring call, when the transport supports resume: a re-plan
   * round (plan-Seal "revise", plan-critique re-author) resumes it with only the feedback as a
   * delta turn, mirroring the {@link AgentCompiler}'s authoring continuity. Authoring-only — the
   * plan gate and plan critics stay independent, fresh sessions.
   */
  #session: string | undefined;

  constructor(opts: { llm: LlmProvider }) {
    this.#llm = opts.llm;
  }

  async plan(config: RunConfig, feedback?: string): Promise<PhasePlan> {
    const parts = [`Goal: ${config.goal}`, `Author at most ${config.maxPhases} phases.`];
    if (feedback !== undefined && feedback.length > 0) {
      parts.push(`Reviewer feedback on the previous plan (revise accordingly): ${feedback}`);
    }
    parts.push('Author the plan as JSON only.');

    // A revise round resumes the planner's OWN prior session where supported (delta = the feedback);
    // fresh fallback on any resume failure — the shortcut must never cost a working re-plan round.
    const resumeId =
      feedback !== undefined && feedback.length > 0 && this.#llm.supportsResume === true
        ? this.#session
        : undefined;
    const prompt =
      resumeId !== undefined
        ? `Reviewer feedback on your previous plan (revise accordingly): ${feedback}\n` +
          'Re-emit the COMPLETE plan JSON object described at the start of this session. JSON only.'
        : parts.join('\n');

    let text: string;
    let session: string | undefined;
    try {
      ({ text, sessionId: session } = await this.#llm.complete({
        system: SYSTEM_PROMPT,
        prompt,
        temperature: 0,
        ...(resumeId !== undefined ? { resumeSessionId: resumeId } : {}),
      }));
    } catch (e) {
      if (resumeId === undefined) throw e;
      this.#session = undefined;
      ({ text, sessionId: session } = await this.#llm.complete({
        system: SYSTEM_PROMPT,
        prompt: parts.join('\n'),
        temperature: 0,
      }));
    }
    this.#session = session;

    return freezePlan(parseGenerated(text));
  }
}
