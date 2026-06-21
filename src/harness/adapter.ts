import type { SessionId } from '../domain/ids';
import type { HarnessRunResult } from '../domain/events';
import type { AgentEventSink } from '../agent-cli/stream';

/**
 * Seam #1. A new harness = one file implementing this one method. The orchestrator can't
 * tell which harness it called, so nothing else in the system changes when you add one.
 * `diffHash` is intentionally NOT here — the shared Workspace computes it.
 */
export interface HarnessAdapter {
  /** A short identifier for logs (e.g. "claude-code", "codex", "fake"). */
  readonly name: string;
  /**
   * Spawn the headless agent with `prompt`, resuming `sessionId` when provided. Must parse
   * hostile/partial stdout tolerantly and never throw on bad output — return
   * `status: 'crashed' | 'truncated' | 'timeout'` instead, so the reducer treats it as a
   * failed run.
   *
   * `onEvent` is an OPTIONAL, opt-in streaming tap (issue #23). When provided, the adapter
   * forwards the agent's intermediate turns — tool uses, assistant messages, token usage — as
   * canonical {@link AgentEventSink} events as they arrive. It is pure observability: it never
   * changes the parsed result, the status, or the run's outcome, and a throwing sink is swallowed
   * (fail-closed). Adapters that cannot stream simply ignore it; existing callers omit it.
   */
  run(prompt: string, sessionId?: SessionId, onEvent?: AgentEventSink): Promise<HarnessRunResult>;
}
