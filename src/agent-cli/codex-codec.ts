/**
 * The Codex codec — all of `codex`'s per-CLI knowledge in one place (see {@link AgentCliCodec}).
 *
 * Assumed CLI contract (the EXACT flags may drift between codex versions — this is the seam, not a
 * hard dependency):
 *   harness  (write):  codex exec [resume <id>] --full-auto [--model <m>] <prompt> --json
 *   provider (read):   codex exec --sandbox read-only [--model <m>] <prompt> --json
 *
 * `--full-auto` is MANDATORY for the harness role: `codex exec` defaults to a read-only sandbox, so
 * without it codex can diagnose a fix but never apply one — every iteration would no-diff and the run
 * would abort. The read-only LLM role must NOT get it (it judges, never edits) — it passes
 * `--sandbox read-only`. `--json` makes codex stream JSONL events on stdout (one object per line); we
 * parse those tolerantly via the shared core, so codex ignores the `stream` flag (it is always JSONL).
 * The model flag (when set) precedes the prompt positional so the prompt is never mistaken for it.
 *
 * Codex maps statuses the OTHER way from the flat codecs (no-parse → crashed, non-zero-with-text →
 * truncated), so its {@link AgentCliCodec.classify} is bespoke rather than {@link classifyFlatRun}.
 */

import { coerceSessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import { isRecord, parseAgentOutput, type AgentFields, type FieldExtractor } from './output';
import {
  usageEventFromBlock,
  type AgentStreamEvent,
  type StreamEventExtractor,
} from './stream';
import { accountTokens } from './estimate';
import type { AgentCliCodec } from './codec';
import { isEmptyBreakdown, type TokenBreakdown } from '../domain/usage';

const UNKNOWN_SESSION = 'codex-unknown';

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

/** Read a non-negative integer field, or undefined when absent / not a number. */
function intField(source: Record<string, unknown>, key: string): number | undefined {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
}

/** Per-category split from a codex usage block (input/output + cache buckets when reported). */
function extractBreakdown(obj: Record<string, unknown>): TokenBreakdown | undefined {
  const usage = obj['usage'];
  const source = isRecord(usage) ? usage : obj;
  const breakdown: TokenBreakdown = {};
  const input = intField(source, 'input_tokens') ?? intField(source, 'inputTokens');
  const output = intField(source, 'output_tokens') ?? intField(source, 'outputTokens');
  const cacheRead =
    intField(source, 'cached_input_tokens') ?? intField(source, 'cache_read_input_tokens');
  const cacheWrite = intField(source, 'cache_creation_input_tokens');
  if (input !== undefined) breakdown.input = input;
  if (output !== undefined) breakdown.output = output;
  if (cacheRead !== undefined) breakdown.cacheRead = cacheRead;
  if (cacheWrite !== undefined) breakdown.cacheWrite = cacheWrite;
  return isEmptyBreakdown(breakdown) ? undefined : breakdown;
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
  const breakdown = extractBreakdown(obj);
  if (breakdown !== undefined) fields.breakdown = breakdown;
  return fields;
};

/** Pull incremental delta text from an `assistant.delta`-style line, tolerating nested shapes. */
function codexDeltaText(obj: Record<string, unknown>): string | undefined {
  const delta = obj['delta'];
  if (typeof delta === 'string' && delta.length > 0) return delta;
  if (isRecord(delta) && typeof delta['text'] === 'string' && delta['text'].length > 0) {
    return delta['text'];
  }
  const text = obj['text'];
  return typeof text === 'string' && text.length > 0 ? text : undefined;
}

/** Map one codex `item.*` event (an agent message, a command execution, or reasoning) to events. */
function codexItemEvents(eventType: string, item: Record<string, unknown>): AgentStreamEvent[] {
  const itemType = typeof item['type'] === 'string' ? item['type'] : '';
  const id = typeof item['id'] === 'string' ? item['id'] : undefined;
  const idPart = id !== undefined ? { id } : {};

  if (itemType === 'agent_message') {
    const text = typeof item['text'] === 'string' ? item['text'] : undefined;
    // Emit the full message once, on completion — the streamed deltas already carried the partials.
    return text !== undefined && eventType === 'item.completed' ? [{ kind: 'message', text }] : [];
  }
  if (itemType === 'reasoning') {
    const text = typeof item['text'] === 'string' ? item['text'] : undefined;
    return text !== undefined && eventType === 'item.completed' ? [{ kind: 'reasoning', text }] : [];
  }
  if (itemType === 'command_execution') {
    const command = typeof item['command'] === 'string' ? item['command'] : undefined;
    if (eventType === 'item.started') {
      return [{ kind: 'tool_use', ...idPart, name: 'command', ...(command !== undefined ? { input: command } : {}) }];
    }
    if (eventType === 'item.completed') {
      const output = typeof item['aggregated_output'] === 'string' ? item['aggregated_output'] : '';
      const exitCode = typeof item['exit_code'] === 'number' ? item['exit_code'] : undefined;
      return [
        {
          kind: 'tool_result',
          ...idPart,
          output,
          ...(exitCode !== undefined ? { exitCode, isError: exitCode !== 0 } : {}),
        },
      ];
    }
  }
  return [];
}

/**
 * Codex's STREAM mapping — the streaming sibling of {@link codexExtractor}. Maps codex `--json`
 * JSONL events onto the canonical {@link AgentStreamEvent} taxonomy: `thread.started` → session;
 * `assistant.delta` → message delta; `item.completed` agent messages → message; `command_execution`
 * items → tool_use (started) + tool_result (completed, with exit code); reasoning items → reasoning;
 * `turn.completed` → usage + done. Unknown lines map to `[]`. Never throws (the `StreamTap` guards
 * it regardless).
 */
export const codexStreamExtractor: StreamEventExtractor = (obj) => {
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';

  if (type === 'thread.started' || type === 'session.created' || type === 'session.configured') {
    const sid = extractSessionId(obj);
    return sid !== undefined ? [{ kind: 'session', sessionId: sid }] : [];
  }
  if (type === 'assistant.delta' || type === 'response.output_text.delta') {
    const text = codexDeltaText(obj);
    return text !== undefined ? [{ kind: 'message', text, delta: true }] : [];
  }
  if (type === 'item.started' || type === 'item.completed' || type === 'item.updated') {
    const item = obj['item'];
    return isRecord(item) ? codexItemEvents(type, item) : [];
  }
  if (type === 'turn.completed') {
    const usage = obj['usage'];
    const events: AgentStreamEvent[] = [];
    if (isRecord(usage)) {
      const u = usageEventFromBlock(usage);
      if (u !== null) events.push(u);
    }
    events.push({ kind: 'done', status: 'turn.completed' });
    return events;
  }
  if (type === 'turn.failed' || type === 'error') {
    return [{ kind: 'done', status: type }];
  }
  return [];
};

export const codexCodec: AgentCliCodec = {
  name: 'codex',
  command: 'codex',
  unknownSession: UNKNOWN_SESSION,
  promptOnStdin: false,
  fieldExtractor: codexExtractor,
  streamExtractor: codexStreamExtractor,
  harnessArgs({ prompt, model, sessionId }) {
    const modelArgs = model !== undefined ? ['--model', model] : [];
    if (sessionId !== undefined) {
      return ['exec', 'resume', sessionId, '--full-auto', ...modelArgs, prompt, '--json'];
    }
    return ['exec', '--full-auto', ...modelArgs, prompt, '--json'];
  },
  readonlyArgs({ prompt, model }) {
    return [
      'exec',
      '--sandbox',
      'read-only',
      ...(model !== undefined ? ['--model', model] : []),
      prompt,
      '--json',
    ];
  },
  parse(stdout) {
    return parseAgentOutput(stdout, codexExtractor);
  },
  classify(input) {
    const fallbackSession = input.sessionId as unknown as string | undefined;

    if (input.timedOut === true) {
      const parsed = parseAgentOutput(input.stdout, codexExtractor);
      return HarnessRunResult.parse({
        output: parsed?.text ?? '',
        sessionId: coerceSessionId(parsed?.sessionId ?? fallbackSession, UNKNOWN_SESSION),
        status: 'timeout',
      });
    }

    const parsed = parseAgentOutput(input.stdout, codexExtractor);

    // No parseable JSONL / no text → crashed, but still a valid RunResult.
    if (parsed === null) {
      return HarnessRunResult.parse({
        output: '',
        sessionId: coerceSessionId(fallbackSession, UNKNOWN_SESSION),
        status: 'crashed',
      });
    }

    // Non-zero / null exit with text present → the agent produced partial output: truncated.
    const status: HarnessRunResult['status'] = input.code === 0 ? 'completed' : 'truncated';
    const acct = accountTokens(parsed.tokens, input.estimator);
    return HarnessRunResult.parse({
      output: parsed.text,
      sessionId: coerceSessionId(parsed.sessionId ?? fallbackSession, UNKNOWN_SESSION),
      status,
      ...acct,
      ...(acct.tokenSource === 'reported' && parsed.breakdown !== undefined
        ? { tokenBreakdown: parsed.breakdown }
        : {}),
    });
  },
};
