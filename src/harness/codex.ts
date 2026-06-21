import { spawn } from 'node:child_process';
import { SessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { HarnessAdapter } from './adapter';

/**
 * Raw result of spawning the codex binary. `code` is the process exit code (null when the
 * process was killed before exiting), `timedOut` is set when we killed it for exceeding the
 * wall-clock budget. This is the SEAM: tests inject a fake `ExecFn`, production spawns codex.
 */
export type ExecResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut?: boolean;
};

export type ExecFn = (args: string[], input: { prompt: string }) => Promise<ExecResult>;

/** Wall-clock cap before we kill the codex subprocess and report `timeout`. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Returned when nothing usable could be parsed from stdout. */
const SESSION_FALLBACK = 'codex-unknown';

/**
 * Assumed codex CLI contract (the EXACT flags may differ between codex versions — this is the
 * seam, not a hard dependency):
 *
 *   New conversation:  `codex exec <prompt> --json`
 *   Resume a thread:   `codex exec resume <sessionId> <prompt> --json`
 *
 * `--json` makes codex stream JSONL events on stdout, one JSON object per line. We parse those
 * lines tolerantly in `parseCodexOutput`.
 */
function buildArgs(prompt: string, sessionId?: SessionId): string[] {
  if (sessionId !== undefined) {
    return ['exec', 'resume', sessionId as unknown as string, prompt, '--json'];
  }
  return ['exec', prompt, '--json'];
}

/** Default production exec: spawn the real `codex` binary and collect its output. */
function defaultExec(timeoutMs: number): ExecFn {
  return (args, _input) =>
    new Promise<ExecResult>((resolve) => {
      let settled = false;
      const finish = (r: ExecResult): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = spawn('codex', args, { stdio: ['ignore', 'pipe', 'pipe'] });

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
        finish({ stdout, stderr: stderr + String(err.message), code: null, timedOut });
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        finish({ stdout, stderr, code, timedOut });
      });
    });
}

/** A single tolerantly-extracted carrier of useful fields from a JSONL event. */
type ExtractedFields = {
  text?: string;
  sessionId?: string;
  tokens?: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Pull a string from the first key present, tolerating nested message shapes. */
function extractText(obj: Record<string, unknown>): string | undefined {
  // Common codex/agent shapes: { text }, { message: { content } | string },
  // { content: string | [{ text }] }, { delta: { text } }, { result }.
  const directKeys = ['text', 'result', 'output', 'content', 'final_message'];
  for (const k of directKeys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  const message = obj['message'];
  if (typeof message === 'string' && message.length > 0) return message;
  if (isRecord(message)) {
    const inner = extractText(message);
    if (inner !== undefined) return inner;
  }
  const content = obj['content'];
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === 'string') parts.push(part);
      else if (isRecord(part) && typeof part['text'] === 'string') parts.push(part['text']);
    }
    if (parts.length > 0) return parts.join('');
  }
  const delta = obj['delta'];
  if (isRecord(delta)) {
    const inner = extractText(delta);
    if (inner !== undefined) return inner;
  }
  return undefined;
}

