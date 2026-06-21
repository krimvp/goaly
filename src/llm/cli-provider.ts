import type { LlmCompletion, LlmProvider, LlmRequest } from './provider';
import { runProcess, type ProcessResult } from '../util/spawn';
import { parseAgentOutput, flatExtractor, type AgentOutput } from '../agent-cli/output';
import { StreamTap, type AgentEventSink } from '../agent-cli/stream';
import { accountTokens, streamingEstimator, type StreamTokenEstimator } from '../agent-cli/estimate';
import { claudeStreamExtractor } from '../harness/claude-code';

type ExecFn = (
  input: string,
  /** Optional live stdout tap (issue #23): called with each raw stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void,
) => Promise<ProcessResult>;

/**
 * Build the argv for the default `claude` invocation. An explicit `args` array is the caller's full
 * contract — we never splice into it, so `model` is honored only for the default invocation. The
 * default asks for a JSON envelope so token usage is available for the per-run spend report (issue
 * #17): `--output-format json` normally, or `--output-format stream-json --verbose` when streaming
 * (issue #23) so per-turn JSONL can be tapped. Either way the closing `result` carries the SAME
 * final text — pulled back out by {@link parseAgentOutput} — so callers are unaffected. Pure and
 * exported so the argv shaping is directly unit-testable (the `exec` seam hides the argv).
 */
export function buildLlmArgs(
  args: string[] | undefined,
  model: string | undefined,
  stream = false,
): string[] {
  if (args !== undefined) return args;
  return [
    '-p',
    ...(stream ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
    ...(model !== undefined ? ['--model', model] : []),
  ];
}

function toCompletion(parsed: AgentOutput, estimator?: StreamTokenEstimator): LlmCompletion {
  return { text: parsed.text, ...accountTokens(parsed.tokens, estimator) };
}

/**
 * A reference LlmProvider that shells out to a CLI (default `claude -p`, prompt on stdin) for
 * one-shot completions used by the judge / approver / compiler. The provider is an INTERNAL
 * seam: judge/approver/compiler depend on `LlmProvider`, never on this concrete class.
 *
 * Note: the CLI does not expose a temperature knob; `req.temperature` is advisory. A
 * SDK-backed provider (with real temperature control) is a drop-in alternative implementing
 * the same interface.
 */
export class CliLlmProvider implements LlmProvider {
  readonly name: string;
  readonly #exec: ExecFn;
  /** Streaming sink (issue #23), wired at construction; absent → the lean JSON path, unchanged. */
  readonly #onEvent: AgentEventSink | undefined;
  /** True when streaming is active: the default invocation runs as `stream-json`. */
  readonly #streaming: boolean;

  constructor(
    options: {
      command?: string;
      args?: string[];
      exec?: ExecFn;
      timeoutMs?: number;
      model?: string;
      /**
       * Opt-in streaming sink. When set (and no explicit `args` override), the provider switches to
       * `--output-format stream-json` and parses the final text with the shared `flatExtractor` —
       * identical to the JSON text for non-streaming callers — while forwarding per-turn events.
       * Wired at construction so the Verifier/Approver seams stay unchanged.
       */
      onEvent?: AgentEventSink;
    } = {},
  ) {
    const command = options.command ?? 'claude';
    // Streaming only applies to the default invocation; an explicit `args` is the caller's contract.
    this.#streaming = options.onEvent !== undefined && options.args === undefined;
    const args = buildLlmArgs(options.args, options.model, this.#streaming);
    this.name = `cli:${command}`;
    this.#onEvent = options.onEvent;
    this.#exec =
      options.exec ??
      ((input, onStdout) =>
        runProcess(command, args, {
          input,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          ...(onStdout !== undefined ? { onStdout } : {}),
        }));
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const prompt = req.system !== undefined ? `${req.system}\n\n${req.prompt}` : req.prompt;
    // When streaming, accumulate a local token estimate (issue #24) from the turns, used as a
    // fallback if the closing `result` carries no `usage`.
    const { sink, estimator } = streamingEstimator(this.#streaming ? this.#onEvent : undefined);
    const tap = sink !== undefined ? new StreamTap(claudeStreamExtractor, sink) : undefined;
    const r = await this.#exec(prompt, tap ? (chunk) => tap.push(chunk) : undefined);
    tap?.end();
    if (r.timedOut) throw new Error('LLM CLI timed out');
    if (r.code !== 0) throw new Error(`LLM CLI exited ${r.code}: ${r.stderr.slice(0, 500)}`);
    // The default invocation returns a JSON(L) envelope; recover the result text AND token usage
    // (issue #17) with the shared flat extractor. Streaming requires parseable text (fail closed);
    // a plain-text reply from caller-supplied args isn't JSON, so fall back to the raw stdout.
    const parsed = parseAgentOutput(r.stdout, flatExtractor());
    if (this.#streaming) {
      if (parsed === null || parsed.text.length === 0) {
        throw new Error('LLM CLI produced no parseable text');
      }
      return toCompletion(parsed, estimator);
    }
    if (parsed !== null) return toCompletion(parsed);
    return { text: r.stdout.trim() };
  }
}
