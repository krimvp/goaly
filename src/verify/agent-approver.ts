import { ApprovalVerdict } from '../domain/verdict';
import type { ApprovalInput } from '../domain/events';
import type { Verdict } from '../domain/verdict';
import type { Approver } from './approver';
import type { LlmProvider } from '../llm/provider';

const SYSTEM_PROMPT = [
  'You are an INDEPENDENT skeptic acting as Gate B in an automated goal-orchestration loop.',
  'You are given a goal, a frozen rubric, the working-tree diff, and the verifier verdicts.',
  'Your job is to decide whether the work is ACTUALLY done, or whether the verifier was',
  'gamed or short-circuited — empty tests, tautological assertions, partial solutions,',
  'hard-coded outputs, or checks that pass without exercising the real behavior.',
  'You can only VETO a green result; you can never promote a red one.',
  'Default to VETO whenever you are uncertain. A false green ends the run wrongly; a false',
  'red costs only one more iteration.',
  'Respond with ONLY a single JSON object of the form {"veto": boolean, "reason"?: string}.',
  'A veto MUST include a non-empty reason explaining what is missing or suspect.',
  'Do not include any prose, markdown, or code fences — JSON only.',
].join(' ');

function summarizeVerdicts(verdicts: Verdict[]): string {
  if (verdicts.length === 0) return '(no verdicts recorded)';
  return verdicts
    .map((v, i) => {
      const status = v.pass ? 'PASS' : 'FAIL';
      return `  ${i + 1}. [${status}] confidence=${v.confidence} — ${v.detail}`;
    })
    .join('\n');
}

function buildPrompt(input: ApprovalInput): string {
  return [
    `GOAL:\n${input.goal}`,
    `RUBRIC:\n${input.rubric}`,
    `VERIFIER VERDICTS:\n${summarizeVerdicts(input.verdicts)}`,
    `DIFF:\n${input.diff}`,
    'Is this ACTUALLY done, or did the verifier get gamed/short-circuited?',
    'Reply with ONLY the JSON {"veto": boolean, "reason"?: string}.',
  ].join('\n\n');
}

/**
 * Extracts the first balanced top-level JSON object from a string, tolerating leading/trailing
 * prose or code fences. Respects strings and escapes so braces inside string literals don't
 * unbalance the scan. Returns null when no balanced object is found.
 */
function extractBalancedJson(text: string): string | null {
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
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

const GENERIC_VETO_REASON =
  'approver vetoed without a reason; defaulting to veto under uncertainty';

function failClosed(detail: string): ApprovalVerdict {
  return { veto: true, reason: `approver could not produce a valid verdict: ${detail}` };
}

/**
 * Gate B (Seam #3) — an INDEPENDENT, veto-only, fail-closed approver backed by an LLM.
 * Fed independent inputs (goal + frozen rubric + diff + verdicts), never the worker's
 * self-justification. Any failure to produce a valid verdict becomes a veto.
 */
export class AgentApprover implements Approver {
  readonly #llm: LlmProvider;

  constructor(opts: { llm: LlmProvider }) {
    this.#llm = opts.llm;
  }

  async review(input: ApprovalInput): Promise<ApprovalVerdict> {
    let raw: string;
    try {
      raw = (
        await this.#llm.complete({
          system: SYSTEM_PROMPT,
          prompt: buildPrompt(input),
          temperature: 0,
        })
      ).text;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return failClosed(`llm call failed: ${message}`);
    }

    const jsonText = extractBalancedJson(raw);
    if (jsonText === null) {
      return failClosed('no JSON object found in response');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return failClosed('response was not valid JSON');
    }

    const result = ApprovalVerdict.safeParse(parsed);
    if (!result.success) {
      // A veto:true with a missing/empty reason fails the .refine — coerce to a generic veto
      // rather than failing closed with a noisier message, since the model did intend to veto.
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { veto?: unknown }).veto === true
      ) {
        return { veto: true, reason: GENERIC_VETO_REASON };
      }
      return failClosed(result.error.issues.map((e) => e.message).join('; '));
    }

    const verdict = result.data;
    if (verdict.veto && (verdict.reason === undefined || verdict.reason.length === 0)) {
      return { veto: true, reason: GENERIC_VETO_REASON };
    }
    return verdict;
  }
}
