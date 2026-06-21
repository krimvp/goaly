import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  accountTokens,
  StreamTokenEstimator,
  CHARS_PER_TOKEN,
} from './estimate';
import type { AgentStreamEvent } from './stream';

describe('estimateTokens', () => {
  it('is zero for an empty string and ceil(chars / 4) otherwise', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // 5 / 4 → ceil = 2
    expect(estimateTokens('x'.repeat(4 * CHARS_PER_TOKEN))).toBe(CHARS_PER_TOKEN);
  });
});

describe('StreamTokenEstimator', () => {
  it('accumulates message / reasoning / tool_use / tool_result content, ignoring usage/session/done', () => {
    const est = new StreamTokenEstimator();
    expect(est.observed()).toBe(false);
    expect(est.estimate()).toBe(0);

    const events: AgentStreamEvent[] = [
      { kind: 'session', sessionId: 's-1' }, // ignored
      { kind: 'message', text: 'a'.repeat(8) }, // 8 chars
      { kind: 'reasoning', text: 'b'.repeat(4) }, // 4 chars
      { kind: 'tool_use', name: 'bash', input: 'cd' }, // 'bash' (4) + 'cd' (2) = 6
      { kind: 'tool_result', output: 'c'.repeat(2) }, // 2 chars
      { kind: 'usage', totalTokens: 999 }, // ignored — reported usage is handled separately
      { kind: 'done', status: 'completed' }, // ignored
    ];
    for (const e of events) est.observe(e);

    expect(est.observed()).toBe(true);
    // 8 + 4 + 6 + 2 = 20 chars → ceil(20 / 4) = 5.
    expect(est.estimate()).toBe(5);
  });

  it('stringifies an object tool_use input for estimation', () => {
    const est = new StreamTokenEstimator();
    est.observe({ kind: 'tool_use', name: 'edit', input: { path: 'a.ts' } });
    // 'edit' (4) + JSON.stringify({path:'a.ts'}) length, both counted.
    expect(est.estimate()).toBeGreaterThan(0);
  });

  it('does NOT double-count incremental message deltas alongside the consolidated full message', () => {
    // codex streams `assistant.delta` partials AND a final full `item.completed` message for the
    // same turn — counting both would ~double the estimate. Only the full (non-delta) message counts.
    const est = new StreamTokenEstimator();
    est.observe({ kind: 'message', text: 'Hel', delta: true });
    est.observe({ kind: 'message', text: 'lo!', delta: true });
    est.observe({ kind: 'message', text: 'Hello!' }); // the consolidated full message (6 chars)
    expect(est.estimate()).toBe(Math.ceil('Hello!'.length / 4)); // 2, not 4
  });

  it('stays "not observed" for content-free streams (session/usage/done only)', () => {
    const est = new StreamTokenEstimator();
    est.observe({ kind: 'session', sessionId: 's' });
    est.observe({ kind: 'usage', totalTokens: 42 });
    est.observe({ kind: 'done', status: 'completed' });
    expect(est.observed()).toBe(false);
    expect(est.estimate()).toBe(0);
  });
});

describe('accountTokens', () => {
  it('prefers a reported count over the estimate (never overrides a real number)', () => {
    const est = new StreamTokenEstimator();
    est.observe({ kind: 'message', text: 'x'.repeat(40) });
    expect(accountTokens(123, est)).toEqual({ tokensUsed: 123, tokenSource: 'reported' });
  });

  it('falls back to the estimate when no count was reported', () => {
    const est = new StreamTokenEstimator();
    est.observe({ kind: 'message', text: 'x'.repeat(40) }); // 40 / 4 = 10
    expect(accountTokens(undefined, est)).toEqual({ tokensUsed: 10, tokenSource: 'estimated' });
  });

  it('returns no count when neither a report nor an estimate is available', () => {
    expect(accountTokens(undefined)).toEqual({});
    expect(accountTokens(undefined, new StreamTokenEstimator())).toEqual({});
  });
});
