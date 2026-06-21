import { JudgeOutput, type Verdict } from '../domain/verdict';
import type { LlmProvider } from '../llm/provider';
import type { Verifier } from '../verify/verifier';
import type { Workspace } from '../workspace/workspace';

/**
 * Extract the first balanced JSON object from arbitrary text. Tolerates ```json fences,
 * surrounding log lines, and prose. Returns the parsed value or null when no balanced
 * `{...}` object yields valid JSON.
 */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          return JSON.parse(candidate) as unknown;
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

type JudgeOpts = {
  rubric: string;
  quorum: number;
  confidenceFloor: number;
  llm: LlmProvider;
};

const SYSTEM_PROMPT =
  'You are a strict verification judge. You are given a goal, a rubric, and a code diff. ' +
  'Evaluate whether the diff satisfies the rubric for the goal. ' +
  'Respond with ONLY a single JSON object and no other text, matching exactly: ' +
  '{ "pass": boolean, "confidence": number, "failing_criteria": string[] }. ' +
  'confidence is a number in [0,1]. failing_criteria MUST be empty if and only if pass is true. ' +
  'Do not include markdown fences, explanations, or any surrounding prose.';

/**
 * LLM quorum verifier. Calls the model `quorum` times at temperature 0, tolerantly parses
 * each response, majority-votes on pass, and applies a confidence floor. Fail-closed:
 * zero parseable samples → a red verdict, never a green from a malformed grader.
 */
export class JudgeVerifier implements Verifier {
  readonly #rubric: string;
  readonly #quorum: number;
  readonly #confidenceFloor: number;
  readonly #llm: LlmProvider;

  constructor(opts: JudgeOpts) {
    this.#rubric = opts.rubric;
    this.#quorum = opts.quorum;
    this.#confidenceFloor = opts.confidenceFloor;
    this.#llm = opts.llm;
  }

  async verify(workspace: Workspace, goal: string, _rubric: string): Promise<Verdict> {
    const diff = await workspace.diff();
    const prompt = this.#buildPrompt(goal, diff);

    const samples: JudgeOutput[] = [];
    for (let i = 0; i < this.#quorum; i += 1) {
      const raw = await this.#llm.complete({
        system: SYSTEM_PROMPT,
        prompt,
        temperature: 0,
      });
      const extracted = extractJson(raw);
      if (extracted === null) continue;
      const parsed = JudgeOutput.safeParse(extracted);
      if (parsed.success) samples.push(parsed.data);
    }

    if (samples.length === 0) {
      return { pass: false, confidence: 0, detail: 'judge produced no parseable verdicts' };
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
      `DIFF:\n${diff}`,
      'Return ONLY the JSON verdict described in the system instructions.',
    ].join('\n\n');
  }
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
