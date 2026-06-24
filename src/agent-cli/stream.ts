/**
 * Streaming counterpart of the shared agent-CLI output core ({@link ./output.ts}). Where
 * {@link parseAgentOutput} converges every tool's FINAL result into one {@link AgentOutput}
 * abstraction, this module converges every tool's INTERMEDIATE turns into one tool-neutral
 * {@link AgentStreamEvent} taxonomy. The discipline is identical: a defined target shape is the
 * contract, and each adapter/provider supplies only a small {@link StreamEventExtractor} mapping
 * onto it — no tool-specific event shapes leak past the parser.
 *
 * The {@link StreamTap} owns the ENVELOPE MACHINERY once: buffer partial lines across stdout
 * chunks, parse each complete line as JSON, run the extractor, Zod-validate every candidate event
 * at the seam (drop garbage, never throw), and forward survivors to an {@link AgentEventSink}. It
 * is PURE OBSERVABILITY — a throwing extractor or a throwing sink is swallowed so streaming can
 * never crash a run, change its outcome, or alter a verdict. Streaming failure degrades to "no
 * live output", nothing more.
 */

import { z } from 'zod';
import { isRecord, tryJsonObject } from './output';

/**
 * The canonical, tool-neutral event taxonomy — the DEFINED target every tool maps INTO. It is a
 * superset: a tool simply omits the variants it cannot produce. Versioned by extension — add
 * variants/fields as tools expose more, keeping older consumers forward-compatible.
 */
export const AgentStreamEvent = z.discriminatedUnion('kind', [
  /** A session/thread id, usually on an init line before any text. */
  z.object({ kind: z.literal('session'), sessionId: z.string() }),
  /** Assistant text — a full message, or an incremental delta when `delta` is true. */
  z.object({ kind: z.literal('message'), text: z.string(), delta: z.boolean().optional() }),
  /** Thinking/reasoning text, where the tool exposes it. */
  z.object({ kind: z.literal('reasoning'), text: z.string() }),
  /** A tool / command invocation. `input` is the raw, tool-specific argument payload. */
  z.object({
    kind: z.literal('tool_use'),
    id: z.string().optional(),
    name: z.string(),
    input: z.unknown().optional(),
  }),
  /** The result of a tool / command invocation. */
  z.object({
    kind: z.literal('tool_result'),
    id: z.string().optional(),
    output: z.string(),
    exitCode: z.number().optional(),
    isError: z.boolean().optional(),
  }),
  /** Token usage, emitted incrementally or at turn end. */
  z.object({
    kind: z.literal('usage'),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    cachedTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }),
  /** Turn / run complete; `status` carries the tool's own terminal label. */
  z.object({ kind: z.literal('done'), status: z.string() }),
]);

export type AgentStreamEvent = z.infer<typeof AgentStreamEvent>;

/**
 * A per-tool strategy: turn one parsed JSON object (one JSONL line) into zero or more canonical
 * events. The streaming sibling of `FieldExtractor`. Should never throw — the {@link StreamTap}
 * guards it anyway, but a clean mapping returns `[]` for lines it does not recognize.
 */
export type StreamEventExtractor = (obj: Record<string, unknown>) => AgentStreamEvent[];

/** An optional sink the seams forward live events to. The tap guards every call (fail-closed). */
export type AgentEventSink = (event: AgentStreamEvent) => void;

/**
 * Which seam a stream event came from, for phase-tagged consumer surfaces (`[agent]`, `[judge]`…).
 * A Zod enum (not a bare union) so a durable transcript reader can validate the phase at the seam
 * (issue #28) — same "parse at every seam" discipline as the event taxonomy itself.
 */
export const StreamPhase = z.enum(['agent', 'plan', 'compile', 'judge', 'approve', 'preflight']);
export type StreamPhase = z.infer<typeof StreamPhase>;

/** A consumer sink that also receives the originating {@link StreamPhase} (driver/compose side). */
export type PhasedStreamSink = (phase: StreamPhase, event: AgentStreamEvent) => void;

