import { z } from 'zod';

/**
 * Token spend attributed to one layer of a run. A "call" is one unit of work that could spend
 * tokens — a single harness run, or a single LLM completion (the judge makes `quorum` of them).
 * `tokens` sums only the calls that reported usage; `unknownCalls` counts the rest, so the report
 * can degrade missing data to "unknown" instead of silently pretending it was zero (fail-closed).
 */
export const TokenUsage = z.object({
  /** Sum of the token counts that were actually reported. */
  tokens: z.number().int().nonnegative(),
  /** Number of token-spending calls this layer made. */
  calls: z.number().int().nonnegative(),
  /** Calls that completed without reporting any token usage (their tokens are unknown). */
  unknownCalls: z.number().int().nonnegative(),
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
