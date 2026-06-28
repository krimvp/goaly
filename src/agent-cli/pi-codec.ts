/**
 * The pi (pi.dev) codec — all of `pi`'s per-CLI knowledge in one place (see {@link AgentCliCodec}).
 * `pi` is a provider-agnostic coding assistant (https://pi.dev): one CLI that drives ANY model from
 * ANY provider (anthropic, openai-codex, google, ollama, groq, …).
 *
 * Assumed CLI contract (verified against pi 0.55.3 — the EXACT flags may drift between versions;
 * this is the seam, not a hard dependency):
 *   harness  (write):  pi --print --mode json --tools read,edit,write,grep,find,ls [--model <m>] [--continue] "<prompt>"
 *   provider (read):   pi --print --mode json --tools read,grep,find,ls [--model <m>] "<prompt>"
 *
 * MODEL = PROVIDER + MODEL, on ONE flag. Unlike claude/codex (built-in provider, namespaced models),
 * pi is provider-agnostic, but its `--model` accepts the `provider/id` form (e.g.
 * `--model "anthropic/claude-opus-4-8"`, `--model "ollama/qwen3:8b"`) and infers the provider from it
 * — so goaly's single `--model` string fully selects provider+model with NO extra flag (model stays
 * "wiring, not contract"). Omit `--model` and pi uses its own configured default
 * (`~/.pi/agent/settings.json`). Credentials are the operator's responsibility via env
 * (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, …) / pi's own auth config — the same
 * boundary claude & codex already assume.
 *
 * TOOLS are the autonomy knob (pi's analogue of claude's `--permission-mode acceptEdits` / codex's
 * `--full-auto` / droid's `--auto`). pi defaults to `read,bash,edit,write`, but:
 *   - the WRITE/harness role passes `--tools read,edit,write,grep,find,ls` — full file-editing power
 *     but NO `bash`, the least privilege that still lets the agent edit the tree while keeping the
 *     orchestrator's HEAD-relative `diff()` honest (without `bash` the agent cannot `git commit`,
 *     which would empty `git diff HEAD` and mislead the judge/approver). This mirrors claude
 *     `acceptEdits` (no Bash) and droid `--auto low` (no git/installs/builds).
 *   - the READ-ONLY LLM role passes `--tools read,grep,find,ls` — it can inspect the tree but never
 *     `edit`/`write`/`bash`, so a judge/approver/compiler can never mutate the diff it is judging.
 *
 * STRUCTURED OUTPUT: `--mode json` emits a JSONL EVENT STREAM (one object per line: `session`,
 * `agent_start`, `turn_start`, `message_start`/`message_end` (role user|assistant), `turn_end`,
 * `agent_end`). It is already a per-turn stream, so — like codex's `--json` — pi IGNORES the `stream`
 * flag (the same output backs both the final-result parse and the live {@link StreamTap}). The
 * session id rides the `session` event's `id`; the final text is the assistant message's `content[]`
 * text blocks; usage rides each assistant message's `usage` block (pi's bare camelCase keys
 * `input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`, which the flat extractor's key names miss
 * — hence the custom {@link piExtractor}).
 *
 * SESSION RESUME: pi has no resume-by-id flag (its `--session <path>` wants a file and `--resume` is
 * an interactive TUI), so the headless resume is `--continue`, which continues the most recent
 * session for the current cwd (pi namespaces its default session dir BY cwd). goaly runs pi inside
 * the workspace, so "latest session for this cwd" is this loop's conversation; the presence of a
 * threaded `sessionId` (pi's `id`, captured on turn 1) is what signals "resume" → add `--continue`.
 */

import { breakdownTotal, isEmptyBreakdown, type TokenBreakdown } from '../domain/usage';
import { isRecord, parseAgentOutput, type AgentFields, type FieldExtractor } from './output';
import { type AgentStreamEvent, type StreamEventExtractor } from './stream';
import { classifyFlatRun, type AgentCliCodec } from './codec';

const UNKNOWN_SESSION = 'pi-unknown';

/** Read-only tool set: a judge/approver/compiler may inspect the tree but never mutate it. */
const READONLY_TOOLS = 'read,grep,find,ls';
/** Write tool set: full file editing, but NO `bash` (so the agent can't `git commit` and empty the diff). */
const WRITE_TOOLS = 'read,edit,write,grep,find,ls';

