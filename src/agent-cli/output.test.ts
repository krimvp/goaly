import { describe, it, expect } from 'vitest';
import { parseAgentOutput, flatExtractor, tryJsonObject, isRecord, type FieldExtractor } from './output';

const flat = flatExtractor();
const flatErr = flatExtractor({ errorKey: 'is_error' });

describe('parseAgentOutput (shared core)', () => {
  it('reads a whole-stdout JSON object and sums input/output tokens', () => {
    const s = JSON.stringify({
      result: 'hi',
      session_id: 's1',
      usage: { input_tokens: 4, output_tokens: 6 },
    });
    expect(parseAgentOutput(s, flat)).toEqual({
      text: 'hi',
      sessionId: 's1',
      tokens: 10,
      breakdown: { input: 4, output: 6 },
    });
  });

  it('COUNTS cache tokens in the total and the breakdown (regression: input+output dropped them)', () => {
    // A realistic Claude usage block: the bulk of the input is cached, which the old
    // input+output math ignored entirely (counting 15 of 21,061 real tokens).
    const s = JSON.stringify({
      result: 'done',
      session_id: 's1',
      usage: {
        input_tokens: 3,
        output_tokens: 12,
        cache_read_input_tokens: 17_773,
        cache_creation_input_tokens: 3_273,
      },
    });
    expect(parseAgentOutput(s, flat)).toEqual({
      text: 'done',
      sessionId: 's1',
      tokens: 21_061,
      breakdown: { input: 3, output: 12, cacheRead: 17_773, cacheWrite: 3_273 },
    });
  });

  it('prefers an explicit total over the input/output sum', () => {
    const s = JSON.stringify({
      result: 'x',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 9 },
    });
    expect(parseAgentOutput(s, flat)?.tokens).toBe(9);
  });

  it('treats an empty-string result as text-bearing (flat extractor)', () => {
    const s = JSON.stringify({ result: '', session_id: 's2' });
    expect(parseAgentOutput(s, flat)).toEqual({ text: '', sessionId: 's2' });
  });

  it('keeps the LAST text-bearing line but latches the FIRST session id', () => {
    const s = [
      JSON.stringify({ type: 'init', session_id: 'first' }),
      JSON.stringify({ result: 'a', session_id: 'first' }),
      JSON.stringify({ result: 'b', usage: { total_tokens: 3 } }),
    ].join('\n');
    expect(parseAgentOutput(s, flat)).toEqual({ text: 'b', sessionId: 'first', tokens: 3 });
  });

  it('accrues the latest token count seen on any line', () => {
    const s = [
      JSON.stringify({ result: 'done' }),
      JSON.stringify({ type: 'usage', usage: { total_tokens: 42 } }),
    ].join('\n');
    expect(parseAgentOutput(s, flat)?.tokens).toBe(42);
  });

  it('surfaces a boolean soft-error flag when the extractor reads one', () => {
    const s = JSON.stringify({ result: 'oops', is_error: true });
    expect(parseAgentOutput(s, flatErr)).toEqual({ text: 'oops', isError: true });
  });

  it('parses a single JSON object amid log/noise lines', () => {
    const s = ['[info] start', JSON.stringify({ result: 'mid', session_id: 's' }), 'done'].join('\n');
    expect(parseAgentOutput(s, flat)).toEqual({ text: 'mid', sessionId: 's' });
  });

  it('tolerates malformed lines, keeping the last valid text', () => {
    const s = ['{ broken', 'not json', JSON.stringify({ result: 'ok' })].join('\n');
    expect(parseAgentOutput(s, flat)?.text).toBe('ok');
  });

  it('returns null on no JSON, empty input, or JSON without text', () => {
    expect(parseAgentOutput('plain text', flat)).toBeNull();
    expect(parseAgentOutput('', flat)).toBeNull();
    expect(parseAgentOutput(JSON.stringify({ session_id: 'x' }), flat)).toBeNull();
  });

  it('lets a custom extractor decide what counts as text (Strategy)', () => {
    const upper: FieldExtractor = (o) =>
      typeof o['msg'] === 'string' ? { text: o['msg'].toUpperCase() } : {};
    expect(parseAgentOutput(JSON.stringify({ msg: 'hey' }), upper)?.text).toBe('HEY');
  });
});

describe('tryJsonObject / isRecord', () => {
  it('parses an object, rejects arrays / scalars / blanks', () => {
    expect(tryJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(tryJsonObject('[1,2]')).toBeNull();
    expect(tryJsonObject('42')).toBeNull();
    expect(tryJsonObject('   ')).toBeNull();
  });

  it('isRecord distinguishes plain objects from arrays/null', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
  });
});
