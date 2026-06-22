import { z } from 'zod';

/**
 * Per-category token counts for ONE call or layer, mirroring the categories a modern provider
 * reports and — crucially — PRICES DIFFERENTLY (Anthropic: output ≈ 5× input, cache-read ≈ 0.1×,
 * cache-write ≈ 1.25×). Every field is optional and fail-closed: an absent category is "unknown",
 * never a silent zero. `cacheRead`/`cacheWrite` are the cache-hit / cache-creation INPUT tokens that
 * the old `input + output` math dropped on the floor — for cache-heavy providers (Claude) they are
 * the majority of real throughput, so excluding them made `tokens` (and the `--budget-tokens` guard)
 * a gross undercount. Carried alongside the flat `tokens` total so the cost overlay can apply a rate
 * per category instead of one blended rate.
 */
export const TokenBreakdown = z.object({
  /** Uncached input (prompt) tokens — Anthropic `input_tokens`. */
  input: z.number().int().nonnegative().optional(),
  /** Generated output tokens — `output_tokens`. */
  output: z.number().int().nonnegative().optional(),
  /** Cache-HIT input tokens (cheap) — `cache_read_input_tokens`. */
  cacheRead: z.number().int().nonnegative().optional(),
  /** Cache-CREATION input tokens (slightly dearer than input) — `cache_creation_input_tokens`. */
  cacheWrite: z.number().int().nonnegative().optional(),
});
export type TokenBreakdown = z.infer<typeof TokenBreakdown>;

/** The four categories, in display/iteration order. */
export const TOKEN_CATEGORIES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

/**
 * All-inclusive billable total of a breakdown — the sum of EVERY present category (input + output +
 * cacheRead + cacheWrite). `undefined` when no category was reported, so "nothing reported" stays
 * distinct from "0 tokens" (fail-closed). This is the number the budget guard and the per-run report
 * should use; the historical `input + output` sum understated cache-heavy runs.
 */
export function breakdownTotal(b: TokenBreakdown): number | undefined {
  const present = TOKEN_CATEGORIES.map((c) => b[c]).filter((v): v is number => v !== undefined);
  return present.length === 0 ? undefined : present.reduce((a, v) => a + v, 0);
}

/** Sum two breakdowns category-by-category; a category present in either side carries through. */
export function addBreakdown(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  const out: TokenBreakdown = {};
  for (const c of TOKEN_CATEGORIES) {
    const sum = (a[c] ?? 0) + (b[c] ?? 0);
    if (a[c] !== undefined || b[c] !== undefined) out[c] = sum;
  }
  return out;
}

/** True when no category carries a value — used to omit an empty breakdown from a report. */
export function isEmptyBreakdown(b: TokenBreakdown): boolean {
  return TOKEN_CATEGORIES.every((c) => b[c] === undefined);
}

/**
 * Token spend attributed to one layer of a run. A "call" is one unit of work that could spend
 * tokens — a single harness run, or a single LLM completion (the judge makes `quorum` of them).
 * `tokens` sums only the calls that reported usage; `unknownCalls` counts the rest, so the report
 * can degrade missing data to "unknown" instead of silently pretending it was zero (fail-closed).
 */
export const TokenUsage = z.object({
  /** Sum of the token counts (reported AND estimated — see `estimatedTokens`). */
  tokens: z.number().int().nonnegative(),
  /** Number of token-spending calls this layer made. */
  calls: z.number().int().nonnegative(),
  /** Calls that completed without reporting any token usage (their tokens are unknown). */
  unknownCalls: z.number().int().nonnegative(),
  /**
   * The portion of `tokens` that came from a LOCAL ESTIMATE rather than a provider self-report
   * (issue #24) — a quiet, streamed call counted from its turns instead of a missing `usage` block.
   * Omitted when nothing was estimated, so a fully self-reported layer stays a plain `{tokens,
   * calls, unknownCalls}`. Surfaced in the report so an approximate figure reads as approximate.
   */
  estimatedTokens: z.number().int().nonnegative().optional(),
  /**
   * Per-category split of the REPORTED portion of `tokens` (issue: per-category accounting). Summed
   * across the layer's calls; omitted when no call reported a category split (an estimate has none).
   * `breakdownTotal(breakdown)` may be LESS than `tokens` when some calls reported only a flat count
   * — the cost overlay prices the split categories per-rate and the remainder at the default rate.
   */
  breakdown: TokenBreakdown.optional(),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

/**
 * Per-run spend summary, derived by folding the (write-ahead) event log — so it is identical on a
 * fresh run and after `--resume`, and a future `runs show` can rebuild it from the log alone. The
 * breakdown is by layer: the **harness** (the coding agent) vs. the **LLM steps** (compiler, the
 * judge rung of the verifier, and the Gate-B approver). Cost is deliberately NOT stored here —
 * pricing is volatile and applied as a print-time overlay (see the `--cost-table` flag).
 */
export const UsageReport = z.object({
  /** The coding-agent harness (one call per agent iteration). */
  harness: TokenUsage,
  /** The verification compiler (LLM authoring; skipped for an existing-command contract). */
  compiler: TokenUsage,
  /** The LLM-judge rung of the verifier ladder (deterministic rungs spend nothing). */
  verifier: TokenUsage,
  /** The Gate-B approver. */
  approver: TokenUsage,
  /** compiler + verifier + approver. */
  llm: TokenUsage,
  /** harness + llm. */
  total: TokenUsage,
  budget: z.object({
    /** The configured `--budget-tokens` cap, if any. */
    tokens: z.number().int().positive().optional(),
    /** Total reported tokens spent (equals `total.tokens`). */
    spent: z.number().int().nonnegative(),
    /** True only when a cap is set and `spent` reached it. */
    exceeded: z.boolean(),
  }),
});
export type UsageReport = z.infer<typeof UsageReport>;
