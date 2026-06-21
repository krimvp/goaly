import { coerceSessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { AgentOutput } from '../agent-cli/output';

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
}): HarnessRunResult {
  const { parsed, code, stderr, timedOut, sessionId, unknownSession } = opts;
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
    ...(parsed.tokens !== undefined ? { tokensUsed: parsed.tokens } : {}),
  });
}
