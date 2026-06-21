import { describe, it, expect } from 'vitest';
import {
  AgentStreamEvent,
  StreamTap,
  flatStreamExtractor,
  sdkStreamExtractor,
  usageEventFromBlock,
  type AgentStreamEvent as Event,
  type StreamEventExtractor,
} from './stream';

/** Collect every event a tap forwards, for ordered assertions. */
function collect(extract: StreamEventExtractor): { tap: StreamTap; events: Event[] } {
  const events: Event[] = [];
  const tap = new StreamTap(extract, (e) => events.push(e));
  return { tap, events };
}

/** A trivial extractor that echoes a `message` for any object carrying `text`. */
const echo: StreamEventExtractor = (obj) =>
  typeof obj['text'] === 'string' ? [{ kind: 'message', text: obj['text'] }] : [];

describe('AgentStreamEvent schema', () => {
  it('accepts each canonical variant', () => {
    const variants: Event[] = [
      { kind: 'session', sessionId: 's' },
      { kind: 'message', text: 'hi', delta: true },
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } },
      { kind: 'tool_result', id: 't1', output: 'ok', exitCode: 0, isError: false },
      { kind: 'usage', inputTokens: 1, outputTokens: 2, cachedTokens: 3, totalTokens: 3 },
      { kind: 'done', status: 'completed' },
    ];
    for (const v of variants) expect(AgentStreamEvent.safeParse(v).success).toBe(true);
  });

  it('rejects an unknown kind and a malformed variant', () => {
    expect(AgentStreamEvent.safeParse({ kind: 'mystery' }).success).toBe(false);
    expect(AgentStreamEvent.safeParse({ kind: 'message' }).success).toBe(false); // text missing
  });
});

describe('StreamTap', () => {
  it('emits one event per newline-terminated JSON line', () => {
    const { tap, events } = collect(echo);
    tap.push(`${JSON.stringify({ text: 'a' })}\n${JSON.stringify({ text: 'b' })}\n`);
    expect(events).toEqual([
      { kind: 'message', text: 'a' },
      { kind: 'message', text: 'b' },
    ]);
  });

  it('buffers a JSON line split across chunks until the newline arrives', () => {
    const { tap, events } = collect(echo);
    const line = JSON.stringify({ text: 'split' });
    tap.push(line.slice(0, 5)); // mid-object — no event yet
    expect(events).toEqual([]);
    tap.push(`${line.slice(5)}\n`);
    expect(events).toEqual([{ kind: 'message', text: 'split' }]);
  });

  it('flushes a final unterminated line on end()', () => {
    const { tap, events } = collect(echo);
    tap.push(JSON.stringify({ text: 'last' })); // no trailing newline
    expect(events).toEqual([]);
    tap.end();
    expect(events).toEqual([{ kind: 'message', text: 'last' }]);
  });

  it('tolerates non-JSON and blank lines, dropping them silently', () => {
    const { tap, events } = collect(echo);
    tap.push('not json\n\n{ broken\n');
    tap.push(`${JSON.stringify({ text: 'ok' })}\n`);
    expect(events).toEqual([{ kind: 'message', text: 'ok' }]);
  });

  it('tolerates \\r\\n line endings', () => {
    const { tap, events } = collect(echo);
    tap.push(`${JSON.stringify({ text: 'crlf' })}\r\n`);
    expect(events).toEqual([{ kind: 'message', text: 'crlf' }]);
  });

  it('drops events that fail canonical validation (fail-closed at the seam)', () => {
    const bad: StreamEventExtractor = () => [{ kind: 'message' } as unknown as Event];
    const { tap, events } = collect(bad);
    tap.push('{}\n');
    expect(events).toEqual([]);
  });

  it('swallows a throwing extractor without crashing', () => {
    const boom: StreamEventExtractor = () => {
      throw new Error('extractor blew up');
    };
    const { tap, events } = collect(boom);
    expect(() => tap.push('{}\n')).not.toThrow();
    expect(events).toEqual([]);
  });

  it('swallows a throwing sink without crashing', () => {
    const tap = new StreamTap(echo, () => {
      throw new Error('sink blew up');
    });
    expect(() => tap.push(`${JSON.stringify({ text: 'a' })}\n`)).not.toThrow();
  });
});

describe('usageEventFromBlock', () => {
  it('sums input+output when no explicit total is present', () => {
    expect(usageEventFromBlock({ input_tokens: 4, output_tokens: 6 })).toEqual({
      kind: 'usage',
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
  });

  it('prefers an explicit total and reads cached tokens', () => {
    expect(
      usageEventFromBlock({ input_tokens: 1, output_tokens: 1, total_tokens: 9, cached_input_tokens: 7 }),
    ).toEqual({ kind: 'usage', inputTokens: 1, outputTokens: 1, cachedTokens: 7, totalTokens: 9 });
  });

  it('returns null for an empty/contentless usage block', () => {
    expect(usageEventFromBlock({})).toBeNull();
  });
});

describe('flatStreamExtractor (droid-style final envelope)', () => {
  it('maps a final result object to session → message → usage → done', () => {
    const extract = flatStreamExtractor({ errorKey: 'is_error' });
    const obj = {
      type: 'result',
      result: 'all done',
      session_id: 'd-1',
      usage: { input_tokens: 2, output_tokens: 3 },
    };
    expect(extract(obj)).toEqual([
      { kind: 'session', sessionId: 'd-1' },
      { kind: 'message', text: 'all done' },
      { kind: 'usage', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      { kind: 'done', status: 'completed' },
    ]);
  });

  it('marks the done status `error` when the soft-error flag is set', () => {
    const extract = flatStreamExtractor({ errorKey: 'is_error' });
    const events = extract({ result: 'oops', is_error: true });
    expect(events.at(-1)).toEqual({ kind: 'done', status: 'error' });
  });

  it('emits nothing for a noise object with no result/usage', () => {
    expect(flatStreamExtractor()({ type: 'log', message: 'starting' })).toEqual([]);
  });
});

describe('sdkStreamExtractor (Anthropic agent-SDK envelope)', () => {
  const extract = sdkStreamExtractor();

  it('emits an assistant message AND its per-message usage block', () => {
    expect(
      extract({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 9, output_tokens: 1 } },
      }),
    ).toEqual([
      { kind: 'message', text: 'hi' },
      { kind: 'usage', inputTokens: 9, outputTokens: 1, totalTokens: 10 },
    ]);
  });

  it('maps a thinking block to a reasoning event', () => {
    expect(extract({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hmm' }] } })).toEqual([
      { kind: 'reasoning', text: 'hmm' },
    ]);
  });

  it('returns [] for a malformed event (non-record message, unknown type)', () => {
    expect(extract({ type: 'assistant', message: 'oops' })).toEqual([]);
    expect(extract({ type: 'user', message: 42 })).toEqual([]);
    expect(extract({ type: 'mystery' })).toEqual([]);
  });
});
