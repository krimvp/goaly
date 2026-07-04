import { RefuterVote } from '../domain/critique';
import type { Verdict } from '../domain/verdict';
import { extractJson } from '../util/json-extract';
import type { LlmProvider } from '../llm/provider';
import type { Workspace } from '../workspace/workspace';
import { UNTRUSTED_SYSTEM_CLAUSE, wrapUntrusted } from './prompt-safety';
import type { Verifier } from './verifier';

const SYSTEM_PROMPT =
  'You are an independent skeptic in an automated goal-orchestration loop. The frozen verifier ' +
  'ladder has just declared this iteration GREEN. Your ONLY job is to try to REFUTE that green: ' +
  'find concrete evidence in the diff that the goal is not genuinely met — hard-coded or ' +
  'special-cased outputs shaped to the checked inputs, tests that do not exercise the real ' +
  'behavior, a partial implementation behind a passing facade, deleted or weakened checks, or ' +
  'output crafted to satisfy a grader rather than to work. You can only turn a green into a red; ' +
  'you can never make anything pass. If you cannot point at concrete refuting evidence, say so ' +
  'honestly; when genuinely uncertain, refute — a false green ends the run wrongly, a false red ' +
  'costs one more iteration. Respond with ONLY a single JSON object, no prose, no markdown ' +
  'fences, matching exactly: { "refuted": boolean, "confidence": number, "reason"?: string }. ' +
  'confidence is in [0,1]; a refutation MUST carry a non-empty reason. ' +
  UNTRUSTED_SYSTEM_CLAUSE;

/** The refuter lens taxonomy, cycled across the votes. */
export const REFUTER_LENSES: readonly string[] = [
  'CORRECTNESS — is the goal genuinely implemented, including edge cases, or does the change ' +
    'merely satisfy the specific inputs/assertions the ladder happens to check?',
  'GAMING — was the bar gamed: hard-coded expected outputs, stubs shaped to the grader, weakened ' +
    'or bypassed checks, work moved outside what the ladder measures?',
  'REPRODUCIBILITY — would this green hold on a clean re-run: does it depend on leftover state, ' +
    'timing, the network, or anything the frozen bar cannot see?',
];

/** Mirrors the judge/approver panels' diversity sampling (see `DIVERSITY_TEMPERATURE` there). */
const DIVERSITY_TEMPERATURE = 0.5;

export type AdversarialReviewRungOpts = {
  llm: LlmProvider;
  /** Number of refuter votes. The caller only builds the rung when `> 0`. */
  refuters: number;
  /** Sampling temperature for a `> 1` panel; a single refuter stays at 0. */
  diversityTemperature?: number;
};

/**
 * The verify-time adversarial rung (`--adversarial`) — a BUILT-IN {@link Verifier} appended AFTER
 * every frozen rung (the `GeneratedFilesGuard` precedent: part of the ladder, never part of
 * `contractHash`). The ladder's short-circuit means it runs ONLY when the whole frozen bar is
 * already green, so its LLM spend occurs only on candidate greens — and structurally it can only
 * pass that green through or FAIL it, never promote anything (invariant #3 is untouchable: a
 * refuted green never reaches Sign-off as a green).
 *
 * FAIL-CLOSED, never weaker than the frozen bar (invariant #4): a refuter that throws, times out,
 * or returns unparseable output COUNTS AS a refuted vote (an erroring skeptic turns green→red,
 * never red→green); the green stands only on a STRICT supermajority of parsed "could not refute"
 * votes. Zero parseable refuters ⇒ a fail-closed UNEVALUABLE red (the judge's zero-samples path):
 * a down critic model surfaces as CONTRACT_UNEVALUABLE, not as "your code is wrong".
 */
export class AdversarialReviewRung implements Verifier {
  readonly #llm: LlmProvider;
  readonly #refuters: number;
  readonly #diversityTemperature: number;

  constructor(opts: AdversarialReviewRungOpts) {
    this.#llm = opts.llm;
    this.#refuters = Math.max(1, Math.trunc(opts.refuters));
    this.#diversityTemperature = opts.diversityTemperature ?? DIVERSITY_TEMPERATURE;
  }

  async verify(workspace: Workspace, goal: string, rubric: string): Promise<Verdict> {
    const diff = await workspace.diff();
    const prompt = buildPrompt(goal, rubric, diff);
    const temperature = this.#refuters > 1 ? this.#diversityTemperature : 0;

    const votes: RefuterVote[] = [];
    let failedVotes = 0; // thrown / unparseable / schema-miss — each counts as refuted.
    for (let i = 0; i < this.#refuters; i += 1) {
      const lens = REFUTER_LENSES[i % REFUTER_LENSES.length]!;
      let raw: string;
      try {
        ({ text: raw } = await this.#llm.complete({
          system: `${SYSTEM_PROMPT} REVIEW LENS — focus especially on: ${lens}`,
          prompt,
          temperature,
        }));
      } catch {
        failedVotes += 1;
        continue;
      }
      const parsed = RefuterVote.safeParse(extractJson(raw));
      if (parsed.success) votes.push(parsed.data);
      else failedVotes += 1;
    }

    if (votes.length === 0) {
      // Could-not-EVALUATE (the judge's zero-samples path): every refuter errored or returned
      // garbage. Still fail-closed — never a green from a broken skeptic panel — but flagged
      // unevaluable so a persistent refuter-can't-run surfaces as CONTRACT_UNEVALUABLE.
      return {
        pass: false,
        confidence: 0,
        detail:
          'adversarial review produced no parseable refuter votes (the refuters could not be evaluated)',
        evaluable: false,
      };
    }

    // The green stands only on a STRICT supermajority of "could not refute" over the FULL panel:
    // every failed vote already counts against it, so a flaky refuter panel is never weaker than
    // the frozen bar it audits (mirrors the approver panel's aggregate()).
    const notRefuted = votes.filter((v) => !v.refuted).length;
    if (notRefuted * 2 > this.#refuters) {
      const confidence =
        votes.filter((v) => !v.refuted).reduce((sum, v) => sum + v.confidence, 0) / notRefuted;
      return { pass: true, confidence, detail: 'adversarial review could not refute the green' };
    }

    const reasons = dedupe(
      votes.filter((v) => v.refuted).map((v) => v.reason ?? ''),
    );
    if (failedVotes > 0) {
      reasons.push(`${failedVotes} refuter(s) failed to produce a valid vote (counted as refuted)`);
    }
    const refuted = votes.filter((v) => v.refuted);
    const confidence =
      refuted.length > 0
        ? refuted.reduce((sum, v) => sum + v.confidence, 0) / refuted.length
        : 1;
    return {
      pass: false,
      confidence,
      detail: `adversarial review refuted the green: ${reasons.join('; ')}`,
    };
  }
}

function buildPrompt(goal: string, rubric: string, diff: string): string {
  return [
    `GOAL:\n${goal}`,
    `RUBRIC (frozen):\n${rubric.length > 0 ? rubric : '(empty)'}`,
    `DIFF:\n${wrapUntrusted(diff, { label: 'DIFF' })}`,
    'The frozen ladder passed. Try to refute it. Reply with ONLY the JSON vote described in the ' +
      'system instructions.',
  ].join('\n\n');
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter((s) => s.length > 0))];
}
