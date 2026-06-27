/**
 * The tool-use agent loop (spec §2.3) — the contract that matters. Repeatedly: call the model; append
 * its turn; if it requested tool calls, dispatch each and feed the results back; if it returned a
 * final message or called `finish`, stop. The loop is the single most important fail-closed surface:
 *
 *   - turn cap hit                          → status `truncated`
 *   - wall-clock deadline reached           → status `timeout`
 *   - the client throws (network / 5xx / malformed envelope, after its own bounded retries)
 *                                           → status `crashed` (feeds the pure STUCK_HARNESS_CRASH detector)
 *   - a throwing/invalid tool call          → its error becomes the tool RESULT string (never a crash)
 *   - a final assistant message / `finish`  → status `completed`
 *
 * It NEVER throws: a client failure becomes a typed status, every tool failure becomes a result the
 * model can recover from. Token usage from each call's `usage` block is summed (reported), with a
 * streamed-content estimate as the fallback (issue #24). Streaming is pure observability — a throwing
 * sink can never affect the outcome.
 */

import type { HarnessRunResult } from '../domain/events';
import type { LlmClient, ChatResult } from '../llm-client/openai-client';
import type { ChatMessage } from '../llm-client/schema';
import type { AgentEventSink, AgentStreamEvent } from '../agent-cli/stream';
import { streamingEstimator, type StreamTokenEstimator } from '../agent-cli/estimate';
import {
  addBreakdown,
  breakdownTotal,
  isEmptyBreakdown,
  type TokenBreakdown,
} from '../domain/usage';
import { errorMessage } from '../util/errors';
import { dispatchTool, toApiTools, type ToolHost, type ToolSpec } from './tools';

export type LoopTokens = {
  tokensUsed?: number;
  tokenSource?: 'reported' | 'estimated';
  tokenBreakdown?: TokenBreakdown;
};

export type LoopResult = {
  output: string;
  status: HarnessRunResult['status'];
  /** The full message history after the loop — what the session store persists for resume. */
  messages: ChatMessage[];
  tokens: LoopTokens;
};

export type RunAgentLoopOptions = {
  client: LlmClient;
  model: string;
  tools: ToolSpec[];
  host: ToolHost;
  /** Initial history: `[system, user]` for a fresh run, or `[...prior, user]` on resume. */
  messages: ChatMessage[];
  /** Max model turns before the loop gives up (status `truncated`). */
  maxTurns: number;
  /** Absolute wall-clock deadline (epoch ms); checked before each turn → status `timeout`. */
  deadlineMs?: number;
  now?: () => number;
  onEvent?: AgentEventSink;
};

/** Running token tallies threaded through the loop. */
type Tally = {
  sawUsage: boolean;
  sawReportedTotal: boolean;
  reportedTotal: number;
  breakdown: TokenBreakdown;
};

export async function runAgentLoop(opts: RunAgentLoopOptions): Promise<LoopResult> {
  const now = opts.now ?? (() => Date.now());
  const messages = [...opts.messages];
  const apiTools = toApiTools(opts.tools);
  // Guard the caller's sink (a throwing sink must never crash the run) BEFORE wiring the estimator.
  const guarded: AgentEventSink | undefined =
    opts.onEvent === undefined
      ? undefined
      : (e) => {
          try {
            opts.onEvent!(e);
          } catch {
            /* observability only */
          }
        };
  const { sink, estimator } = streamingEstimator(guarded);
  const emit = (e: AgentStreamEvent): void => {
    if (sink !== undefined) sink(e);
  };

  const tally: Tally = { sawUsage: false, sawReportedTotal: false, reportedTotal: 0, breakdown: {} };
  let status: HarnessRunResult['status'] | undefined;
  let output = '';

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
      status = 'timeout';
      break;
    }

    let result: ChatResult;
    try {
      result = await opts.client.chat({
        model: opts.model,
        messages,
        tools: apiTools,
        temperature: 0,
        tool_choice: 'auto',
      });
    } catch (e) {
      status = 'crashed';
      output = errorMessage(e);
      break;
    }

    accrueUsage(tally, result, emit);
    messages.push(assistantMessage(result));
    if (result.content !== null && result.content.length > 0) {
      emit({ kind: 'message', text: result.content });
    }
    for (const tc of result.toolCalls) {
      emit({ kind: 'tool_use', id: tc.id, name: tc.function.name, input: tc.function.arguments });
    }

    if (result.toolCalls.length === 0) {
      status = 'completed';
      output = result.content ?? '';
      break;
    }

    const terminal = await dispatchToolCalls(opts, result, messages, emit);
    if (terminal !== null) {
      status = 'completed';
      output = terminal;
      break;
    }
  }

  if (status === undefined) {
    status = 'truncated';
    output = lastAssistantText(messages) ?? '';
  }
  emit({ kind: 'done', status });

  return { output, status, messages, tokens: finalizeTokens(tally, estimator) };
}

