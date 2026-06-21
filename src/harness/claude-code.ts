import { spawn } from 'node:child_process';
import { SessionId, coerceSessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { HarnessAdapter } from './adapter';
import { parseAgentOutput, flatExtractor, type AgentOutput } from '../agent-cli/output';
import { classifyHarnessRun } from './classify';

/**
 * Injectable subprocess seam. Returns the raw stdout/stderr, the process exit code, and a
 * `timedOut` flag. Tests pass a fake so they never spawn a real process.
 */
export type ExecFn = (
  args: string[],
  input: { prompt: string },
) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

/** Sentinel session id used whenever we have no usable session from the CLI or the caller. */
const UNKNOWN_SESSION = 'claude-unknown';

/** Default wall-clock budget for a single headless invocation. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Field strategy for Claude Code's flat `--output-format json` envelope (result/session_id/usage). */
const claudeExtractor = flatExtractor();

/**
 * Tolerantly parse Claude Code headless stdout (whole-object, object-amid-noise, or stream-json,
 * keeping the LAST result-bearing line). Returns `null` when no JSON object carries text. Never
 * throws. A thin wrapper over the shared {@link parseAgentOutput} core.
 */
export function parseClaudeOutput(stdout: string): AgentOutput | null {
  return parseAgentOutput(stdout, claudeExtractor);
}

/**
 * Real subprocess implementation. Assumed CLI contract:
 *   claude -p "<prompt>" --output-format json [--model <model>] [--resume <sessionId>]
 * stdout is JSON (object or stream-json lines); a non-zero exit code means failure; the prompt is
 * passed as an argv value. We also write the prompt to stdin as a fallback for CLI builds that
 * read the prompt from stdin. Never rejects: maps spawn errors to a non-zero code instead.
 */
function defaultExec(timeoutMs: number): ExecFn {
  return (args, input) =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (r: { stdout: string; stderr: string; code: number; timedOut?: boolean }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      let child;
      try {
        child = spawn('claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (err) {
        finish({ stdout: '', stderr: String(err), code: 1 });
        return;
      }

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (err: Error) => {
        clearTimeout(timer);
        finish({ stdout, stderr: stderr + err.message, code: 1 });
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        finish({ stdout, stderr, code: code ?? 1, ...(timedOut ? { timedOut: true } : {}) });
      });

      // Best-effort: provide the prompt on stdin too; ignore EPIPE on builds that ignore stdin.
      try {
        child.stdin?.write(input.prompt);
        child.stdin?.end();
      } catch {
        // ignore
      }
    });
}

/**
 * Headless Claude Code harness adapter. Spawns `claude -p` and tolerantly parses its JSON output,
 * never throwing on hostile/partial output — failures become `crashed | truncated | timeout`.
 */
export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly name = 'claude-code';
  readonly #exec: ExecFn;
  readonly #model: string | undefined;

  constructor(opts: { exec?: ExecFn; timeoutMs?: number; model?: string } = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#exec = opts.exec ?? defaultExec(timeoutMs);
    this.#model = opts.model;
  }

  async run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (this.#model !== undefined) args.push('--model', this.#model);
    if (sessionId !== undefined) args.push('--resume', sessionId);

    let result: { stdout: string; stderr: string; code: number; timedOut?: boolean };
    try {
      result = await this.#exec(args, { prompt });
    } catch (err) {
      // The exec seam should never reject, but fail-closed if it does.
      return HarnessRunResult.parse({
        output: err instanceof Error ? err.message : String(err),
        sessionId: coerceSessionId(sessionId, UNKNOWN_SESSION),
        status: 'crashed',
      });
    }

    return classifyHarnessRun({
      parsed: parseClaudeOutput(result.stdout),
      code: result.code,
      stderr: result.stderr,
      timedOut: result.timedOut,
      sessionId,
      unknownSession: UNKNOWN_SESSION,
    });
  }
}
