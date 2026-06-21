import type { TokenUsage, UsageReport } from '../domain/usage';
import type { CostView } from './cost';

/** Group an integer with thousands separators, deterministically (no locale). */
function group(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Human text for one layer's token spend, surfacing unknowns rather than implying a zero. */
function tokensText(layer: TokenUsage): string {
  if (layer.calls === 0) return '0 tokens';
  if (layer.unknownCalls === 0) return `${group(layer.tokens)} tokens`;
  if (layer.tokens === 0) return `unknown (${layer.unknownCalls} call(s) reported no usage)`;
  return `${group(layer.tokens)}+ tokens (${layer.unknownCalls} call(s) without usage)`;
}

/**
 * Render the per-run spend summary (issue #17): the token breakdown by layer — the harness vs. the
 * LLM steps (compiler / judge / approver) — plus consumption vs. any `--budget-tokens` cap. An
 * optional `cost` overlay appends an approximate USD figure per priced layer (and marks the total
 * `+` when some model was unpriced). Shared by the end-of-run outcome and `goaly runs show`.
 */
export function formatUsage(u: UsageReport, cost?: CostView): string[] {
  const row = (label: string, layer: TokenUsage, layerCost: number | undefined): string => {
    let line = `  ${label.padEnd(13)}${tokensText(layer)}`;
    if (layerCost !== undefined) line += `  ≈ ${usd(layerCost)}`;
    return line;
  };

  const lines = ['spend:'];
  lines.push(row('harness', u.harness, cost?.harness));
  lines.push(row('compiler', u.compiler, cost?.compiler));
  lines.push(row('verifier', u.verifier, cost?.verifier));
  lines.push(row('approver', u.approver, cost?.approver));
  lines.push(row('llm subtotal', u.llm, cost?.llm));

  let totalLine = `  ${'total'.padEnd(13)}${tokensText(u.total)}`;
  if (cost !== undefined) {
    totalLine += `  ≈ ${usd(cost.total)}${cost.partial ? '+ (some models unpriced)' : ''}`;
  }
  lines.push(totalLine);

  if (u.budget.tokens !== undefined) {
    const pct = Math.round((u.budget.spent / u.budget.tokens) * 100);
    const flag = u.budget.exceeded ? ' — budget exceeded' : '';
    lines.push(
      `budget:      ${group(u.budget.spent)} / ${group(u.budget.tokens)} tokens (${pct}%)${flag}`,
    );
  }

  return lines;
}
