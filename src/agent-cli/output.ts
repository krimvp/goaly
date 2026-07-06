/**
 * Shared tolerant parser for headless coding-agent CLI output. Every agent CLI (claude, codex,
 * droid) emits the same essential signal — a final assistant text, a session/thread id, token
 * usage — wrapped in a slightly different JSON/JSONL envelope. This module owns the ENVELOPE
 * MACHINERY (whole-object fast path, JSONL line walk, latch-first-session, keep-last-text,
 * accrue-tokens) once; each tool supplies only a small {@link FieldExtractor} strategy that knows
 * its own field names/shapes. Used by both the harness adapters (seam #1) and the read-only
 * codex/droid LLM providers — share the mechanism, not the seam.
 */

import type { TokenBreakdown } from '../domain/usage';
import { breakdownTotal } from '../domain/usage';

/** The minimal signal we salvage from one agent run, regardless of tool. */
export type AgentOutput = {
  text: string;
  sessionId?: string;
  /** All-inclusive reported total (input + output + cache), or a provider-supplied `total_tokens`. */
  tokens?: number;
  /** Per-category split of `tokens` when the CLI reports one (input/output/cache-read/cache-write). */
  breakdown?: TokenBreakdown;
  /** Some CLIs (droid) flag a soft failure on an otherwise-clean exit. */
  isError?: boolean;
};

/** Fields a per-tool extractor may pull from a single parsed JSON object (all optional). */
export type AgentFields = {
  text?: string;
  sessionId?: string;
  tokens?: number;
  breakdown?: TokenBreakdown;
  isError?: boolean;
};

/** A per-tool strategy: turn one parsed JSON object into {@link AgentFields}. Must never throw. */
export type FieldExtractor = (obj: Record<string, unknown>) => AgentFields;

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read a single JSON object out of a string, or `null` if it is not a JSON object. */
export function tryJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** Assemble the final output, preferring the text-bearing object's own session/tokens/breakdown. */
function assemble(
  fields: AgentFields,
  session?: string,
  tokens?: number,
  breakdown?: TokenBreakdown,
): AgentOutput {
  const out: AgentOutput = { text: fields.text ?? '' };
  const sid = fields.sessionId ?? session;
  if (sid !== undefined) out.sessionId = sid;
  const tok = fields.tokens ?? tokens;
  if (tok !== undefined) out.tokens = tok;
  const bd = fields.breakdown ?? breakdown;
  if (bd !== undefined) out.breakdown = bd;
  if (fields.isError !== undefined) out.isError = fields.isError;
  return out;
}

/**
 * Tolerantly parse agent-CLI stdout, in order:
 *   1. the whole stdout is one JSON object (the common `--output-format json` case);
 *   2. a single JSON object amid log/noise lines;
 *   3. a JSONL stream — keep the LAST text-bearing object, latch the FIRST session id seen on any
 *      line (an init line carries the thread id with no text), accrue the latest token count.
 * A "text-bearing" object is whatever the {@link FieldExtractor} chooses to emit `text` for — the
 * flat extractor treats an empty string as present (claude/droid), codex requires non-empty.
 * Returns `null` when no line is valid JSON or none carries text. NEVER throws — a malformed
 * grader is never a green; the adapter/provider maps `null` to a failure.
 */
export function parseAgentOutput(stdout: string, extract: FieldExtractor): AgentOutput | null {
  // 1. Fast path: the entire payload is one JSON object that carries text.
  const whole = tryJsonObject(stdout);
  if (whole !== null) {
    const fields = extract(whole);
    if (fields.text !== undefined) return assemble(fields);
  }

  // 2/3. Line-oriented scan.
  let last: AgentFields | null = null;
  let firstSession: string | undefined;
  let latestTokens: number | undefined;
  let latestBreakdown: TokenBreakdown | undefined;
  let sawJson = false;
  for (const line of stdout.split(/\r?\n/)) {
    const obj = tryJsonObject(line);
    if (obj === null) continue;
    sawJson = true;
    const fields = extract(obj);
    if (firstSession === undefined && fields.sessionId !== undefined) firstSession = fields.sessionId;
    if (fields.tokens !== undefined) latestTokens = fields.tokens;
    if (fields.breakdown !== undefined) latestBreakdown = fields.breakdown;
    if (fields.text !== undefined) last = fields;
  }
  if (!sawJson || last === null) return null;
  return assemble(last, firstSession, latestTokens, latestBreakdown);
}

/** Pull the first key whose value is a string (an empty string still counts as present). */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

/** Read a non-negative integer field, or undefined when it is absent / not a number. */
function intField(usage: Record<string, unknown>, key: string): number | undefined {
  const v = usage[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
}

/**
 * Per-category split of a `usage` block. Reads input/output and BOTH cache buckets
 * (`cache_read_input_tokens`, `cache_creation_input_tokens`, plus their camelCase aliases) — the
 * cache tokens the old input+output math dropped. Returns the breakdown plus the all-inclusive total
 * (a provider `total_tokens` wins; otherwise the sum of every present category). Both `undefined`
 * when the block reports nothing.
 */
function flatUsage(
  usage: Record<string, unknown> | undefined,
): { tokens?: number; breakdown?: TokenBreakdown } {
  if (usage === undefined) return {};
  const breakdown: TokenBreakdown = {};
  const input = intField(usage, 'input_tokens') ?? intField(usage, 'inputTokens');
  const output = intField(usage, 'output_tokens') ?? intField(usage, 'outputTokens');
  const cacheRead =
    intField(usage, 'cache_read_input_tokens') ??
    intField(usage, 'cached_input_tokens') ??
    intField(usage, 'cacheReadInputTokens');
  const cacheWrite =
    intField(usage, 'cache_creation_input_tokens') ?? intField(usage, 'cacheCreationInputTokens');
  if (input !== undefined) breakdown.input = input;
  if (output !== undefined) breakdown.output = output;
  if (cacheRead !== undefined) breakdown.cacheRead = cacheRead;
  if (cacheWrite !== undefined) breakdown.cacheWrite = cacheWrite;

  const explicitTotal = intField(usage, 'total_tokens') ?? intField(usage, 'totalTokens');
  const summed = breakdownTotal(breakdown);
  const tokens = explicitTotal ?? summed;
  const result: { tokens?: number; breakdown?: TokenBreakdown } = {};
  if (tokens !== undefined && tokens > 0) result.tokens = tokens;
  if (summed !== undefined) result.breakdown = breakdown;
  return result;
}

/**
 * The flat-envelope strategy: text under `result`/`text`/`response`, the session under
 * `session_id`/`sessionId`, tokens in a `usage` block, and an optional boolean soft-error key
 * (droid's `is_error`). Claude uses it as-is; droid LAYERS a line-type gate on top (its stream-json
 * reuses `text` for non-result lines — see droid-codec.ts).
 */
export function flatExtractor(opts: { errorKey?: string } = {}): FieldExtractor {
  return (obj) => {
    const fields: AgentFields = {};
    const text = pickString(obj, ['result', 'text', 'response']);
    if (text !== undefined) fields.text = text;
    const session = pickString(obj, ['session_id', 'sessionId']);
    if (session !== undefined) fields.sessionId = session;
    const usage = obj['usage'];
    const { tokens, breakdown } = flatUsage(isRecord(usage) ? usage : undefined);
    if (tokens !== undefined) fields.tokens = tokens;
    if (breakdown !== undefined) fields.breakdown = breakdown;
    if (opts.errorKey !== undefined) {
      const e = obj[opts.errorKey];
      if (typeof e === 'boolean') fields.isError = e;
    }
    return fields;
  };
}