function extractSessionId(obj: Record<string, unknown>): string | undefined {
  // Deliberately NOT a generic `id` — a per-message id on a later line would clobber the
  // thread/session id established at stream start, breaking `codex resume`.
  const keys = ['session_id', 'sessionId', 'thread_id', 'threadId', 'conversation_id'];
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function extractTokens(obj: Record<string, unknown>): number | undefined {
  const usage = obj['usage'];
  const source = isRecord(usage) ? usage : obj;
  const keys = ['total_tokens', 'totalTokens', 'tokens', 'tokens_used', 'tokensUsed'];
  for (const k of keys) {
    const v = source[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v);
  }
  // Sum input+output if a total is not directly present.
  const input = source['input_tokens'];
  const output = source['output_tokens'];
  if (typeof input === 'number' && typeof output === 'number') {
    const sum = input + output;
    if (Number.isFinite(sum) && sum >= 0) return Math.trunc(sum);
  }
  return undefined;
}

function extractFields(obj: Record<string, unknown>): ExtractedFields {
  const out: ExtractedFields = {};
  const text = extractText(obj);
  if (text !== undefined) out.text = text;
  const sid = extractSessionId(obj);
  if (sid !== undefined) out.sessionId = sid;
  const tokens = extractTokens(obj);
  if (tokens !== undefined) out.tokens = tokens;
  return out;
}

/**
 * Tolerantly walk codex `--json` JSONL stdout. Returns the final assistant/result text, plus a
 * session/thread id and token usage when any line carries them. Returns `null` when no line is
 * valid JSON or no usable text was found, so the adapter can map that to `crashed`. Never throws.
 */
export function parseCodexOutput(
  stdout: string,
): { text: string; sessionId?: string; tokens?: number } | null {
  const lines = stdout.split(/\r?\n/);
  let sawValidJson = false;
  let lastText: string | undefined;
  let sessionId: string | undefined;
  let tokens: number | undefined;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // tolerate non-JSON / partial lines
    }
    if (!isRecord(parsed)) continue;
    sawValidJson = true;
    const fields = extractFields(parsed);
    if (fields.text !== undefined) lastText = fields.text;
    // Session id: latch the FIRST seen (the thread id is established once at stream start).
    if (fields.sessionId !== undefined && sessionId === undefined) sessionId = fields.sessionId;
    // Tokens: keep the latest non-empty seen (usage accrues over the stream).
    if (fields.tokens !== undefined) tokens = fields.tokens;
  }

  if (!sawValidJson) return null;
  if (lastText === undefined) return null;

  const result: { text: string; sessionId?: string; tokens?: number } = { text: lastText };
  if (sessionId !== undefined) result.sessionId = sessionId;
  if (tokens !== undefined) result.tokens = tokens;
  return result;
}

/** Coerce an arbitrary candidate string into a valid SessionId, falling back when invalid. */
function toSessionId(candidate: string | undefined): SessionId {
  const value = candidate !== undefined && candidate.length > 0 ? candidate : SESSION_FALLBACK;
  const parsed = SessionId.safeParse(value);
  return parsed.success ? parsed.data : SessionId.parse(SESSION_FALLBACK);
}

/**
 * Codex headless adapter. Mirrors the Claude adapter exactly: never throws, classifies output
 * into `completed | crashed | truncated | timeout`, and always returns a Zod-parsed
 * HarnessRunResult. The subprocess is injectable so tests never spawn a real process.
 */
export class CodexAdapter implements HarnessAdapter {
  readonly name = 'codex';
  readonly #exec: ExecFn;
  readonly #timeoutMs: number;

  constructor(opts?: { exec?: ExecFn; timeoutMs?: number }) {
    this.#timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#exec = opts?.exec ?? defaultExec(this.#timeoutMs);
  }

  async run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    const args = buildArgs(prompt, sessionId);

    let result: ExecResult;
    try {
      result = await this.#exec(args, { prompt });
    } catch {
      // The exec seam itself failed (spawn error surfaced as a throw): treat as crash.
      return HarnessRunResult.parse({
        output: '',
        sessionId: toSessionId(sessionId as unknown as string | undefined),
        status: 'crashed',
      });
    }

    if (result.timedOut === true) {
      const parsed = parseCodexOutput(result.stdout);
      return HarnessRunResult.parse({
        output: parsed?.text ?? '',
        sessionId: toSessionId(parsed?.sessionId ?? (sessionId as unknown as string | undefined)),
        status: 'timeout',
      });
    }

    const parsed = parseCodexOutput(result.stdout);

    // No parseable JSONL / no text → crashed, but still a valid RunResult.
    if (parsed === null) {
      return HarnessRunResult.parse({
        output: '',
        sessionId: toSessionId(sessionId as unknown as string | undefined),
        status: 'crashed',
      });
    }

    // Non-zero / null exit with text present → the agent produced partial output: truncated.
    const cleanExit = result.code === 0;
    const status: HarnessRunResult['status'] = cleanExit ? 'completed' : 'truncated';

    const sid = toSessionId(parsed.sessionId ?? (sessionId as unknown as string | undefined));

    return HarnessRunResult.parse({
      output: parsed.text,
      sessionId: sid,
      status,
      ...(parsed.tokens !== undefined ? { tokensUsed: parsed.tokens } : {}),
    });
  }
}
