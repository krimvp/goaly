/**
 * One deep module per coding-agent CLI. The knowledge of how to speak to a single CLI — its two
 * argv dialects (write-mode harness + read-only LLM), its field extractor, its stream extractor,
 * and its run-status mapping — used to be smeared across five modules (`agent-cli/output.ts`,
 * `harness/<tool>.ts`, `harness/classify.ts`, `cli/compose.ts`, `llm/cli-provider.ts`). An
 * {@link AgentCliCodec} consolidates ALL of it behind one small interface, so adding a CLI is one
 * codec module and the per-CLI quirks live in exactly one place (locality).
 *
 * Two consumers justify the seam, and BOTH go through the codec — never through harness internals:
 *   - the write-role {@link HarnessAdapter} (seam #1) drives the agent (`harnessArgs` + `classify`);
 *   - the read-only `AgentCliLlmProvider` (the judge/approver/compiler LLM role) uses `readonlyArgs`
 *     + the same `fieldExtractor`/`streamExtractor`.
 * That kills the old `llm → harness` and `compose → harness-internals` import leaks: both the LLM
 * provider and the composition root import the codec from this neutral `agent-cli/` layer.
 */

import { SessionId, coerceSessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import { runProcess } from '../util/spawn';
import { parseAgentOutput, type AgentOutput, type FieldExtractor } from './output';
import { StreamTap, type AgentEventSink, type StreamEventExtractor } from './stream';
import { accountTokens, streamingEstimator, type StreamTokenEstimator } from './estimate';

/** Default wall-clock budget for a single headless invocation (harness or read-only LLM turn). */
export const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Raw result of spawning an agent CLI. `code` is the process exit code (`null` when the process was
 * killed before exiting — normalised to a non-zero exit downstream); `timedOut` is set when we
 * killed it for exceeding the wall-clock budget. This is the SEAM: tests inject a fake `exec`,
 * production spawns the real binary via {@link defaultAgentExec}.
 */
export type AgentExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
};

/**
 * Injectable subprocess seam shared by every codec-backed adapter. Takes the full argv plus the
 * prompt (some CLIs read it from stdin), and an optional live stdout tap (issue #23). Tests pass a
 * fake so they never spawn a real process; production uses {@link defaultAgentExec}.
 */
export type AgentExecFn = (
  args: string[],
  input: { prompt: string },
  onStdout?: (chunk: string) => void,
) => Promise<AgentExecResult>;

/** The arguments a codec maps a run into before classifying it. The codec parses `stdout` itself. */
export type CodecClassifyInput = {
  stdout: string;
  stderr: string;
  /** Normalised exit code: `null` (signal-killed) is treated as a non-zero/failed exit. */
  code: number | null;
  timedOut?: boolean | undefined;
  /** The resume session id passed into `run()`, used as a fallback when stdout carries none. */
  sessionId?: SessionId | undefined;
  /** Streaming token estimator (issue #24); present only when the run streamed. */
  estimator?: StreamTokenEstimator | undefined;
};

/**
 * Everything goaly needs to know to speak to ONE coding-agent CLI, in one place. The harness role
 * and the read-only LLM role both consume it; nothing tool-specific leaks past it.
 */
export interface AgentCliCodec {
  /** Short identifier for logs (e.g. "claude-code", "codex", "droid"). */
  readonly name: string;
  /** The binary to spawn (e.g. "claude", "codex", "droid"). */
  readonly command: string;
  /** Safe sentinel session id when none is recovered from stdout or the caller. */
  readonly unknownSession: string;
  /** Whether the prompt is also written to the child's stdin (claude) vs argv-only (codex/droid). */
  readonly promptOnStdin: boolean;
  /** Field strategy for this CLI's final-result envelope (the streaming-agnostic parse). */
  readonly fieldExtractor: FieldExtractor;
  /** Streaming sibling of `fieldExtractor`: maps per-turn JSONL onto the canonical event taxonomy. */
  readonly streamExtractor: StreamEventExtractor;

  /**
   * Write-mode argv (the HARNESS role: the agent may edit the working tree). `stream` requests
   * per-turn JSONL where the CLI distinguishes it from its normal structured output.
   */
  harnessArgs(opts: {
    prompt: string;
    model: string | undefined;
    sessionId?: SessionId | undefined;
    stream: boolean;
  }): string[];

