import type { OrchestratorEvent } from '../domain/events';
import type { BudgetConfig } from '../domain/config';
import type { TokenUsage, UsageReport } from '../domain/usage';

/**
 * Fold the (write-ahead) event stream into a per-run spend summary (issue #17). PURE — it is a
 * read-model projection, NOT part of the reducer, so the Driver may call it after the loop and a
 * future `runs show` can rebuild the same report from the log alone. Token data is summed where
 * present and counted as "unknown" where absent (fail-closed: a missing count is never a silent
 * zero). The frozen `--budget-tokens` cap comes from the run's config.
 */
export function summarizeUsage(events: OrchestratorEvent[], budget: BudgetConfig): UsageReport {
  const harness = empty();
  const compiler = empty();
  const verifier = empty();
  const approver = empty();

  for (const event of events) {
    switch (event.tag) {
      case 'AGENT_RAN':
        addHarnessCall(harness, event.run.tokensUsed);
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
    harness,
    compiler,
    verifier,
    approver,
    llm,
    total,
    budget: {
      ...(cap !== undefined ? { tokens: cap } : {}),
      spent: total.tokens,
      exceeded: cap !== undefined && total.tokens >= cap,
    },
  };
}

function empty(): TokenUsage {
  return { tokens: 0, calls: 0, unknownCalls: 0 };
}

/** One harness run is one call; a missing `tokensUsed` means its spend is unknown. */
function addHarnessCall(layer: TokenUsage, tokensUsed: number | undefined): void {
  layer.calls += 1;
  if (tokensUsed !== undefined) layer.tokens += tokensUsed;
  else layer.unknownCalls += 1;
}

/** An absent `usage` means the step made no LLM call (so it adds nothing — not even a call). */
function addLlmStep(layer: TokenUsage, usage: TokenUsage | undefined): void {
  if (usage === undefined) return;
  layer.tokens += usage.tokens;
  layer.calls += usage.calls;
  layer.unknownCalls += usage.unknownCalls;
}

function merge(...layers: TokenUsage[]): TokenUsage {
  return layers.reduce((acc, l) => {
    acc.tokens += l.tokens;
    acc.calls += l.calls;
    acc.unknownCalls += l.unknownCalls;
    return acc;
  }, empty());
}
