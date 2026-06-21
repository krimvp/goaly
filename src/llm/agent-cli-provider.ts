import type { LlmProvider, LlmRequest } from './provider';
import { runProcess } from '../util/spawn';
import { parseAgentOutput, type FieldExtractor } from '../agent-cli/output';

/** Injectable subprocess seam: takes the full argv, returns raw output. Tests pass a fake. */
type ExecFn = (
  args: string[],
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

  constructor(opts: {
    name: string;
    command: string;
    buildArgs: (prompt: string) => string[];
    extractor: FieldExtractor;
    exec?: ExecFn;
    timeoutMs?: number;
  }) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.name = opts.name;
    this.#buildArgs = opts.buildArgs;
    this.#extractor = opts.extractor;
    this.#exec = opts.exec ?? ((args) => runProcess(opts.command, args, { timeoutMs }));
  }

  async complete(req: LlmRequest): Promise<string> {
    const prompt = req.system !== undefined ? `${req.system}\n\n${req.prompt}` : req.prompt;
    const r = await this.#exec(this.#buildArgs(prompt));
    if (r.timedOut === true) throw new Error(`LLM CLI ${this.name} timed out`);
    if (r.code !== 0) {
      throw new Error(`LLM CLI ${this.name} exited ${r.code}: ${r.stderr.slice(0, 500)}`);
    }
    const parsed = parseAgentOutput(r.stdout, this.#extractor);
    if (parsed === null || parsed.text.length === 0) {
      throw new Error(`LLM CLI ${this.name} produced no parseable text`);
    }
    return parsed.text;
  }
}
