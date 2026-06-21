import type { LlmProvider, LlmRequest } from './provider';
import { runProcess, type ProcessResult } from '../util/spawn';

type ExecFn = (input: string) => Promise<ProcessResult>;

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

  constructor(
    options: { command?: string; args?: string[]; exec?: ExecFn; timeoutMs?: number } = {},
  ) {
    const command = options.command ?? 'claude';
    const args = options.args ?? ['-p'];
    this.name = `cli:${command}`;
    this.#exec =
      options.exec ??
      ((input) =>
        runProcess(command, args, {
          input,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        }));
  }

  async complete(req: LlmRequest): Promise<string> {
    const prompt = req.system !== undefined ? `${req.system}\n\n${req.prompt}` : req.prompt;
    const r = await this.#exec(prompt);
    if (r.timedOut) throw new Error('LLM CLI timed out');
    if (r.code !== 0) throw new Error(`LLM CLI exited ${r.code}: ${r.stderr.slice(0, 500)}`);
    return r.stdout.trim();
  }
}