/** Read a non-negative integer field, or undefined when it is absent / not a number. */
function intField(source: Record<string, unknown>, key: string): number | undefined {
  const v = source[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.trunc(v) : undefined;
}

/**
 * pi's `usage` block uses BARE camelCase keys (`input`/`output`/`cacheRead`/`cacheWrite`/
 * `totalTokens`), not the `input_tokens`/`usage.*_tokens` names the shared `flatExtractor` reads —
 * so pi needs its own reader. Returns the all-inclusive total (explicit `totalTokens` wins, else the
 * sum of present categories) plus the per-category split. Never throws.
 */
function piUsage(usage: Record<string, unknown> | undefined): {
  tokens?: number;
  breakdown?: TokenBreakdown;
} {
  if (usage === undefined) return {};
  const breakdown: TokenBreakdown = {};
  const input = intField(usage, 'input');
  const output = intField(usage, 'output');
  const cacheRead = intField(usage, 'cacheRead');
  const cacheWrite = intField(usage, 'cacheWrite');
  if (input !== undefined) breakdown.input = input;
  if (output !== undefined) breakdown.output = output;
  if (cacheRead !== undefined) breakdown.cacheRead = cacheRead;
  if (cacheWrite !== undefined) breakdown.cacheWrite = cacheWrite;
  const summed = breakdownTotal(breakdown);
  const tokens = intField(usage, 'totalTokens') ?? summed;
  const result: { tokens?: number; breakdown?: TokenBreakdown } = {};
  if (tokens !== undefined && tokens > 0) result.tokens = tokens;
  if (!isEmptyBreakdown(breakdown)) result.breakdown = breakdown;
  return result;
}

/** Join the `text` blocks of a pi message's `content[]`; undefined when it carries no text. */
function contentText(message: Record<string, unknown>): string | undefined {
  const content = message['content'];
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(block['text']);
    }
  }
  const joined = parts.join('');
  return joined.length > 0 ? joined : undefined;
}

/**
 * The assistant message carried by a pi event: directly under `message` (message_start/message_end/
 * turn_end) or the LAST assistant entry of an `agent_end` `messages[]`. User messages are ignored so
 * the prompt echo is never mistaken for a result.
 */
function assistantMessage(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const message = obj['message'];
  if (isRecord(message) && message['role'] === 'assistant') return message;
  const messages = obj['messages'];
  if (Array.isArray(messages)) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (isRecord(m) && m['role'] === 'assistant') return m;
    }
  }
  return undefined;
}

/**
 * pi's field strategy. The session id comes ONLY from the `session` event's `id` (never a generic
 * `id`, which would clobber the latched session on a later line); the text, tokens, and soft-error
 * flag come from the assistant message. The shared envelope machinery (JSONL walk, latch-first
 * session, keep-last-text, accrue tokens) lives in {@link parseAgentOutput}.
 */
export const piExtractor: FieldExtractor = (obj) => {
  const fields: AgentFields = {};
  if (obj['type'] === 'session' && typeof obj['id'] === 'string' && obj['id'].length > 0) {
    fields.sessionId = obj['id'];
  }
  const assistant = assistantMessage(obj);
  if (assistant !== undefined) {
    const text = contentText(assistant);
    if (text !== undefined) fields.text = text;
    const usage = assistant['usage'];
    const { tokens, breakdown } = piUsage(isRecord(usage) ? usage : undefined);
    if (tokens !== undefined) fields.tokens = tokens;
    if (breakdown !== undefined) fields.breakdown = breakdown;
    // A model/provider error makes pi exit 0 with a `stopReason: 'error'` (+ `errorMessage`) and no
    // content — flag it so an error WITH salvaged text still classifies as `truncated`, not green.
    if (assistant['stopReason'] === 'error' || typeof assistant['errorMessage'] === 'string') {
      fields.isError = true;
    }
  }
  return fields;
};

/** Build a canonical `usage` event from a pi `usage` block (bare camelCase keys). */
function piUsageEvent(usage: Record<string, unknown>): AgentStreamEvent | null {
  const input = intField(usage, 'input');
  const output = intField(usage, 'output');
  const cached = intField(usage, 'cacheRead');
  const explicitTotal = intField(usage, 'totalTokens');
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

/** Map an assistant message's content blocks (text / thinking / tool_use) + usage to canonical events. */
function assistantStreamEvents(message: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const content = message['content'];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block)) continue;
      const bt = typeof block['type'] === 'string' ? block['type'] : '';
      if (bt === 'text' && typeof block['text'] === 'string' && block['text'].length > 0) {
        events.push({ kind: 'message', text: block['text'] });
      } else if (bt === 'thinking' || bt === 'reasoning') {
        // pi puts reasoning under `thinking` (not `text`); tolerate both shapes.
        const reasoning =
          typeof block['thinking'] === 'string'
            ? block['thinking']
            : typeof block['text'] === 'string'
              ? block['text']
              : undefined;
        if (reasoning !== undefined && reasoning.length > 0) {
          events.push({ kind: 'reasoning', text: reasoning });
        }
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
  }
  const usage = message['usage'];
  if (isRecord(usage)) {
    const u = piUsageEvent(usage);
    if (u !== null) events.push(u);
  }
  return events;
}

