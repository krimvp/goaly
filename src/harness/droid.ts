import { z } from 'zod';
import { coerceSessionId, type SessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import { runProcess } from '../util/spawn';
import type { HarnessAdapter } from './adapter';

/**
 * Seam #1 implementation for Factory's `droid` CLI (https://docs.factory.ai/cli).
 *
 * Assumed CLI contract (verified against droid 0.153.1 — the EXACT flags may drift between
 * versions; this is the seam, not a hard dependency):
 *
 *   Fresh turn:   droid exec --output-format json --auto <level> "<prompt>"
 *   Resume turn:  droid exec --output-format json --auto <level> --session-id <id> "<prompt>"
 *
 * `--output-format json` makes droid emit a single result envelope (the Anthropic agent-SDK
 * shape) on stdout, e.g.:
 *   {"type":"result","subtype":"success","is_error":false,"result":"…",
 *    "session_id":"<uuid>","usage":{"input_tokens":N,"output_tokens":M, …}}
 * We parse it tolerantly (whole-object, object-amid-noise, or a JSONL stream) in
 * {@link parseDroidOutput}.
 *
 * Autonomy: `droid exec` defaults to READ-ONLY, where the agent cannot modify files — useless for
 * a goalorch loop. So we always pass `--auto`. The default is `low` (file create/modify only, no
 * git/installs/builds): it is the least privilege that still lets the agent do its essential job —
 * editing the working tree — while keeping the orchestrator's HEAD-relative `diff()` honest, since
 * `low` cannot `git commit` (a commit would empty `git diff HEAD` and mislead the judge/approver).
 * goalorch runs verification itself, so the agent needs no build/test privileges. Embedders who
 * want the agent to install deps / build / run tests can opt into `medium`/`high` via the
 * constructor (accepting the commit caveat). We never pass `--skip-permissions-unsafe`.
 */

/**
 * Injectable subprocess seam. Returns raw stdout/stderr, the exit code, and a `timedOut` flag.
 * Tests pass a fake so they never spawn a real process.
 */
export type ExecFn = (
  args: string[],
  input: { prompt: string },
) => Promise<{ stdout: string; stderr: string; code: number; timedOut?: boolean }>;

/** Autonomy tiers `droid exec` accepts via `--auto`. */
export type AutonomyLevel = 'low' | 'medium' | 'high';

/** Sentinel session id used whenever we have no usable session from the CLI or the caller. */
const UNKNOWN_SESSION = 'droid-unknown';

/** Default wall-clock budget for a single headless invocation. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** Least-privilege default: edit files, but no git/installs/builds (keeps `diff HEAD` honest). */
const DEFAULT_AUTONOMY: AutonomyLevel = 'low';

/**
 * Tolerant schema for droid's headless JSON. The result text lives in `result` (we also accept a
 * few aliases); `session_id` threads the conversation; `usage` carries token counts; `is_error`
 * flags a soft failure reported in an otherwise-clean (exit-0) envelope. All fields optional and
 * `.passthrough()` so a partial/odd payload still parses.
 */
const DroidUsage = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough();

const DroidJson = z
  .object({
    result: z.string().optional(),
    text: z.string().optional(),
    response: z.string().optional(),
    session_id: z.string().optional(),
    sessionId: z.string().optional(),
    usage: DroidUsage.optional(),
    is_error: z.boolean().optional(),
    subtype: z.string().optional(),
  })
  .passthrough();

export type ParsedDroidOutput = {
  text: string;
  sessionId?: string;
  tokens?: number;
  /** True when droid reported an error result despite a clean exit (→ treat as `truncated`). */
  isError?: boolean;
};

/** Read a single JSON object out of a string, or `null` if it is not a JSON object. */
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
function tokensFromUsage(usage: z.infer<typeof DroidUsage> | undefined): number | undefined {
  if (usage === undefined) return undefined;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const sum = input + output;
  return sum > 0 ? sum : undefined;
}

/** Read a session id from any parsed object, even one that carries no result text. */
function readSessionId(obj: Record<string, unknown>): string | undefined {
  const parsed = DroidJson.safeParse(obj);
  if (!parsed.success) return undefined;
  return parsed.data.session_id ?? parsed.data.sessionId;
}

/** Normalize one parsed JSON object into our minimal output shape, or `null` if it has no text. */
function fromJsonObject(obj: Record<string, unknown>): ParsedDroidOutput | null {
  const parsed = DroidJson.safeParse(obj);
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
    ...(data.is_error !== undefined ? { isError: data.is_error } : {}),
  };
}

