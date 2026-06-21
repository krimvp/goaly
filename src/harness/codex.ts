import { spawn } from 'node:child_process';
import { SessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import type { HarnessAdapter } from './adapter';
import {
  isRecord,
  parseAgentOutput,
  type AgentFields,
  type AgentOutput,
  type FieldExtractor,
} from '../agent-cli/output';

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
 *   New conversation:  `codex exec --full-auto [--model <m>] <prompt> --json`
 *   Resume a thread:   `codex exec resume <sessionId> --full-auto [--model <m>] <prompt> --json`
 *
 * `--full-auto` is mandatory for the HARNESS role: `codex exec` defaults to a read-only sandbox,
 * so without it codex can diagnose a fix but never apply one — every iteration would no-diff and
 * the run would abort. `--full-auto` is codex's alias for a workspace-write sandbox with automatic
 * execution. (The separate, read-only `LlmProvider` role must NOT get it — it uses
 * `--sandbox read-only`; see `codexCompletionArgs` in `compose.ts`.)
 * `--json` makes codex stream JSONL events on stdout, one JSON object per line. We parse those
 * lines tolerantly via the shared core. The model flag (when set) precedes the prompt positional
 * so the prompt is never mistaken for the model value.
 */
function buildArgs(prompt: string, model: string | undefined, sessionId?: SessionId): string[] {
  const modelArgs = model !== undefined ? ['--model', model] : [];
  if (sessionId !== undefined) {
    return [
      'exec',
      'resume',
      sessionId as unknown as string,
      '--full-auto',
      ...modelArgs,
      prompt,
      '--json',
    ];
  }
  return ['exec', '--full-auto', ...modelArgs, prompt, '--json'];
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
  // Current codex (>=0.x) streams its result nested: a top-level event
  // `{ type: 'item.completed', item: { type: 'agent_message', text } }`. Recurse into `item` so
  // the final assistant message is found (command_execution items carry no text and are skipped).
  const item = obj['item'];
  if (isRecord(item)) {
    const inner = extractText(item);
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

/**
 * Codex's field strategy: tolerant of nested message/content/delta shapes and codex's thread-id
 * session keys. The shared envelope machinery (whole-object/JSONL, latch-first-session,
 * keep-last-text) lives in {@link parseAgentOutput}.
 */
export const codexExtractor: FieldExtractor = (obj) => {
  const fields: AgentFields = {};
  const text = extractText(obj);
  if (text !== undefined) fields.text = text;
  const sid = extractSessionId(obj);
  if (sid !== undefined) fields.sessionId = sid;
  const tokens = extractTokens(obj);
  if (tokens !== undefined) fields.tokens = tokens;
  return fields;
};

/**
 * Tolerantly walk codex `--json` JSONL stdout. Returns the final assistant/result text, plus a
 * session/thread id and token usage when present, or `null` when no line is valid JSON or no
 * usable text was found. Never throws. A thin wrapper over the shared {@link parseAgentOutput}.
 */
export function parseCodexOutput(stdout: string): AgentOutput | null {
  return parseAgentOutput(stdout, codexExtractor);
}

/** Coerce an arbitrary candidate string into a valid SessionId, falling back when invalid. */
function toSessionId(candidate: string | undefined): SessionId {
  const value = candidate !== undefined && candidate.length > 0 ? candidate : SESSION_FALLBACK;
  const parsed = SessionId.safeParse(value);
  return parsed.success ? parsed.data : SessionId.parse(SESSION_FALLBACK);
}

/**
 * Codex headless adapter. Never throws, classifies output into
 * `completed | crashed | truncated | timeout`, and always returns a Zod-parsed HarnessRunResult.
 * The subprocess is injectable so tests never spawn a real process.
 */
export class CodexAdapter implements HarnessAdapter {
  readonly name = 'codex';
  readonly #exec: ExecFn;
  readonly #timeoutMs: number;
  readonly #model: string | undefined;

  constructor(opts?: { exec?: ExecFn; timeoutMs?: number; model?: string }) {
    this.#timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#exec = opts?.exec ?? defaultExec(this.#timeoutMs);
    this.#model = opts?.model;
  }

  async run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    const args = buildArgs(prompt, this.#model, sessionId);

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
