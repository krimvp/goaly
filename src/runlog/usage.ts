import type { OrchestratorEvent } from '../domain/events';
import type { BudgetConfig } from '../domain/config';
import type { TokenUsage, UsageReport } from '../domain/usage';

/**
 * Fold the (write-ahead) event stream into a per-run spend summary (issue #17). PURE — it is a
 * read-model projection, NOT part of the reducer, so the Driver may call it after the loop and a
 * future `runs show` can rebuild the same report from the log alone. Token data is summed where
 * present and counted as "unknown" where absent (fail-closed: a missing count is never a silent
 * zero). The ESTIMATED portion (issue #24) — counts derived from a streamed turn when the provider
 * reported none — is carried alongside so the report can mark approximate figures. The frozen
 * `--budget-tokens` cap comes from the run's config.
 */
export function summarizeUsage(events: OrchestratorEvent[], budget: BudgetConfig): UsageReport {
  const harness = acc();
  const compiler = acc();
  const verifier = acc();
  const approver = acc();

  for (const event of events) {
    switch (event.tag) {
      case 'AGENT_RAN':
        addHarnessCall(harness, event.run.tokensUsed, event.run.tokenSource === 'estimated');
        break;
      case 'CONTRACT_COMPILED':
      case 'COMPILE_FAILED':
        addLlmStep(compiler, event.llm);
        break;
      case 'VERIFIED':
        addLlmStep(verifier, event.llm);
        break;
      case 'GATE_B_DECIDED':
        addLlmStep(approver, event.llm);
        break;
    }
  }

  const llm = merge(compiler, verifier, approver);
  const total = merge(harness, llm);
  const cap = budget.tokens;
  return {
    harness: fin(harness),
    compiler: fin(compiler),
    verifier: fin(verifier),
    approver: fin(approver),
    llm: fin(llm),
    total: fin(total),
    budget: {
      ...(cap !== undefined ? { tokens: cap } : {}),
      spent: total.tokens,
      exceeded: cap !== undefined && total.tokens >= cap,
    },
  };
}

/** Internal mutable accumulator (estimatedTokens always present; omitted from the output when 0). */
type Acc = { tokens: number; calls: number; unknownCalls: number; estimatedTokens: number };

function acc(): Acc {
  return { tokens: 0, calls: 0, unknownCalls: 0, estimatedTokens: 0 };
}

/** Finalize an accumulator into a `TokenUsage`, omitting `estimatedTokens` when nothing was estimated. */
function fin(a: Acc): TokenUsage {
  return {
    tokens: a.tokens,
    calls: a.calls,
    unknownCalls: a.unknownCalls,
    ...(a.estimatedTokens > 0 ? { estimatedTokens: a.estimatedTokens } : {}),
  };
}

/** One harness run is one call; a missing `tokensUsed` means its spend is unknown. */
function addHarnessCall(layer: Acc, tokensUsed: number | undefined, estimated: boolean): void {
  layer.calls += 1;
  if (tokensUsed !== undefined) {
    layer.tokens += tokensUsed;
    if (estimated) layer.estimatedTokens += tokensUsed;
  } else layer.unknownCalls += 1;
}

/** An absent `usage` means the step made no LLM call (so it adds nothing — not even a call). */
function addLlmStep(layer: Acc, usage: TokenUsage | undefined): void {
  if (usage === undefined) return;
  layer.tokens += usage.tokens;
  layer.calls += usage.calls;
  layer.unknownCalls += usage.unknownCalls;
  layer.estimatedTokens += usage.estimatedTokens ?? 0;
}

function merge(...layers: Acc[]): Acc {
  return layers.reduce((sum, l) => {
    sum.tokens += l.tokens;
    sum.calls += l.calls;
    sum.unknownCalls += l.unknownCalls;
    sum.estimatedTokens += l.estimatedTokens;
    return sum;
  }, acc());
}
