import { z } from 'zod';
import type { TokenUsage, UsageReport } from '../domain/usage';
import type { ResolvedModels } from './models';

/**
 * A price table: model name → USD per 1,000,000 tokens. The special key `default` prices any model
 * not otherwise listed (and is the only way to price a run that left models at the tool default,
 * since those resolve to `undefined`). Pricing is volatile, so it lives ONLY here — supplied by the
 * `--cost-table` flag and applied as a PRINT-TIME overlay; it is never written to the run log, which
 * stays tokens-only so a stale price can never poison a stored summary (issue #17).
 */
export const PriceTable = z.record(z.string(), z.number().nonnegative());
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

function rateFor(table: PriceTable, model: string | undefined): number | undefined {
  if (model !== undefined && table[model] !== undefined) return table[model];
  return table[DEFAULT_PRICE_KEY];
}

function layerCost(
  layer: TokenUsage,
  model: string | undefined,
  table: PriceTable,
): number | undefined {
  const rate = rateFor(table, model);
  if (rate === undefined) return undefined;
  return (layer.tokens / 1_000_000) * rate;
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

  const llmLayers = [
    { tokens: usage.compiler.tokens, cost: compiler },
    { tokens: usage.verifier.tokens, cost: verifier },
    { tokens: usage.approver.tokens, cost: approver },
  ];
  const unpriced = (t: number, c: number | undefined): boolean => t > 0 && c === undefined;
  const partial =
    unpriced(usage.harness.tokens, harness) ||
    llmLayers.some((l) => unpriced(l.tokens, l.cost));
  const llm = llmLayers.reduce((acc, l) => acc + (l.cost ?? 0), 0);
  const total = (harness ?? 0) + llm;

  return {
    ...(harness !== undefined ? { harness } : {}),
    ...(compiler !== undefined ? { compiler } : {}),
    ...(verifier !== undefined ? { verifier } : {}),
    ...(approver !== undefined ? { approver } : {}),
    llm,
    total,
    partial,
  };
}
