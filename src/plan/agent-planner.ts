import { z } from 'zod';
import type { RunConfig } from '../domain/config';
import { Plan, type PhasePlan } from '../domain/plan';
import { freezePlan } from '../util/hash';
import { extractBalancedJson } from '../util/json-extract';
import type { LlmProvider } from '../llm/provider';
import { looksLikeLlmTimeout } from '../compile/agent-compiler';
import { UNTRUSTED_SYSTEM_CLAUSE } from '../verify/prompt-safety';
import type { Planner } from './planner';

/** Schema for the JSON the planning LLM must emit (validated fail-closed, invariant #6). */
const GeneratedPlan = z.object({
  phases: z
    .array(
      z.object({
        goal: z.string().min(1),
        intent: z.string().optional(),
        rubric: z.string().optional(),
        id: z.string().min(1).optional(),
        dependsOn: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1),
});

const SYSTEM_PROMPT =
  'You decompose one large software goal into an ORDERED plan of small sub-goals. Reply with ' +
  'ONLY a single JSON object, no prose, no markdown fences. Shape: ' +
  '{ "phases": Array<{ "goal": string, "intent"?: string, "rubric"?: string, "id"?: string, ' +
  '"dependsOn"?: string[] }> }.\n' +
  'Rules:\n' +
  '- OPTIONAL dependency graph: give a phase a short "id" and list the ids it truly needs in ' +
  '"dependsOn" ("dependsOn": [] means it needs nothing). Phases must still be listed in an order ' +
  'where every dependency comes BEFORE the phase that needs it; a cycle, a forward reference, or an ' +
  'unknown id is rejected. Omit both fields when the plan is plainly sequential.\n' +
  '- Each phase is built and verified on its own, in order, before the next begins; later phases may ' +
  'build on earlier ones. Order them so each is achievable given the previous ones are done.\n' +
  '- Keep each phase SMALL and independently verifiable, so its diff stays small (that is the whole ' +
  'point of decomposing). Split a big goal into the fewest phases that each carry real, testable work.\n' +
  '- "goal" is a concrete, self-contained instruction for that phase. "intent" optionally hints how to ' +
  'author that phase\'s verification; "rubric" optionally guides its judge portion. Omit what you don\'t need.\n' +
  '- Do NOT include a final "make everything pass" / "run the whole test suite" phase — a cumulative ' +
  'acceptance step on the ORIGINAL goal is added automatically after your phases.\n' +
  // The planner's `feedback` channel can carry model- or worker-authored text: a `--from-run`
  // follow-up seeds it with the prior run's compaction, whose verifier output / veto reason /
  // abort reason are fenced by `compactRun`. Like every other seam that splices such text into a
  // prompt (compiler, judge, approver, adversarial rung, pre-flight), restate the fence rule so the
  // fenced block reads as data, never as planning instructions.
  UNTRUSTED_SYSTEM_CLAUSE;

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

  /**
   * Author (or re-author) the frozen plan. A throw becomes a typed `PLAN_FAILED`, which the reducer
   * re-asks up to `--max-plan-retries` times with the reason as guidance — except for a TIMEOUT,
   * which is annotated here so the operator is pointed at `--llm-timeout-ms` instead of at a retry
   * budget that cannot help.
   */
  async plan(config: RunConfig, feedback?: string): Promise<PhasePlan> {
    try {
      return await this.#author(config, feedback);
    } catch (e) {
      throw withTimeoutHint(e);
    }
  }

  async #author(config: RunConfig, feedback?: string): Promise<PhasePlan> {
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
        // Fresh authoring mints a goaly-owned session (see AgentCompiler) so a later resume
        // replays only this planner's own turns, even under an ambient-pinned CLI.
        ...(resumeId !== undefined ? { resumeSessionId: resumeId } : { mintSession: true }),
      }));
    } catch (e) {
      if (resumeId === undefined) throw e;
      this.#session = undefined;
      ({ text, sessionId: session } = await this.#llm.complete({
        system: SYSTEM_PROMPT,
        prompt: parts.join('\n'),
        temperature: 0,
        mintSession: true,
      }));
    }
    this.#session = session;

    return freezePlan(parseGenerated(text));
  }
}

/**
 * The actionable remedy folded into a timeout-`PLAN_FAILED` — the planner's mirror of the
 * compiler's (follow-on G). Re-asking a call that timed out just times out again, so the retry
 * budget added alongside this (`--max-plan-retries`) is the wrong lever here and the message says so.
 */
const LLM_TIMEOUT_HINT =
  'Hint: the plan-authoring LLM call timed out — raise --llm-timeout-ms (current default 600000), ' +
  'or reduce concurrent load. Re-issuing the same heavy call will keep timing out, so bumping the ' +
  'timeout is the remedy, not more --max-plan-retries.';

/**
 * Wrap a timed-out authoring error with the raise-`--llm-timeout-ms` hint so it flows into the
 * PLAN_FAILED reason; any non-timeout error is rethrown unchanged (its own message is the signal).
 * Shares the compiler's detector so the two authoring seams classify a timeout identically.
 */
function withTimeoutHint(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (!looksLikeLlmTimeout(message)) return e instanceof Error ? e : new Error(message);
  return new Error(`AgentPlanner: ${message}\n\n${LLM_TIMEOUT_HINT}`);
}