/**
 * Incremental, fail-closed line tap. Feed it raw stdout chunks via {@link push}; it buffers a
 * partial trailing line across chunks (a JSON object can be split mid-line), and on each completed
 * line parses → extracts → Zod-validates → forwards. Call {@link end} once the stream closes to
 * flush a final unterminated line. Re-validating the extractor's output with the canonical schema
 * is deliberate defense-in-depth: even a buggy extractor can never push a malformed event past the
 * seam (invariant: parse at every seam), and every guard is try/caught so observability never
 * takes down the orchestrator.
 */
export class StreamTap {
  #buffer = '';
  readonly #extract: StreamEventExtractor;
  readonly #sink: AgentEventSink;

  constructor(extract: StreamEventExtractor, sink: AgentEventSink) {
    this.#extract = extract;
    this.#sink = sink;
  }

  /** Consume a raw stdout chunk, emitting events for every newline-terminated line it completes. */
  push(chunk: string): void {
    this.#buffer += chunk;
    let nl = this.#buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      this.#emitLine(line);
      nl = this.#buffer.indexOf('\n');
    }
  }

  /** Flush any buffered final line (stdout that ended without a trailing newline). */
  end(): void {
    if (this.#buffer.length === 0) return;
    const line = this.#buffer;
    this.#buffer = '';
    this.#emitLine(line);
  }

  #emitLine(line: string): void {
    const obj = tryJsonObject(line);
    if (obj === null) return;
    let candidates: AgentStreamEvent[];
    try {
      candidates = this.#extract(obj);
    } catch {
      return; // a throwing extractor degrades to "no events for this line", never a crash
    }
    for (const candidate of candidates) {
      const parsed = AgentStreamEvent.safeParse(candidate);
      if (!parsed.success) continue; // drop garbage at the seam, never throw
      try {
        this.#sink(parsed.data);
      } catch {
        /* a throwing sink must never crash the run — diagnostics, not control flow */
      }
    }
  }
}

/** First key whose value is a non-empty string (used by the flat stream mapping). */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/** Read a finite, non-negative integer from the first present key. */
function pickInt(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.trunc(v);
  }
  return undefined;
}

/**
 * Build a `usage` event from a tool's usage block (input/output/cached, plus a total — explicit
 * when present, else the input+output sum). Returns `null` when the block carries no usable count
 * so the caller can omit a contentless event.
 */
export function usageEventFromBlock(usage: Record<string, unknown>): AgentStreamEvent | null {
  const input = pickInt(usage, ['input_tokens', 'inputTokens']);
  const output = pickInt(usage, ['output_tokens', 'outputTokens']);
  const cached = pickInt(usage, [
    'cached_input_tokens',
    'cache_read_input_tokens',
    'cachedTokens',
    'cached_tokens',
  ]);
  const explicitTotal = pickInt(usage, ['total_tokens', 'totalTokens']);
  const total =
    explicitTotal ??
    (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined);
  if (input === undefined && output === undefined && cached === undefined && total === undefined) {
    return null;
  }
  return {
    kind: 'usage',
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    ...(total !== undefined ? { totalTokens: total } : {}),
  };
}

/**
 * The flat-envelope stream mapping — the streaming sibling of `flatExtractor`. A tool that only
 * emits a single FINAL result object degrades gracefully to a couple of events: `session?` →
 * `message` → `usage?` → `done`. Pass `errorKey` (e.g. droid's `is_error`) so a soft failure
 * surfaces as a `done` with status `error`.
 */
export function flatStreamExtractor(opts: { errorKey?: string } = {}): StreamEventExtractor {
  return (obj) => {
    const events: AgentStreamEvent[] = [];
    const session = pickString(obj, ['session_id', 'sessionId']);
    if (session !== undefined) events.push({ kind: 'session', sessionId: session });

    const text = pickString(obj, ['result', 'text', 'response']);
    if (text !== undefined) events.push({ kind: 'message', text });

    const usage = obj['usage'];
    if (isRecord(usage)) {
      const u = usageEventFromBlock(usage);
      if (u !== null) events.push(u);
    }

    // Only a result-bearing object is a terminal envelope — don't manufacture `done` for noise.
    if (text !== undefined || isRecord(usage)) {
      const isError = opts.errorKey !== undefined && obj[opts.errorKey] === true;
      events.push({ kind: 'done', status: isError ? 'error' : 'completed' });
    }
    return events;
  };
}

