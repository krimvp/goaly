import { z } from 'zod';
import type { Verdict } from '../domain/verdict';
import type { FetchLike } from '../llm-client/openai-client';
import { errorMessage } from '../util/errors';
import type { Workspace } from '../workspace/workspace';
import type { Verifier } from './verifier';

export const SYSTEMONE_URL = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 15_000;
/** One retry on a back-off status, after this wait. */
const RETRY_STATUSES = new Set([429, 529]);
const RETRY_WAIT_MS = 1000;
/** The diff is the evidence; cap it like the compiler caps an evidence file so a huge tree cannot blow the call. */
const MAX_EVIDENCE_CHARS = 8000;
/** A criterion holds above this — the decision point of a calibrated true/false probability. */
const PASS_THRESHOLD = 0.5;

const Answer = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const Response = z.object({
  model: z.string(),
  answers: z.record(z.string(), Answer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export type SystemOneOpts = {
  /** The System One model id (`--systemone-model`). */
  model: string;
  /** Bearer token from `TYPESAFE_API_KEY`, read at the composition edge; absent ⇒ unevaluable. */
  apiKey?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
};

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Split a rubric into its criteria: one per non-empty line, bullet and number prefixes stripped.
 * A one-line rubric is one criterion.
 */
export function splitCriteria(rubric: string): string[] {
  return rubric
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .filter((line) => line.length > 0);
}

/**
 * A cheap first gate before the LLM judge rung: every rubric criterion becomes one calibrated
 * true/false question over the same evidence the judge reads (the diff). Built into the ladder by
 * `--systemone-model` (the guard/refuter precedent: never part of `contractHash`); it can only FAIL
 * a green — the judge still runs on its pass. Fail-closed: no key, an HTTP error, a timeout, a
 * malformed or incomplete answer all yield a could-not-evaluate red, never a green, never a throw.
 */
export class SystemOneVerifier implements Verifier {
  readonly #rubric: string;
  readonly #model: string;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(opts: SystemOneOpts & { rubric: string }) {
    this.#rubric = opts.rubric;
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#sleep = opts.sleep ?? realSleep;
  }

  async verify(workspace: Workspace, goal: string, _rubric: string): Promise<Verdict> {
    if (this.#apiKey === undefined) return unevaluable('TYPESAFE_API_KEY is not set');
    const criteria = splitCriteria(this.#rubric);
    if (criteria.length === 0) return unevaluable('the rubric has no criteria');

    const evidence = (await workspace.diff()).slice(0, MAX_EVIDENCE_CHARS);
    const body = JSON.stringify({
      model: this.#model,
      state: { goal, rubric: this.#rubric, evidence },
      questions: Object.fromEntries(
        criteria.map((criterion, i) => [
          `c${i + 1}`,
          {
            type: 'noul',
            instructions: `The workspace evidence shows that this criterion holds: ${criterion}`,
            criteria: {
              true: 'the workspace evidence shows the criterion holds',
              false: 'the evidence does not show it, or it cannot be verified from the evidence',
            },
          },
        ]),
      ),
    });

    let response: z.infer<typeof Response>;
    try {
      response = await this.#post(body);
    } catch (e) {
      return unevaluable(errorMessage(e));
    }

    const scored: Array<{ criterion: string; p: number }> = [];
    for (const [i, criterion] of criteria.entries()) {
      const answer = response.answers[`c${i + 1}`];
      if (answer === undefined) return unevaluable(`no answer for criterion ${i + 1}`);
      scored.push({ criterion, p: answer.noul });
    }
    const failing = scored.filter((s) => s.p <= PASS_THRESHOLD);
    const passing = scored.filter((s) => s.p > PASS_THRESHOLD);
    const usage =
      response.usage === undefined
        ? ''
        : `, ${response.usage.input_tokens} in / ${response.usage.output_tokens} out`;
    const lines = [
      `systemone ${response.model}${usage}: ${failing.length} of ${scored.length} criteria fail`,
      ...failing.map((s) => `FAIL (p=${s.p.toFixed(2)}): ${s.criterion}`),
      ...passing.map((s) => `ok (p=${s.p.toFixed(2)}): ${s.criterion}`),
    ];
    return {
      pass: failing.length === 0,
      confidence: Math.min(...scored.map((s) => s.p)),
      detail: lines.join('\n'),
    };
  }

  async #post(body: string): Promise<z.infer<typeof Response>> {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let status: number;
      let text: string;
      try {
        const res = await this.#fetch(SYSTEMONE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
          body,
          signal: controller.signal,
        });
        status = res.status;
        text = await res.text();
      } finally {
        clearTimeout(timer);
      }
      if (RETRY_STATUSES.has(status) && attempt === 0) {
        await this.#sleep(RETRY_WAIT_MS);
        continue;
      }
      if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 300)}`);
      const parsed = Response.safeParse(JSON.parse(text));
      if (!parsed.success) throw new Error(`malformed answer: ${parsed.error.issues[0]?.message}`);
      return parsed.data;
    }
  }
}

function unevaluable(reason: string): Verdict {
  return { pass: false, confidence: 0, detail: `systemone could not evaluate: ${reason}`, evaluable: false };
}
