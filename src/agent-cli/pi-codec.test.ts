import { describe, it, expect } from 'vitest';
import { SessionId } from '../domain/ids';
import { piCodec, piExtractor, piStreamExtractor } from './pi-codec';
import { parseAgentOutput } from './output';
import { StreamTap, type AgentStreamEvent } from './stream';

const sid = (s: string): SessionId => SessionId.parse(s);

/**
 * A realistic pi `--mode json` JSONL envelope (the event stream observed from pi 0.55.3): a
 * `session` line carrying the id, the user echo, an empty assistant `message_start`, the populated
 * `message_end`, the `turn_end`, and the closing `agent_end` with the full `messages[]`.
 */
const piSuccess = [
  JSON.stringify({ type: 'session', version: 3, id: 'sess-pi-1', timestamp: 't', cwd: '/tmp/x' }),
  JSON.stringify({ type: 'agent_start' }),
  JSON.stringify({ type: 'turn_start' }),
  JSON.stringify({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } }),
  JSON.stringify({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'do it' }] } }),
  JSON.stringify({
    type: 'message_start',
    message: { role: 'assistant', content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } },
  }),
  JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'all done' }],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17 },
      stopReason: 'end_turn',
    },
  }),
  JSON.stringify({
    type: 'turn_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'all done' }],
      usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17 },
      stopReason: 'end_turn',
    },
    toolResults: [],
  }),
  JSON.stringify({
    type: 'agent_end',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'all done' }],
        usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 0, totalTokens: 17 },
        stopReason: 'end_turn',
      },
    ],
  }),
].join('\n');

/**
 * A REAL pi `--mode json` success, captured live (pi 0.55.3 → ollama-cloud `deepseek-v4-flash:cloud`):
 * the assistant content interleaves a `thinking` block (keyed `thinking`, NOT `text`) with the `text`
 * block, `stopReason` is `'stop'`, and usage carries pi's bare camelCase keys. Pins the shapes the
 * codec must handle so a future change can't silently break parsing of real output.
 */
const piRealCloud = [
  JSON.stringify({ type: 'session', version: 3, id: 'c0ffee00-real-cloud-0001', timestamp: 't', cwd: '/x' }),
  JSON.stringify({ type: 'agent_start' }),
  JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'We need to reply with exactly one word.', thinkingSignature: 'reasoning' },
        { type: 'text', text: 'pong' },
      ],
      api: 'openai-completions',
      provider: 'ollama-cloud',
      model: 'deepseek-v4-flash:cloud',
      usage: { input: 374, output: 35, cacheRead: 0, cacheWrite: 0, totalTokens: 409, cost: { total: 0 } },
      stopReason: 'stop',
    },
  }),
  JSON.stringify({
    type: 'turn_end',
    message: { role: 'assistant', content: [{ type: 'text', text: 'pong' }], stopReason: 'stop' },
    toolResults: [],
  }),
].join('\n');

/** A model/provider error: pi exits 0 but the assistant carries no content + a `stopReason: 'error'`. */
const piModelError = [
  JSON.stringify({ type: 'session', version: 3, id: 'sess-pi-err' }),
  JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      stopReason: 'error',
      errorMessage: 'Request timed out.',
    },
  }),
  JSON.stringify({ type: 'turn_end', message: { role: 'assistant', content: [], stopReason: 'error' }, toolResults: [] }),
].join('\n');

