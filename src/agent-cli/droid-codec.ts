/**
 * The Factory `droid` codec — all of `droid`'s per-CLI knowledge in one place
 * (see {@link AgentCliCodec}). https://docs.factory.ai/cli
 *
 * Assumed CLI contract (verified LIVE against droid 0.164.0 — the launcher self-updates, so the
 * engine version is what matters; the EXACT flags may drift between versions):
 *   harness  (write):  droid exec --output-format json --auto <level> [--model <m>] [--fork <id>] "<prompt>"
 *   provider (read):   droid exec --output-format json [--model <m>] "<prompt>"   (no --auto)
 *
 * FINAL envelope (`--output-format json`): one flat object — `result` / `session_id` / `usage`
 * (input/output + both cache buckets) / `is_error` — so the final-result parse builds on the shared
 * {@link flatExtractor}.
 *
 * STREAMING (`--output-format stream-json`) is droid-NATIVE, **not** the Anthropic agent-SDK
 * envelope (observed live on 0.164.0; older docs assumed the SDK shape):
 *   {type:"system",subtype:"init",session_id,...}         → session
 *   {type:"message",role:"user"|"assistant",text}          → message (assistant ONLY — the user
 *                                                            line echoes the prompt back)
 *   {type:"reasoning",text}                                → reasoning (droid may emit the same
 *                                                            line twice; mapped as-is)
 *   {type:"tool_call",id,toolName,parameters}              → tool_use
 *   {type:"tool_result",id,value,isError}                  → tool_result
 *   {type:"completion",finalText,usage,session_id}         → usage + done (finalText is the result)
 * The field extractor is therefore type-aware: it must NOT treat the user echo or reasoning lines
 * as result text (a stream truncated right after the echo would otherwise "complete" with the
 * caller's own prompt as output), and it reads `finalText` from the closing `completion` line.
 *
 * SESSION CONTINUITY is via `--fork <id>`, not `--session-id <id>`: on droid 0.164.0,
 * `exec -s <id>` fetches the session from Factory's backend and FAILS for locally-created exec
 * sessions ("Failed to fetch session" — a silent exit 1 with empty stdout/stderr; the error only
 * lands in `~/.factory/logs`). `--fork <id>` loads the LOCAL transcript and continues it under a
 * fresh session id (verified live: the forked turn recalls the prior conversation). The envelope
 * returns the newly-minted id and goaly threads whatever id each run reports, so multi-iteration
 * continuity is a fork CHAIN — no consumer assumes session-id stability. Had we kept `-s`, every
 * continuation turn would crash and the loop would re-thread the same dead id (crash loop).
 *
 * Autonomy: `droid exec` defaults to READ-ONLY (cannot modify files) — useless for a goaly loop — so
 * the harness role always passes `--auto`. The default is `low` (file create/modify only, no
 * git/installs/builds): the least privilege that still lets the agent edit the working tree while
 * keeping the orchestrator's HEAD-relative `diff()` honest (`low` cannot `git commit`, which would
 * empty `git diff HEAD` and mislead the judge/approver). Embedders can opt into `medium`/`high`. The
 * read-only LLM role exploits the read-only default: it omits `--auto` so a judge/approver can never
 * mutate the tree it is judging. We never pass `--skip-permissions-unsafe`.
 */

import { parseAgentOutput, flatExtractor, isRecord, type FieldExtractor } from './output';
import { usageEventFromBlock, type AgentStreamEvent, type StreamEventExtractor } from './stream';
import { classifyFlatRun, type AgentCliCodec } from './codec';

/** Autonomy tiers `droid exec` accepts via `--auto`. */
export type AutonomyLevel = 'low' | 'medium' | 'high';

/** Least-privilege default: edit files, but no git/installs/builds (keeps `diff HEAD` honest). */
export const DEFAULT_AUTONOMY: AutonomyLevel = 'low';

const UNKNOWN_SESSION = 'droid-unknown';

/** The flat strategy covers the plain `json` envelope; the droid extractor gates it per line type. */
const flat = flatExtractor({ errorKey: 'is_error' });

/**
 * Field strategy for droid's envelopes — the flat mapping, made STREAM-AWARE. The stream-json lines
 * reuse generic key names for non-result content (`text` on the user prompt echo and on reasoning
 * lines), so the extractor gates on `type`: only assistant messages and the closing `completion`
 * line (via `finalText`) may bear result text. Everything else still contributes session id / usage.
 */
const fieldExtractor: FieldExtractor = (obj) => {
  const fields = flat(obj);
  const type = obj['type'];
  if (type === 'message' && obj['role'] !== 'assistant') {
    delete fields.text; // the stream echoes the USER prompt as a message line — never result text
  } else if (type === 'reasoning' || type === 'tool_call' || type === 'tool_result') {
    delete fields.text; // thinking / tool traffic, not a result
  } else if (type === 'completion' && typeof obj['finalText'] === 'string') {
    fields.text = obj['finalText']; // the stream's closing line carries the result as `finalText`
  }
  return fields;
};