/**
 * Tolerantly parse droid headless stdout. Handles three shapes, in order:
 *   1. The whole stdout is one JSON object (`--output-format json`, the common case).
 *   2. A single JSON object surrounded by log/noise lines.
 *   3. A JSONL stream where the LAST result-bearing line is the answer.
 * Returns `null` when no JSON object carrying a `result`/`text`/`response` field is found, so the
 * adapter maps that to `crashed`. Never throws.
 */
export function parseDroidOutput(stdout: string): ParsedDroidOutput | null {
  // Fast path: the entire payload is one JSON object.
  const whole = tryJsonObject(stdout);
  if (whole !== null) {
    const direct = fromJsonObject(whole);
    if (direct !== null) return direct;
  }

  // Line-oriented (stream) path: keep the LAST text-bearing object, but latch the FIRST session id
  // seen on ANY line (an init line can carry session_id with no result text — losing it would
  // break `--session-id` resume; a later per-message id must not clobber the stream's thread id).
  const lines = stdout.split(/\r?\n/);
  let last: ParsedDroidOutput | null = null;
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
 * Build the argv for one headless turn. Flags first, prompt last (so a prompt is never mistaken
 * for a flag value). A `sessionId` is a branded, allowlisted string (it can never begin with `-`),
 * so threading it into `--session-id` is safe.
 */
function buildArgs(prompt: string, auto: AutonomyLevel, sessionId?: SessionId): string[] {
  const args = ['exec', '--output-format', 'json', '--auto', auto];
  if (sessionId !== undefined) args.push('--session-id', sessionId);
  args.push(prompt);
  return args;
}

/**
 * Real subprocess implementation: spawn the `droid` binary via the shared {@link runProcess}
 * helper (which caps output, enforces the timeout, and never rejects). The prompt is delivered as
 * an argv value — droid only reads stdin under `--input-format stream-json`, which we do not use —
 * so we do not write it to stdin.
 */
function defaultExec(timeoutMs: number): ExecFn {
  return async (args, _input) => {
    const r = await runProcess('droid', args, { timeoutMs });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut };
  };
}

/**
 * Headless Factory `droid` harness adapter. Spawns `droid exec` and tolerantly parses its JSON
 * envelope, never throwing on hostile/partial output — failures become
 * `crashed | truncated | timeout` and the loop treats them as a failed iteration.
 */
export class DroidAdapter implements HarnessAdapter {
  readonly name = 'droid';
  readonly #exec: ExecFn;
  readonly #auto: AutonomyLevel;

  constructor(opts: { exec?: ExecFn; timeoutMs?: number; auto?: AutonomyLevel } = {}) {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#exec = opts.exec ?? defaultExec(timeoutMs);
    this.#auto = opts.auto ?? DEFAULT_AUTONOMY;
  }

  async run(prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    const args = buildArgs(prompt, this.#auto, sessionId);
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

    const parsed = parseDroidOutput(result.stdout);

    if (result.timedOut === true) {
      // Salvage any text/session we managed to parse before the kill.
      return HarnessRunResult.parse({
        output: parsed?.text ?? result.stderr,
        sessionId: coerceSessionId(parsed?.sessionId ?? sessionId, UNKNOWN_SESSION),
        status: 'timeout',
      });
    }

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

    // Exit 0 with text, but droid flagged the result as an error → treat as a partial run.
    const status = parsed.isError === true ? 'truncated' : 'completed';
    return HarnessRunResult.parse({
      output: parsed.text,
      sessionId: coerceSessionId(parsed.sessionId ?? sessionId, UNKNOWN_SESSION),
      status,
      ...(parsed.tokens !== undefined ? { tokensUsed: parsed.tokens } : {}),
    });
  }
}
