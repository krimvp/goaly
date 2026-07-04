import { JudgeOutput, type Verdict } from '../domain/verdict';
import type { LlmProvider } from '../llm/provider';
import { extractJson } from '../util/json-extract';
import type { Verifier } from '../verify/verifier';
import type { Workspace } from '../workspace/workspace';
import { UNTRUSTED_SYSTEM_CLAUSE, wrapUntrusted } from './prompt-safety';

type JudgeOpts = {
  rubric: string;
  quorum: number;
  confidenceFloor: number;
  llm: LlmProvider;
  /**
   * Sampling temperature used ONLY when `quorum > 1`, to make the N samples genuinely diverse.
   * A single-sample quorum stays at temperature 0 (maximally stable). Defaults to
   * {@link DIVERSITY_TEMPERATURE}.
   */
  diversityTemperature?: number;
};

/**
 * The temperature a multi-sample quorum samples at. Temperature 0 is ~deterministic, so N samples
 * would be near-identical — paying N× the tokens for almost no variance reduction. A quorum only
 * buys robustness when its samples actually differ, so when `quorum > 1` we sample with a little
 * diversity; a `quorum === 1` judge keeps temperature 0 (no quorum, maximal stability).
 */
export const DIVERSITY_TEMPERATURE = 0.5;

const SYSTEM_PROMPT =
  'You are a strict verification judge. You are given a goal, a rubric, and a code diff. ' +
  'Evaluate whether the diff satisfies the rubric for the goal. ' +
  'Respond with ONLY a single JSON object and no other text, matching exactly: ' +
  '{ "pass": boolean, "confidence": number, "failing_criteria": string[] }. ' +
  'confidence is a number in [0,1]. failing_criteria MUST be empty if and only if pass is true. ' +
  'Do not include markdown fences, explanations, or any surrounding prose. ' +
  UNTRUSTED_SYSTEM_CLAUSE;

/**
 * LLM quorum verifier. Calls the model `quorum` times, tolerantly parses each response,
 * majority-votes on pass, and applies a confidence floor. A multi-sample quorum samples at a
 * small diversity temperature so best-of-N actually reduces variance rather than re-rolling
 * the same near-deterministic answer; a single-sample quorum stays at temperature 0. Fail-closed:
 * zero parseable samples → a red verdict, never a green from a malformed grader.
 */
export class JudgeVerifier implements Verifier {
  readonly #rubric: string;
  readonly #quorum: number;
  readonly #confidenceFloor: number;
  readonly #llm: LlmProvider;
  readonly #diversityTemperature: number;

  constructor(opts: JudgeOpts) {
    this.#rubric = opts.rubric;
    this.#quorum = opts.quorum;
    this.#confidenceFloor = opts.confidenceFloor;
    this.#llm = opts.llm;
    this.#diversityTemperature = opts.diversityTemperature ?? DIVERSITY_TEMPERATURE;
  }

  async verify(workspace: Workspace, goal: string, _rubric: string): Promise<Verdict> {
    const diff = await workspace.diff();
    const prompt = this.#buildPrompt(goal, diff);

    // A single call wants maximal stability (temp 0); a quorum wants its samples to actually differ.
    const temperature = this.#quorum > 1 ? this.#diversityTemperature : 0;

    const samples: JudgeOutput[] = [];
    for (let i = 0; i < this.#quorum; i += 1) {
      // Each sample is individually guarded: one thrown/timed-out call drops THAT sample only,
      // exactly like an unparseable one — it must never discard the sibling samples that already
      // succeeded (a quorum exists to absorb precisely this kind of partial failure). Zero
      // surviving samples still fall through to the fail-closed unevaluable red below.
      let raw: string;
      try {
        ({ text: raw } = await this.#llm.complete({
          system: SYSTEM_PROMPT,
          prompt,
          temperature,
        }));
      } catch {
        continue;
      }
      const extracted = extractJson(raw);
      if (extracted === null) continue;
      const parsed = JudgeOutput.safeParse(extracted);
      if (parsed.success) samples.push(parsed.data);
    }

    if (samples.length === 0) {
      // Could-not-EVALUATE, not a genuine red: every sample errored, was empty, overflowed the
      // model's context ("prompt too long"), or returned unparseable output. Still fail-closed
      // (`pass: false`) — but flagged unevaluable so a persistent judge-can't-run surfaces as
      // CONTRACT_UNEVALUABLE rather than being mistaken for "the diff fails the rubric".
      return {
        pass: false,
        confidence: 0,
        detail: 'judge produced no parseable verdicts (the judge could not be evaluated)',
        evaluable: false,
      };
    }

    const passCount = samples.filter((s) => s.pass).length;
    const majorityPass = passCount * 2 > samples.length;
    const avgConfidence =
      samples.reduce((sum, s) => sum + s.confidence, 0) / samples.length;

    const meetsFloor = avgConfidence >= this.#confidenceFloor;
    const finalPass = majorityPass && meetsFloor;

    if (finalPass) {
      return { pass: true, confidence: avgConfidence, detail: 'judge quorum passed' };
    }

    if (majorityPass && !meetsFloor) {
      return { pass: false, confidence: avgConfidence, detail: 'confidence below floor' };
    }

    const failing = dedupe(samples.flatMap((s) => s.failing_criteria));
    const detail =
      failing.length > 0 ? failing.join('; ') : 'judge quorum failed';
    return { pass: false, confidence: avgConfidence, detail };
  }

  #buildPrompt(goal: string, diff: string): string {
    return [
      `GOAL:\n${goal}`,
      `RUBRIC:\n${this.#rubric}`,
      `DIFF:\n${wrapUntrusted(diff, { label: 'DIFF' })}`,
      'Return ONLY the JSON verdict described in the system instructions.',
    ].join('\n\n');
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