/** droid's native stream-json mapping onto the canonical {@link AgentStreamEvent} taxonomy. */
const streamExtractor: StreamEventExtractor = (obj) => {
  const type = typeof obj['type'] === 'string' ? obj['type'] : '';
  if (type === 'system') {
    // Only the init line announces the session; suppress any other system subtypes (telemetry).
    const subtype = obj['subtype'];
    if (typeof subtype === 'string' && subtype !== 'init') return [];
    const sid = obj['session_id'] ?? obj['sessionId'];
    return typeof sid === 'string' ? [{ kind: 'session', sessionId: sid }] : [];
  }
  if (type === 'message') {
    // The user line echoes the prompt back — only assistant text is agent output.
    if (obj['role'] !== 'assistant' || typeof obj['text'] !== 'string') return [];
    return [{ kind: 'message', text: obj['text'] }];
  }
  if (type === 'reasoning') {
    return typeof obj['text'] === 'string' ? [{ kind: 'reasoning', text: obj['text'] }] : [];
  }
  if (type === 'tool_call') {
    const name = typeof obj['toolName'] === 'string' ? obj['toolName'] : undefined;
    if (name === undefined) return [];
    const id = typeof obj['id'] === 'string' ? obj['id'] : undefined;
    return [
      {
        kind: 'tool_use',
        ...(id !== undefined ? { id } : {}),
        name,
        ...(obj['parameters'] !== undefined ? { input: obj['parameters'] } : {}),
      },
    ];
  }
  if (type === 'tool_result') {
    const id = typeof obj['id'] === 'string' ? obj['id'] : undefined;
    const value = obj['value'];
    const output =
      typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
    return [
      {
        kind: 'tool_result',
        ...(id !== undefined ? { id } : {}),
        output,
        ...(typeof obj['isError'] === 'boolean' ? { isError: obj['isError'] } : {}),
      },
    ];
  }
  if (type === 'completion' || type === 'result') {
    // `completion` closes a stream-json run; a plain-`json` `result` envelope maps the same way.
    const events: AgentStreamEvent[] = [];
    const usage = obj['usage'];
    if (isRecord(usage)) {
      const u = usageEventFromBlock(usage);
      if (u !== null) events.push(u);
    }
    const isError = obj['is_error'] === true || obj['isError'] === true;
    const subtype = typeof obj['subtype'] === 'string' ? obj['subtype'] : 'completed';
    events.push({ kind: 'done', status: isError ? 'error' : subtype });
    return events;
  }
  return [];
};

/**
 * Build a droid codec for a given autonomy level (the only per-instance knob). The extractors,
 * read-only argv, and classifier are autonomy-independent, so the read-only LLM role can use any
 * instance (e.g. the default {@link droidCodec}).
 */
export function makeDroidCodec(auto: AutonomyLevel = DEFAULT_AUTONOMY): AgentCliCodec {
  return {
    name: 'droid',
    command: 'droid',
    unknownSession: UNKNOWN_SESSION,
    promptOnStdin: false,
    fieldExtractor,
    streamExtractor,
    harnessArgs({ prompt, model, sessionId, stream }) {
      // Flags first, prompt last (so a prompt is never mistaken for a flag value). A sessionId is a
      // branded, allowlisted string (it can never begin with `-`), so `--fork <id>` is safe.
      // Continuity is `--fork`, NOT `--session-id` — see the header (0.164.0 resume regression).
      const args = ['exec', '--output-format', stream ? 'stream-json' : 'json', '--auto', auto];
      if (model !== undefined) args.push('--model', model);
      if (sessionId !== undefined) args.push('--fork', sessionId);
      args.push(prompt);
      return args;
    },
    readonlyArgs({ prompt, model }) {
      return ['exec', '--output-format', 'json', ...(model !== undefined ? ['--model', model] : []), prompt];
    },
    parse(stdout) {
      return parseAgentOutput(stdout, fieldExtractor);
    },
    classify(input) {
      return classifyFlatRun({
        parsed: parseAgentOutput(input.stdout, fieldExtractor),
        code: input.code,
        stderr: input.stderr,
        timedOut: input.timedOut,
        sessionId: input.sessionId,
        unknownSession: UNKNOWN_SESSION,
        estimator: input.estimator,
      });
    },
    interactiveResume(id) {
      // The documented top-level flag is `-r/--resume <id>` (`--session-id` exists only on `exec`).
      return { command: `droid --resume ${id}` };
    },
  };
}

/** The default-autonomy (`low`) droid codec — used by the read-only LLM role and as the base. */
export const droidCodec = makeDroidCodec();

/** Streaming sibling of `droidExtractor`, re-exported for embedders/tests. */
export const droidStreamExtractor = streamExtractor;

/** Field strategy for droid's flat result envelope, re-exported for embedders/tests. */
export const droidExtractor = fieldExtractor;