describe('piExtractor (field mapping)', () => {
  it('pulls the assistant text, the session id, and the per-category usage from the JSONL stream', () => {
    const out = parseAgentOutput(piSuccess, piExtractor);
    expect(out).not.toBeNull();
    expect(out?.text).toBe('all done');
    expect(out?.sessionId).toBe('sess-pi-1');
    expect(out?.tokens).toBe(17);
    expect(out?.breakdown).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 0 });
  });

  it('parses a REAL ollama-cloud success: text only (thinking ignored), `stopReason: stop`, real usage', () => {
    const out = parseAgentOutput(piRealCloud, piExtractor);
    expect(out?.text).toBe('pong'); // the `thinking` block must NOT bleed into the result
    expect(out?.sessionId).toBe('c0ffee00-real-cloud-0001');
    expect(out?.tokens).toBe(409);
    expect(out?.breakdown).toEqual({ input: 374, output: 35, cacheRead: 0, cacheWrite: 0 });
    expect(out?.isError).toBeUndefined(); // `stopReason: 'stop'` is success
  });

  it('the session id comes ONLY from the `session` event (a message id never clobbers it)', () => {
    const withLaterId = [
      JSON.stringify({ type: 'session', id: 'sess-keep' }),
      JSON.stringify({ type: 'message_end', message: { role: 'assistant', id: 'msg-99', content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n');
    expect(parseAgentOutput(withLaterId, piExtractor)?.sessionId).toBe('sess-keep');
  });

  it('a model error (no content, stopReason error, exit 0) parses to NO text → null (fail-closed)', () => {
    expect(parseAgentOutput(piModelError, piExtractor)).toBeNull();
  });

  it('never throws on hostile / non-pi shapes', () => {
    expect(() => piExtractor({})).not.toThrow();
    expect(() => piExtractor({ type: 'message_end', message: 'nope' })).not.toThrow();
    expect(() => piExtractor({ type: 'agent_end', messages: 'nope' })).not.toThrow();
  });
});

describe('piCodec argv dialects', () => {
  it('harnessArgs: --print --mode json with edit-capable tools (NO bash), model, --continue on resume', () => {
    expect(piCodec.harnessArgs({ prompt: 'go', model: undefined, stream: false })).toEqual([
      '--print', '--mode', 'json', '--tools', 'read,edit,write,grep,find,ls', 'go',
    ]);
    const resumed = piCodec.harnessArgs({ prompt: 'more', model: 'anthropic/claude-opus-4-8', sessionId: sid('prev'), stream: false });
    expect(resumed).toEqual([
      '--print', '--mode', 'json', '--tools', 'read,edit,write,grep,find,ls',
      '--model', 'anthropic/claude-opus-4-8', '--continue', 'more',
    ]);
    // The write toolset must let the agent edit but NOT run shell (so it can't `git commit`).
    expect(resumed).not.toContain('bash');
  });

  it('harnessArgs ignores the `stream` flag (`--mode json` is already a JSONL stream)', () => {
    expect(piCodec.harnessArgs({ prompt: 'go', model: undefined, stream: true })).toEqual(
      piCodec.harnessArgs({ prompt: 'go', model: undefined, stream: false }),
    );
  });

  it('readonlyArgs: read-only tools only (no edit/write/bash), model before the prompt positional', () => {
    const args = piCodec.readonlyArgs({ prompt: 'judge this', model: 'ollama/qwen3:8b', stream: false });
    expect(args).toEqual(['--print', '--mode', 'json', '--tools', 'read,grep,find,ls', '--model', 'ollama/qwen3:8b', 'judge this']);
    expect(args).not.toContain('edit');
    expect(args).not.toContain('write');
    expect(args).not.toContain('--continue'); // the read-only LLM role is stateless
  });
});

describe('piCodec.classify (the shared flat policy)', () => {
  const base = { stderr: '', sessionId: undefined };

  it('exit 0 with a parsed result → completed (+ tokens, + session)', () => {
    const r = piCodec.classify({ ...base, stdout: piSuccess, code: 0 });
    expect(r.status).toBe('completed');
    expect(r.output).toBe('all done');
    expect(r.sessionId).toBe('sess-pi-1');
    expect(r.tokensUsed).toBe(17);
  });

  it('a model error on a CLEAN (exit 0) run → truncated, not a green', () => {
    expect(piCodec.classify({ ...base, stdout: piModelError, code: 0 }).status).toBe('truncated');
  });

  it('a non-zero exit → crashed', () => {
    expect(piCodec.classify({ ...base, stdout: piSuccess, code: 1, stderr: 'boom' }).status).toBe('crashed');
  });

  it('a timeout salvages parsed text → timeout', () => {
    const r = piCodec.classify({ ...base, stdout: piSuccess, code: null, timedOut: true });
    expect(r.status).toBe('timeout');
    expect(r.output).toBe('all done');
  });

  it('an unparseable clean exit → truncated (fail-closed), with the unknown-session sentinel', () => {
    const r = piCodec.classify({ ...base, stdout: 'not json at all', code: 0 });
    expect(r.status).toBe('truncated');
    expect(r.sessionId).toBe('pi-unknown');
  });
});

describe('piStreamExtractor (canonical event mapping)', () => {
  it('maps session → message → usage → done over the JSONL stream', () => {
    const events: AgentStreamEvent[] = [];
    const tap = new StreamTap(piStreamExtractor, (e) => events.push(e));
    tap.push(piSuccess);
    tap.end();
    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'usage', 'done']);
    const message = events.find((e) => e.kind === 'message');
    expect(message).toMatchObject({ text: 'all done' });
    const usage = events.find((e) => e.kind === 'usage');
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 5, cachedTokens: 2, totalTokens: 17 });
  });

  it('maps reasoning, tool_use, and turn_end tool_result blocks', () => {
    const stream = [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'hmm' },
            { type: 'tool_use', id: 't1', name: 'bash', input: { cmd: 'ls' } },
            { type: 'text', text: 'ran it' },
          ],
          usage: { input: 1, output: 1, totalTokens: 2 },
        },
      }),
      JSON.stringify({
        type: 'turn_end',
        message: { role: 'assistant', stopReason: 'end_turn' },
        toolResults: [{ id: 't1', output: 'file.txt', isError: false }],
      }),
    ].join('\n');
    const events: AgentStreamEvent[] = [];
    const tap = new StreamTap(piStreamExtractor, (e) => events.push(e));
    tap.push(stream);
    tap.end();
    expect(events.map((e) => e.kind)).toEqual([
      'session', 'reasoning', 'tool_use', 'message', 'usage', 'tool_result', 'done',
    ]);
    expect(events.find((e) => e.kind === 'tool_use')).toMatchObject({ id: 't1', name: 'bash', input: { cmd: 'ls' } });
    expect(events.find((e) => e.kind === 'tool_result')).toMatchObject({ id: 't1', output: 'file.txt' });
    expect(events.find((e) => e.kind === 'done')).toMatchObject({ status: 'end_turn' });
  });

  it('maps a REAL cloud `thinking` block (keyed `thinking`) to a reasoning event', () => {
    const events: AgentStreamEvent[] = [];
    const tap = new StreamTap(piStreamExtractor, (e) => events.push(e));
    tap.push(piRealCloud);
    tap.end();
    expect(events.map((e) => e.kind)).toEqual(['session', 'reasoning', 'message', 'usage', 'done']);
    expect(events.find((e) => e.kind === 'reasoning')).toMatchObject({ text: 'We need to reply with exactly one word.' });
    expect(events.find((e) => e.kind === 'message')).toMatchObject({ text: 'pong' });
  });

  it('returns [] for unrecognized lines and never throws', () => {
    expect(piStreamExtractor({ type: 'agent_start' })).toEqual([]);
    expect(() => piStreamExtractor({ type: 'turn_end', message: 'bad', toolResults: 'bad' })).not.toThrow();
  });
});