/** Best-effort map of a pi `turn_end.toolResults[]` entry to a canonical `tool_result` event. */
function toolResultEvent(tr: Record<string, unknown>): AgentStreamEvent | null {
  const output =
    typeof tr['output'] === 'string'
      ? tr['output']
      : typeof tr['content'] === 'string'
        ? tr['content']
        : typeof tr['result'] === 'string'
          ? tr['result']
          : undefined;
  if (output === undefined) return null;
  const id = typeof tr['id'] === 'string' ? tr['id'] : undefined;
  return {
    kind: 'tool_result',
    ...(id !== undefined ? { id } : {}),
    output,
    ...(tr['isError'] === true ? { isError: true } : {}),
  };
}

/**
 * pi's STREAM mapping — the streaming sibling of {@link piExtractor}. Maps pi's `--mode json` JSONL
 * events onto the canonical {@link AgentStreamEvent} taxonomy: `session` → session; assistant
 * `message_end` → message / reasoning / tool_use + usage; `turn_end` → tool_result(s) + done (the
 * turn's `stopReason`). `message_start` is skipped (its content is empty) and unknown lines map to
 * `[]`. Never throws (the `StreamTap` guards it regardless). The `toolResults` shape is unverified
 * (a no-tools run carries `toolResults: []`), so its mapping is best-effort — a wrong guess simply
 * yields no event (Zod drops it at the seam).
 */
export const piStreamExtractor: StreamEventExtractor = (obj) => {
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';
  if (type === 'session') {
    const id = obj['id'];
    return typeof id === 'string' && id.length > 0 ? [{ kind: 'session', sessionId: id }] : [];
  }
  if (type === 'message_end') {
    const message = obj['message'];
    return isRecord(message) && message['role'] === 'assistant'
      ? assistantStreamEvents(message)
      : [];
  }
  if (type === 'turn_end') {
    const events: AgentStreamEvent[] = [];
    const toolResults = obj['toolResults'];
    if (Array.isArray(toolResults)) {
      for (const tr of toolResults) {
        if (!isRecord(tr)) continue;
        const e = toolResultEvent(tr);
        if (e !== null) events.push(e);
      }
    }
    const message = obj['message'];
    const stopReason =
      isRecord(message) && typeof message['stopReason'] === 'string' ? message['stopReason'] : 'turn_end';
    events.push({ kind: 'done', status: stopReason });
    return events;
  }
  return [];
};

export const piCodec: AgentCliCodec = {
  name: 'pi',
  command: 'pi',
  unknownSession: UNKNOWN_SESSION,
  promptOnStdin: false,
  fieldExtractor: piExtractor,
  streamExtractor: piStreamExtractor,
  harnessArgs({ prompt, model, sessionId }) {
    // `--mode json` is already a per-turn JSONL stream, so the `stream` flag is ignored (like codex's
    // `--json`). Flags first, prompt last (so a prompt is never mistaken for a flag value).
    const args = ['--print', '--mode', 'json', '--tools', WRITE_TOOLS];
    if (model !== undefined) args.push('--model', model);
    if (sessionId !== undefined) args.push('--continue');
    args.push(prompt);
    return args;
  },
  readonlyArgs({ prompt, model }) {
    return [
      '--print',
      '--mode',
      'json',
      '--tools',
      READONLY_TOOLS,
      ...(model !== undefined ? ['--model', model] : []),
      prompt,
    ];
  },
  parse(stdout) {
    return parseAgentOutput(stdout, piExtractor);
  },
  classify(input) {
    return classifyFlatRun({
      parsed: parseAgentOutput(input.stdout, piExtractor),
      code: input.code,
      stderr: input.stderr,
      timedOut: input.timedOut,
      sessionId: input.sessionId,
      unknownSession: UNKNOWN_SESSION,
      estimator: input.estimator,
    });
  },
  interactiveResume() {
    // pi has no resume-by-id flag; the headless harness uses `--continue` (latest session for the
    // current cwd). The id is not addressable, so it is intentionally unused — print the honest caveat.
    return {
      command: 'pi --continue',
      caveat: 'pi resumes the LATEST session for the current directory only — run it from this workspace',
    };
  },
};
