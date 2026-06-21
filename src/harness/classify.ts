import { coerceSessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { AgentOutput } from '../agent-cli/output';
import { accountTokens, type StreamTokenEstimator } from '../agent-cli/estimate';

/**
 * Shared run-status classifier for the FLAT adapters (claude-code, droid), whose `run()` tails are
 * identical: a timeout salvages any parsed text → `timeout`; a non-zero/killed exit → `crashed`;
 * exit-0 with no usable text → `truncated`; a soft `isError` flag (droid) → `truncated`; otherwise
 * `completed` (+tokens). Codex maps the non-zero / no-text cases the other way (no-parse → crashed,
 * non-zero-with-text → truncated), so it keeps its own tail. Never throws — always a Zod-parsed
 * {@link HarnessRunResult}. The exec-rejects-itself case stays in each adapter's `run()` try/catch.
 */
export function classifyHarnessRun(opts: {
  parsed: AgentOutput | null;
  code: number;
  stderr: string;
  timedOut?: boolean | undefined;
  sessionId?: string | undefined;
  unknownSession: string;
  /**
   * Streaming token estimator (issue #24): when the parsed envelope carries no `usage`, fall back to
   * a local estimate of the agent's spend accumulated from its streamed turns. Present only when the
   * adapter streamed (`onEvent` supplied); a self-reported count always takes precedence.
   */
  estimator?: StreamTokenEstimator | undefined;
}): HarnessRunResult {
  const { parsed, code, stderr, timedOut, sessionId, unknownSession, estimator } = opts;
  const session = coerceSessionId(parsed?.sessionId ?? sessionId, unknownSession);

  if (timedOut === true) {
    return HarnessRunResult.parse({
      output: parsed?.text ?? stderr,
      sessionId: session,
      status: 'timeout',
    });
  }
  if (code !== 0) {
    return HarnessRunResult.parse({
      output: stderr.length > 0 ? stderr : (parsed?.text ?? ''),
      sessionId: session,
      status: 'crashed',
    });
  }
  if (parsed === null || parsed.text.length === 0) {
    return HarnessRunResult.parse({
      output: stderr,
      sessionId: session,
      status: 'truncated',
    });
  }
  const status: HarnessRunResult['status'] = parsed.isError === true ? 'truncated' : 'completed';
  return HarnessRunResult.parse({
    output: parsed.text,
    sessionId: session,
    status,
    ...accountTokens(parsed.tokens, estimator),
  });
}