/** Flatten an Anthropic-SDK `tool_result.content` (a string or an array of text parts) to a string. */
function sdkToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content) {
      if (typeof p === 'string') parts.push(p);
      else if (isRecord(p) && typeof p['text'] === 'string') parts.push(p['text']);
    }
    return parts.join('');
  }
  return '';
}

/** Map an `assistant` event's content blocks (text / thinking / tool_use) to canonical events. */
function sdkAssistantBlocks(message: Record<string, unknown>): AgentStreamEvent[] {
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  const events: AgentStreamEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    const bt = typeof block['type'] === 'string' ? block['type'] : '';
    if (bt === 'text' && typeof block['text'] === 'string') {
      events.push({ kind: 'message', text: block['text'] });
    } else if (bt === 'thinking' && typeof block['thinking'] === 'string') {
      events.push({ kind: 'reasoning', text: block['thinking'] });
    } else if (bt === 'tool_use' && typeof block['name'] === 'string') {
      const id = typeof block['id'] === 'string' ? block['id'] : undefined;
      events.push({
        kind: 'tool_use',
        ...(id !== undefined ? { id } : {}),
        name: block['name'],
        ...(block['input'] !== undefined ? { input: block['input'] } : {}),
      });
    }
  }
  const usage = message['usage'];
  if (isRecord(usage)) {
    const u = usageEventFromBlock(usage);
    if (u !== null) events.push(u);
  }
  return events;
}

/** Map a `user` event's tool_result blocks to canonical `tool_result` events. */
function sdkUserToolResults(message: Record<string, unknown>): AgentStreamEvent[] {
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  const events: AgentStreamEvent[] = [];
  for (const block of content) {
    if (!isRecord(block) || block['type'] !== 'tool_result') continue;
    const id = typeof block['tool_use_id'] === 'string' ? block['tool_use_id'] : undefined;
    events.push({
      kind: 'tool_result',
      ...(id !== undefined ? { id } : {}),
      output: sdkToolResultText(block['content']),
      ...(block['is_error'] === true ? { isError: true } : {}),
    });
  }
  return events;
}

/**
 * The Anthropic agent-SDK stream-json mapping — shared by every tool that emits that envelope
 * (Claude Code, and Factory's droid under `--output-format stream-json`). Maps `system`(init) →
 * session, `assistant` content blocks → message / reasoning / tool_use, `user` tool_result blocks
 * → tool_result, and the closing `result` event → usage + done. Pass `errorKey` so a soft failure
 * (`is_error`) on the result line surfaces as `done` status `error`. Unknown lines map to `[]`.
 *
 * A tool whose `stream-json` only emits a final result envelope (no per-turn assistant lines)
 * degrades to `usage` + `done` for the live view; its final TEXT is still recovered separately by
 * the tool's `FieldExtractor`, so the run is unaffected.
 */
export function sdkStreamExtractor(opts: { errorKey?: string } = {}): StreamEventExtractor {
  return (obj) => {
    const type = typeof obj['type'] === 'string' ? obj['type'] : '';
    if (type === 'system') {
      const sid = obj['session_id'] ?? obj['sessionId'];
      return typeof sid === 'string' ? [{ kind: 'session', sessionId: sid }] : [];
    }
    if (type === 'assistant') {
      const message = obj['message'];
      return isRecord(message) ? sdkAssistantBlocks(message) : [];
    }
    if (type === 'user') {
      const message = obj['message'];
      return isRecord(message) ? sdkUserToolResults(message) : [];
    }
    if (type === 'result') {
      const events: AgentStreamEvent[] = [];
      const usage = obj['usage'];
      if (isRecord(usage)) {
        const u = usageEventFromBlock(usage);
        if (u !== null) events.push(u);
      }
      const isError = opts.errorKey !== undefined && obj[opts.errorKey] === true;
      const subtype = typeof obj['subtype'] === 'string' ? obj['subtype'] : 'completed';
      events.push({ kind: 'done', status: isError ? 'error' : subtype });
      return events;
    }
    return [];
  };
}
