import type { LlmProvider, LlmRequest } from './provider';
import { runProcess, type ProcessResult } from '../util/spawn';
import { parseAgentOutput, flatExtractor } from '../agent-cli/output';
import { StreamTap, type AgentEventSink } from '../agent-cli/stream';
import { claudeStreamExtractor } from '../harness/claude-code';

type ExecFn = (
  input: string,
  /** Optional live stdout tap (issue #23): called with each raw stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void,
) => Promise<ProcessResult>;

/**
 * Build the argv for the default `claude` invocation. An explicit `args` array is the caller's full
 * contract — we never splice into it, so `model` is honored only for the default `-p` invocation
 * (append `--model <model>`). When `stream` is set (issue #23) the default invocation switches to
 * `--output-format stream-json --verbose` so per-turn JSONL can be tapped; the closing `result`
 * event still carries the SAME final text, so non-streaming callers are unaffected. Pure and
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
    ...(stream ? ['--output-format', 'stream-json', '--verbose'] : []),
    ...(model !== undefined ? ['--model', model] : []),
  ];
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
  /** Streaming sink (issue #23), wired at construction; absent → the lean plain-text path, unchanged. */
  readonly #onEvent: AgentEventSink | undefined;
  /** True when streaming is active: the default `-p` invocation runs as `stream-json`. */
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
       * identical to the plain `-p` text for non-streaming callers — while forwarding per-turn
       * events. Wired at construction so the Verifier/Approver seams stay unchanged.
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

  async complete(req: LlmRequest): Promise<string> {
    const prompt = req.system !== undefined ? `${req.system}\n\n${req.prompt}` : req.prompt;
    const tap =
      this.#streaming && this.#onEvent !== undefined
        ? new StreamTap(claudeStreamExtractor, this.#onEvent)
        : undefined;
    const r = await this.#exec(prompt, tap ? (chunk) => tap.push(chunk) : undefined);
    tap?.end();
    if (r.timedOut) throw new Error('LLM CLI timed out');
    if (r.code !== 0) throw new Error(`LLM CLI exited ${r.code}: ${r.stderr.slice(0, 500)}`);
    if (this.#streaming) {
      // stream-json stdout is JSONL; recover the final text from the closing `result` event via
      // the shared flat extractor (same text the plain `-p` path would return). Fail closed.
      const parsed = parseAgentOutput(r.stdout, flatExtractor());
      if (parsed === null || parsed.text.length === 0) {
        throw new Error('LLM CLI produced no parseable text');
      }
      return parsed.text;
    }
    return r.stdout.trim();
  }
}
