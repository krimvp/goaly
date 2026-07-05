import { CritiqueOutput } from '../domain/critique';
import { extractJson } from '../util/json-extract';
import type { LlmProvider } from './provider';

/**
 * The temperature a multi-critic panel samples at, mirroring `DIVERSITY_TEMPERATURE` in `judge.ts`
 * and `agent-approver.ts`: N near-deterministic critics would re-roll the same answer, so a panel
 * only buys perspective spread when its members actually differ. A single critic stays at 0.
 */
export const CRITIC_DIVERSITY_TEMPERATURE = 0.5;

export type CriticPanelOpts = {
  llm: LlmProvider;
  /** Panel-constant system prompt; each critic's lens rides its prompt tail (like the approver's `withLens`). */
  system: string;
  prompt: string;
  /** Lens taxonomy cycled across the panel (`i % lenses.length`); empty ⇒ bare critics. */
  lenses: readonly string[];
  /** Panel size. `0` (or negative) runs no critics and returns `[]`. */
  count: number;
  /** Override for the `count > 1` sampling temperature; default {@link CRITIC_DIVERSITY_TEMPERATURE}. */
  diversityTemperature?: number;
};

/**
 * Run a lensed adversarial critic panel and return the parseable outputs. This is ADVISORY
 * pre-Seal machinery — a critic that throws, times out, or returns unparseable output is DROPPED
 * (never invented as a finding, never blocks anything): dropping a critic can only mean fewer
 * revise rounds, and the plan/contract Seal gate still stands behind it. That is the fail-open
 * carve-out the one-time prepare phase already has; the fail-CLOSED adversarial steps (refuter
 * rung, approver) do their own vote accounting instead of using this helper.
 */
export async function runCriticPanel(opts: CriticPanelOpts): Promise<CritiqueOutput[]> {
  const count = Math.trunc(opts.count);
  if (count <= 0) return [];
  const temperature =
    count > 1 ? (opts.diversityTemperature ?? CRITIC_DIVERSITY_TEMPERATURE) : 0;

  const outputs: CritiqueOutput[] = [];
  for (let i = 0; i < count; i += 1) {
    const lens = opts.lenses.length > 0 ? opts.lenses[i % opts.lenses.length] : undefined;
    // The lens rides the TAIL of the user prompt (see `withLens` in agent-approver.ts): a
    // panel-constant system + shared prompt prefix means critic 1 cache-writes the request and
    // critics 2..N cache-read it; a per-critic system would defeat prefix caching entirely.
    const prompt =
      lens === undefined || lens.trim().length === 0
        ? opts.prompt
        : `${opts.prompt}\n\nREVIEW LENS (operator instruction) — focus especially on: ${lens}`;
    let raw: string;
    try {
      ({ text: raw } = await opts.llm.complete({ system: opts.system, prompt, temperature }));
    } catch {
      continue;
    }
    const parsed = CritiqueOutput.safeParse(extractJson(raw));
    if (parsed.success) outputs.push(parsed.data);
  }
  return outputs;
}
