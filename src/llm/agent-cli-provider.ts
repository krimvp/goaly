import type { LlmCompletion, LlmProvider, LlmRequest } from './provider';
import { runProcess } from '../util/spawn';
import { parseAgentOutput, type FieldExtractor } from '../agent-cli/output';
import { StreamTap, type AgentEventSink, type StreamEventExtractor } from '../agent-cli/stream';
import { accountTokens, streamingEstimator } from '../agent-cli/estimate';

/** Injectable subprocess seam: takes the full argv, returns raw output. Tests pass a fake. */
type ExecFn = (
  args: string[],
  /** Optional live stdout tap (issue #23): called with each raw stdout chunk as it arrives. */
  onStdout?: (chunk: string) => void,
) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

/** Default wall-clock budget for one completion. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * An {@link LlmProvider} backed by an agentic coding-agent CLI (codex / droid) run one-shot in a
 * READ-ONLY mode, so the judge / approver / compiler can use that tool's model without ever
 * mutating the working tree it is judging. The caller supplies the read-only argv builder and the
 * tool's {@link FieldExtractor}; this reuses the same tolerant {@link parseAgentOutput} core as the
 * harness adapters to pull out the final assistant text, and fails closed when none comes back.
 */
export class AgentCliLlmProvider implements LlmProvider {
  readonly name: string;
  readonly #buildArgs: (prompt: string) => string[];
  readonly #extractor: FieldExtractor;
  readonly #exec: ExecFn;
  /** Streaming tap (issue #23), wired at CONSTRUCTION so the Verifier/Approver seams stay clean. */
  readonly #onEvent: AgentEventSink | undefined;
  readonly #streamExtractor: StreamEventExtractor | undefined;

  constructor(opts: {
    name: string;
    command: string;
    buildArgs: (prompt: string) => string[];
    extractor: FieldExtractor;
    exec?: ExecFn;
    timeoutMs?: number;
    /**
     * Opt-in streaming sink. When set together with `streamExtractor`, this provider forwards the
     * read-only agent turn's intermediate events as they arrive. The LLM steps share the harness
     * parser, so this is the same {@link StreamTap} machinery — only the sink injection point
     * differs (construction, not a `complete()` arg), keeping `LlmProvider` an internal seam.
     */
    onEvent?: AgentEventSink;
    /** The streaming sibling of `extractor` (e.g. `codexStreamExtractor`). Required to emit events. */
    streamExtractor?: StreamEventExtractor;
  }) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.name = opts.name;
    this.#buildArgs = opts.buildArgs;
    this.#extractor = opts.extractor;
    this.#exec = opts.exec ?? ((args, onStdout) =>
      runProcess(opts.command, args, { timeoutMs, ...(onStdout !== undefined ? { onStdout } : {}) }));
    this.#onEvent = opts.onEvent;
    this.#streamExtractor = opts.streamExtractor;
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    const prompt = req.system !== undefined ? `${req.system}\n\n${req.prompt}` : req.prompt;
    // When streaming, accumulate a local token estimate (issue #24) from the turns, used as a
    // fallback when the agent CLI reports no usage. Estimation needs a stream extractor to map turns.
    const streaming = this.#streamExtractor !== undefined ? this.#onEvent : undefined;
    const { sink, estimator } = streamingEstimator(streaming);
    const tap =
      sink !== undefined && this.#streamExtractor !== undefined
        ? new StreamTap(this.#streamExtractor, sink)
        : undefined;
    const r = await this.#exec(this.#buildArgs(prompt), tap ? (chunk) => tap.push(chunk) : undefined);
    tap?.end();
    if (r.timedOut === true) throw new Error(`LLM CLI ${this.name} timed out`);
    if (r.code !== 0) {
      throw new Error(`LLM CLI ${this.name} exited ${r.code}: ${r.stderr.slice(0, 500)}`);
    }
    const parsed = parseAgentOutput(r.stdout, this.#extractor);
    if (parsed === null || parsed.text.length === 0) {
      throw new Error(`LLM CLI ${this.name} produced no parseable text`);
    }
    return { text: parsed.text, ...accountTokens(parsed.tokens, estimator) };
  }
}