/** Fold one call's reported usage into the tally and emit a `usage` stream event. */
function accrueUsage(tally: Tally, result: ChatResult, emit: (e: AgentStreamEvent) => void): void {
  const usage = result.usage;
  if (usage === undefined) return;
  tally.sawUsage = true;
  tally.breakdown = addBreakdown(tally.breakdown, usage.breakdown);
  if (usage.total !== undefined) {
    tally.reportedTotal += usage.total;
    tally.sawReportedTotal = true;
  }
  emit({
    kind: 'usage',
    ...(usage.breakdown.input !== undefined ? { inputTokens: usage.breakdown.input } : {}),
    ...(usage.breakdown.output !== undefined ? { outputTokens: usage.breakdown.output } : {}),
    ...(usage.breakdown.cacheRead !== undefined ? { cachedTokens: usage.breakdown.cacheRead } : {}),
    ...(usage.total !== undefined ? { totalTokens: usage.total } : {}),
  });
}

/** Build the assistant message to append (omit `tool_calls` when there are none). */
function assistantMessage(result: ChatResult): ChatMessage {
  return {
    role: 'assistant',
    content: result.content,
    ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls } : {}),
  };
}

/**
 * Dispatch every tool call in a turn, appending one `tool` message per call. Returns the `finish`
 * summary if one of the calls was terminal, else `null`. Fail-closed per call (via dispatchTool).
 */
async function dispatchToolCalls(
  opts: RunAgentLoopOptions,
  result: ChatResult,
  messages: ChatMessage[],
  emit: (e: AgentStreamEvent) => void,
): Promise<string | null> {
  let terminalSummary: string | null = null;
  for (const tc of result.toolCalls) {
    const outcome = await dispatchTool(opts.tools, tc.function.name, tc.function.arguments, opts.host);
    messages.push({ role: 'tool', content: outcome.output, tool_call_id: tc.id });
    emit({ kind: 'tool_result', id: tc.id, output: outcome.output });
    if (outcome.terminal) terminalSummary = outcome.output;
  }
  return terminalSummary;
}

/** Resolve the final token accounting: prefer reported usage, fall back to the streamed estimate. */
function finalizeTokens(tally: Tally, estimator: StreamTokenEstimator | undefined): LoopTokens {
  if (tally.sawUsage) {
    const total = tally.sawReportedTotal ? tally.reportedTotal : breakdownTotal(tally.breakdown);
    const out: LoopTokens = {};
    if (total !== undefined) {
      out.tokensUsed = total;
      out.tokenSource = 'reported';
    }
    if (!isEmptyBreakdown(tally.breakdown)) out.tokenBreakdown = tally.breakdown;
    return out;
  }
  if (estimator !== undefined && estimator.observed()) {
    const est = estimator.estimate();
    if (est > 0) return { tokensUsed: est, tokenSource: 'estimated' };
  }
  return {};
}

/** The text of the last assistant message that carried content (for a truncated run's output). */
function lastAssistantText(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'assistant' && m.content !== null && m.content.length > 0) return m.content;
  }
  return undefined;
}
