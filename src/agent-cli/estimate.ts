/**
 * Local token ESTIMATION — the fallback for when a harness run or an LLM step streams its turns
 * (issue #23) but never self-reports `usage` (issue #24). A quiet tool would otherwise read as ZERO
 * spend, silently under-counting the budget; a coarse estimate from the streamed content is far
 * closer to the truth and lets the `--budget-tokens` cap and the per-run report mean something even
 * when the provider does not hand back a count.
 *
 * Deliberately DEPENDENCY-FREE: a ~4-characters-per-token heuristic, not a per-model tokenizer. A
 * budget GUARD and a cost ESTIMATE do not need exact server-side accounting, and a real tokenizer
 * (tiktoken/o200k) is a heavy dependency for a best-effort fallback. The result is always marked
 * `estimated` (vs a provider's `reported`) so the distinction stays visible downstream. Pure, total,
 * and never throws — observability/measurement must never alter a run's outcome.
 */

import type { AgentEventSink, AgentStreamEvent } from './stream';

/** The heuristic divisor: roughly four characters per token for English + code (cl100k/o200k-ish). */
export const CHARS_PER_TOKEN = 4;

/** Coarse token count for a string: `ceil(chars / 4)`. Empty string → 0. Never throws. */
export function estimateTokens(text: string): number {
  const n = text.length;
  return n === 0 ? 0 : Math.ceil(n / CHARS_PER_TOKEN);
}

/** The token-accounting fields shared by a harness result and an LLM completion. */
export type TokenAccounting = {
  tokensUsed?: number;
  /** `reported` = the provider's own count; `estimated` = our local fallback. Absent = no count. */
  tokenSource?: 'reported' | 'estimated';
};

/**
 * Resolve the token count for one call, preferring a provider self-report over the local estimate
 * (so we never double-count, and never override a real number with a guess). Returns the bare
 * fields to spread into a `HarnessRunResult` / `LlmCompletion`:
 *   - a present `reported` count   → `{ tokensUsed, tokenSource: 'reported' }`
 *   - no report, but a positive estimate from the streamed turns → `{ tokensUsed, tokenSource: 'estimated' }`
 *   - neither → `{}` (the spend stays genuinely "unknown", never a silent zero).
 */
export function accountTokens(
  reported: number | undefined,
  estimator?: StreamTokenEstimator,
): TokenAccounting {
  if (reported !== undefined) return { tokensUsed: reported, tokenSource: 'reported' };
  if (estimator !== undefined && estimator.observed()) {
    const est = estimator.estimate();
    if (est > 0) return { tokensUsed: est, tokenSource: 'estimated' };
  }
  return {};
}

/**
 * Accumulates a local token estimate from the canonical {@link AgentStreamEvent} stream. Counts the
 * content that actually flows through the model — assistant `message` + `reasoning` text, `tool_use`
 * inputs (and the tool name), and `tool_result` outputs. A reported `usage` event is NOT counted
 * here: a real self-report is preferred and handled by {@link accountTokens}, so the estimate is the
 * pure fallback and the two never double-count. Feed every streamed event via {@link observe}; read
 * {@link estimate} once after the stream ends.
 */
export class StreamTokenEstimator {
  #chars = 0;
  #observed = false;

  /** Fold one streamed event into the running estimate. Total and side-effect-free; never throws. */
  observe(event: AgentStreamEvent): void {
    switch (event.kind) {
      case 'message':
        // Skip incremental deltas: a tool that streams partials (codex's `assistant.delta`) also
        // emits the consolidated full message on completion, so counting both would ~double the
        // estimate. The full message (`delta` unset) is the canonical complete text.
        if (event.delta === true) return;
        this.#add(event.text);
        return;
      case 'reasoning':
        this.#add(event.text);
        return;
      case 'tool_use':
        this.#add(event.name);
        this.#add(stringifyInput(event.input));
        return;
      case 'tool_result':
        this.#add(event.output);
        return;
      default:
        return; // session / usage / done carry no estimatable content
    }
  }

  #add(text: string): void {
    if (text.length === 0) return;
    this.#chars += text.length;
    this.#observed = true;
  }

  /** True once any estimatable content was seen — keeps "nothing streamed" distinct from "0 tokens". */
  observed(): boolean {
    return this.#observed;
  }

  /** The accumulated estimate so far (`ceil(chars / 4)`); 0 when nothing estimatable was streamed. */
  estimate(): number {
    return this.#chars === 0 ? 0 : Math.ceil(this.#chars / CHARS_PER_TOKEN);
  }
}

/**
 * Wire local token estimation (issue #24) onto a harness/provider's stream sink in one step: given
 * the caller's optional `onEvent`, return the `sink` to feed a {@link StreamTap} (it tees every event
 * into the estimator BEFORE forwarding, so a throwing consumer never costs the estimate) and the
 * `estimator` to pass to {@link accountTokens}. When `onEvent` is absent the seam is not streaming,
 * so both are `undefined` and the lean (self-reporting) envelope is used unchanged. A single helper
 * keeps every adapter/provider's estimation wiring identical — see `docs/adding-a-harness.md`.
 */
export function streamingEstimator(onEvent: AgentEventSink | undefined): {
  sink: AgentEventSink | undefined;
  estimator: StreamTokenEstimator | undefined;
} {
  if (onEvent === undefined) return { sink: undefined, estimator: undefined };
  const estimator = new StreamTokenEstimator();
  const sink: AgentEventSink = (event) => {
    estimator.observe(event);
    onEvent(event);
  };
  return { sink, estimator };
}

/** Render a `tool_use` input (string, object, or absent) to text for estimation. Never throws. */
function stringifyInput(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return '';
  }
}
