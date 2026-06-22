import { z } from 'zod';
import type { TokenUsage, UsageReport, TokenBreakdown } from '../domain/usage';
import { TOKEN_CATEGORIES, breakdownTotal } from '../domain/usage';
import type { ResolvedModels } from './models';

/**
 * Per-category USD rates (per 1,000,000 tokens) for one model. Lets the overlay charge output, input
 * and the two cache buckets at their real (very different) rates — Anthropic prices output ≈ 5× input
 * and cache-read ≈ 0.1× input, so one blended rate is materially wrong for a cache-heavy run. Every
 * field optional; `default` rates any category the call reported that has no explicit rate AND any
 * spend that arrived as a flat total with no category split. A category with spend but no rate (and
 * no `default`) makes the layer `partial`.
 */
export const CategoryRates = z
  .object({
    input: z.number().nonnegative().optional(),
    output: z.number().nonnegative().optional(),
    cacheRead: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
    /** Fallback rate for un-split totals and categories without an explicit rate. */
    default: z.number().nonnegative().optional(),
  })
  .strict();
export type CategoryRates = z.infer<typeof CategoryRates>;

/** A model's price: a single blended USD-per-1M rate, OR a per-category {@link CategoryRates} map. */
export const PriceEntry = z.union([z.number().nonnegative(), CategoryRates]);
export type PriceEntry = z.infer<typeof PriceEntry>;

/**
 * A price table: model name → price. A price is either a flat USD-per-1,000,000-tokens number or a
 * per-category {@link CategoryRates} map. The special key `default` prices any model not otherwise
 * listed (and is the only way to price a run that left models at the tool default, since those
 * resolve to `undefined`). Pricing is volatile, so it lives ONLY here — supplied by the
 * `--cost-table` flag and applied as a PRINT-TIME overlay; it is never written to the run log, which
 * stays tokens-only so a stale price can never poison a stored summary (issue #17).
 */
export const PriceTable = z.record(z.string(), PriceEntry);
export type PriceTable = z.infer<typeof PriceTable>;

/** The `default` price-table key — prices any model not listed explicitly. */
export const DEFAULT_PRICE_KEY = 'default';

/** Parse a price-table JSON document, fail-closed: a malformed table is a hard error, never silent. */
export function parsePriceTable(json: string): PriceTable {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    const detail = e instanceof Error ? e.message : 'parse error';
    throw new Error(`cost table is not valid JSON: ${detail}`);
  }
  return PriceTable.parse(value);
}

/** Per-layer USD cost (undefined where the layer's model is unpriced), plus a partial flag. */
export type CostView = {
  harness?: number;
  compiler?: number;
  verifier?: number;
  approver?: number;
  /** compiler + verifier + approver (sum of the priced sub-layers). */
  llm: number;
  /** harness + llm (sum of the priced layers). */
  total: number;
  /** True when at least one layer that actually spent tokens could not be priced. */
  partial: boolean;
};

function entryFor(table: PriceTable, model: string | undefined): PriceEntry | undefined {
  if (model !== undefined && table[model] !== undefined) return table[model];
  return table[DEFAULT_PRICE_KEY];
}

const perMillion = (tokens: number, rate: number): number => (tokens / 1_000_000) * rate;

/** One layer's cost and whether any spend it had went unpriced (→ the report is partial). */
type LayerCost = { cost: number | undefined; unpriced: boolean };

/**
 * Price ONE layer. A flat-number entry charges `layer.tokens` at the blended rate. A per-category
 * entry charges each reported category (input/output/cache-read/cache-write) at its own rate — and
 * any spend that arrived only as a flat total (no split, or split summing to less than `tokens`) at
 * the `default` rate. A category (or remainder) with spend but no applicable rate is left unpriced
 * and flags the layer `partial`, so an approximate total is never silently presented as exact.
 */
function layerCost(layer: TokenUsage, model: string | undefined, table: PriceTable): LayerCost {
  if (layer.tokens === 0) return { cost: 0, unpriced: false };
  const entry = entryFor(table, model);
  if (entry === undefined) return { cost: undefined, unpriced: true };
  if (typeof entry === 'number') return { cost: perMillion(layer.tokens, entry), unpriced: false };

  // Per-category pricing.
  let cost = 0;
  let unpriced = false;
  const breakdown: TokenBreakdown = layer.breakdown ?? {};
  for (const cat of TOKEN_CATEGORIES) {
    const tokens = breakdown[cat];
    if (tokens === undefined || tokens === 0) continue;
    const rate = entry[cat] ?? entry.default;
    if (rate === undefined) unpriced = true;
    else cost += perMillion(tokens, rate);
  }
  // Spend not covered by the split (flat-total calls, or a partial split) prices at `default`.
  const remainder = layer.tokens - (breakdownTotal(breakdown) ?? 0);
  if (remainder > 0) {
    if (entry.default === undefined) unpriced = true;
    else cost += perMillion(remainder, entry.default);
  }
  return { cost, unpriced };
}

/**
 * Overlay a price table onto a token report. Each layer is priced by ITS resolved model; a layer
 * that spent tokens but has no price makes the rollups `partial` (so the renderer can mark the
 * total approximate). Layers with zero spend never make a report partial.
 */
export function computeCost(
  usage: UsageReport,
  models: ResolvedModels,
  table: PriceTable,
): CostView {
  const harness = layerCost(usage.harness, models.harness, table);
  const compiler = layerCost(usage.compiler, models.compiler, table);
  const verifier = layerCost(usage.verifier, models.judge, table);
  const approver = layerCost(usage.approver, models.approver, table);

  const llmCosts = [compiler, verifier, approver];
  const partial = harness.unpriced || llmCosts.some((c) => c.unpriced);
  const llm = llmCosts.reduce((acc, c) => acc + (c.cost ?? 0), 0);
  const total = (harness.cost ?? 0) + llm;

  return {
    ...(harness.cost !== undefined ? { harness: harness.cost } : {}),
    ...(compiler.cost !== undefined ? { compiler: compiler.cost } : {}),
    ...(verifier.cost !== undefined ? { verifier: verifier.cost } : {}),
    ...(approver.cost !== undefined ? { approver: approver.cost } : {}),
    llm,
    total,
    partial,
  };
}
