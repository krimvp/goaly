import type { SessionId } from '../domain/ids';
import type { HarnessRunResult } from '../domain/events';

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
   */
  run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult>;
}
