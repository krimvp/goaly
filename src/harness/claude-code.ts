import { spawn } from 'node:child_process';
import { z } from 'zod';
import { SessionId, coerceSessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { HarnessAdapter } from './adapter';

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

/**
 * Zod schema for the tolerant shape of Claude Code headless JSON. Claude's `--output-format json`
 * emits an object with (at least) `result`, `session_id`, and a `usage` block. We accept any of a
 * few field aliases and ignore everything else; all fields are optional so a partial/odd payload
 * still parses (and we then decide truncated vs completed by content).
 */
const ClaudeUsage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough();

const ClaudeJson = z
  .object({
    result: z.string().optional(),
    text: z.string().optional(),
    response: z.string().optional(),
    session_id: z.string().optional(),
    sessionId: z.string().optional(),
    usage: ClaudeUsage.optional(),
    total_cost_usd: z.number().optional(),
  })
  .passthrough();

export type ParsedClaudeOutput = {
  text: string;
  sessionId?: string;
  tokens?: number;
};

/**
 * Attempt to read a single JSON object out of an unknown string. Returns `null` if it does not
 * parse as a JSON object. Used both for whole-stdout JSON and for individual stream-json lines.
 */
function tryJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Pull a token count out of a (possibly absent) usage block, preferring an explicit total. */
function tokensFromUsage(usage: z.infer<typeof ClaudeUsage> | undefined): number | undefined {
  if (usage === undefined) return undefined;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const sum = input + output;
  return sum > 0 ? sum : undefined;
}

/** Read a session id from any parsed object, even one that carries no result text. */
function readSessionId(obj: Record<string, unknown>): string | undefined {
  const parsed = ClaudeJson.safeParse(obj);
  if (!parsed.success) return undefined;
  return parsed.data.session_id ?? parsed.data.sessionId;
}

/** Normalize one parsed JSON object into our minimal output shape, or `null` if it has no text. */
function fromJsonObject(obj: Record<string, unknown>): ParsedClaudeOutput | null {
  const parsed = ClaudeJson.safeParse(obj);
  if (!parsed.success) return null;
  const data = parsed.data;
  const text = data.result ?? data.text ?? data.response;
  if (text === undefined) return null;
  const sessionId = data.session_id ?? data.sessionId;
  const tokens = tokensFromUsage(data.usage);
  return {
    text,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
  };
}

/**
 * Tolerantly parse Claude Code headless stdout. Handles three shapes, in order:
 *   1. The whole stdout is one JSON object (`--output-format json`).
 *   2. The stdout has log/noise lines around a single JSON object line.
 *   3. Stream-json: many JSON lines where the LAST result-bearing line is the answer.
 * Returns `null` when no JSON object carrying a `result`/`text`/`response` field is found.
 */
export function parseClaudeOutput(stdout: string): ParsedClaudeOutput | null {
  // Fast path: the entire payload is one JSON object.
  const whole = tryJsonObject(stdout);
  if (whole !== null) {
    const direct = fromJsonObject(whole);
    if (direct !== null) return direct;
  }

  // Line-oriented (stream-json) path: keep the LAST text-bearing object, but accumulate the
  // session id from ANY line (the init line carries session_id with no result text — losing it
  // would break `--resume`). Latch the first session id seen.
  const lines = stdout.split(/\r?\n/);
  let last: ParsedClaudeOutput | null = null;
  let streamSessionId: string | undefined;
  for (const line of lines) {
    const obj = tryJsonObject(line);
    if (obj === null) continue;
    const sid = readSessionId(obj);
    if (sid !== undefined && streamSessionId === undefined) streamSessionId = sid;
    const candidate = fromJsonObject(obj);
    if (candidate !== null) last = candidate;
  }
  if (last === null) return null;
  if (last.sessionId === undefined && streamSessionId !== undefined) {
    return { ...last, sessionId: streamSessionId };
  }
  return last;
}

/**
 * Real subprocess implementation. Assumed CLI contract:
 *   claude -p "<prompt>" --output-format json [--resume <sessionId>]
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

  constructor(opts: { exec?: ExecFn; timeoutMs?: number } = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#exec = opts.exec ?? defaultExec(timeoutMs);
  }

  async run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    const args = ['-p', prompt, '--output-format', 'json'];
    if (sessionId !== undefined) {
      args.push('--resume', sessionId);
    }

    const fallbackSession = coerceSessionId(sessionId, UNKNOWN_SESSION);

    let result: { stdout: string; stderr: string; code: number; timedOut?: boolean };
    try {
      result = await this.#exec(args, { prompt });
    } catch (err) {
      // The exec seam should never reject, but fail-closed if it does.
      return HarnessRunResult.parse({
        output: err instanceof Error ? err.message : String(err),
        sessionId: fallbackSession,
        status: 'crashed',
      });
    }

    if (result.timedOut === true) {
      return HarnessRunResult.parse({
        output: result.stderr,
        sessionId: fallbackSession,
        status: 'timeout',
      });
    }

    const parsed = parseClaudeOutput(result.stdout);

    if (result.code !== 0) {
      return HarnessRunResult.parse({
        output: result.stderr.length > 0 ? result.stderr : (parsed?.text ?? ''),
        sessionId: coerceSessionId(parsed?.sessionId ?? sessionId, UNKNOWN_SESSION),
        status: 'crashed',
      });
    }

    // Exit 0 but no parseable JSON result, or an empty body → truncated.
    if (parsed === null || parsed.text.length === 0) {
      return HarnessRunResult.parse({
        output: result.stderr,
        sessionId: coerceSessionId(parsed?.sessionId ?? sessionId, UNKNOWN_SESSION),
        status: 'truncated',
      });
    }

    const resolvedSession = coerceSessionId(parsed.sessionId ?? sessionId, UNKNOWN_SESSION);
    return HarnessRunResult.parse({
      output: parsed.text,
      sessionId: resolvedSession,
      status: 'completed',
      ...(parsed.tokens !== undefined ? { tokensUsed: parsed.tokens } : {}),
    });
  }
}