  /**
   * Read-only argv (the LLM role: judge / approver / compiler — must NEVER edit the tree). `stream`
   * requests per-turn JSONL where applicable; a CLI whose structured output is already a JSONL
   * stream ignores it.
   */
  readonlyArgs(opts: { prompt: string; model: string | undefined; stream: boolean }): string[];

  /** Tolerantly parse this CLI's stdout into the shared {@link AgentOutput}. Never throws. */
  parse(stdout: string): AgentOutput | null;

  /**
   * Map a raw run into a Zod-parsed {@link HarnessRunResult}. Owns the per-tool status policy
   * (claude/droid share {@link classifyFlatRun}; codex keeps its inverted mapping). Never throws.
   */
  classify(input: CodecClassifyInput): HarnessRunResult;
}

/**
 * Default production exec: spawn the real binary via the shared {@link runProcess} (one tested
 * subprocess dance — output cap, timeout, never-reject — for the whole codebase). The prompt is
 * delivered on argv by the codec's `*Args`; for CLIs that also read it from stdin (`promptOnStdin`)
 * we additionally write it there.
 */
export function defaultAgentExec(
  command: string,
  timeoutMs: number,
  promptOnStdin: boolean,
): AgentExecFn {
  return async (args, input, onStdout) => {
    const r = await runProcess(command, args, {
      timeoutMs,
      ...(promptOnStdin ? { input: input.prompt } : {}),
      ...(onStdout !== undefined ? { onStdout } : {}),
    });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut };
  };
}

/**
 * The one harness `run()` body, parameterised by a codec. Builds the optional stream tap (and the
 * issue-#24 token estimator), asks the codec for the write-mode argv, runs the injected `exec`
 * (never rejecting — a thrown exec becomes a fail-closed `crashed`), flushes the tap, and lets the
 * codec classify. Shared by every codec-backed {@link HarnessAdapter} so the spawn/parse/classify
 * dance lives in exactly one place.
 */
export async function runCodecHarness(
  codec: AgentCliCodec,
  exec: AgentExecFn,
  model: string | undefined,
  prompt: string,
  sessionId?: SessionId,
  onEvent?: AgentEventSink,
): Promise<HarnessRunResult> {
  const { sink, estimator } = streamingEstimator(onEvent);
  const tap = sink !== undefined ? new StreamTap(codec.streamExtractor, sink) : undefined;
  const args = codec.harnessArgs({
    prompt,
    model,
    ...(sessionId !== undefined ? { sessionId } : {}),
    stream: tap !== undefined,
  });

  let result: AgentExecResult;
  try {
    result = await exec(args, { prompt }, tap ? (chunk) => tap.push(chunk) : undefined);
  } catch (err) {
    // The exec seam should never reject, but fail-closed if it does.
    tap?.end();
    return HarnessRunResult.parse({
      output: err instanceof Error ? err.message : String(err),
      sessionId: coerceSessionId(sessionId, codec.unknownSession),
      status: 'crashed',
    });
  }
  tap?.end(); // flush a final unterminated JSONL line before classification

  return codec.classify({
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(estimator !== undefined ? { estimator } : {}),
  });
}

/**
 * The shared run-status classifier for the FLAT codecs (claude-code, droid), whose `run()` tails are
 * identical: a timeout salvages any parsed text → `timeout`; a non-zero/killed exit → `crashed`;
 * exit-0 with no usable text → `truncated`; a soft `isError` flag (droid) → `truncated`; otherwise
 * `completed` (+tokens). Codex maps the non-zero / no-text cases the other way (no-parse → crashed,
 * non-zero-with-text → truncated), so its codec keeps its own `classify`. Never throws — always a
 * Zod-parsed {@link HarnessRunResult}. The exec-rejects-itself case is handled in
 * {@link runCodecHarness}.
 */
export function classifyFlatRun(opts: {
  parsed: AgentOutput | null;
  code: number | null;
  stderr: string;
  timedOut?: boolean | undefined;
  sessionId?: string | undefined;
  unknownSession: string;
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
  const acct = accountTokens(parsed.tokens, estimator);
  return HarnessRunResult.parse({
    output: parsed.text,
    sessionId: session,
    status,
    ...acct,
    // The split belongs only to a provider-REPORTED count; a local estimate has no category split.
    ...(acct.tokenSource === 'reported' && parsed.breakdown !== undefined
      ? { tokenBreakdown: parsed.breakdown }
      : {}),
  });
}
