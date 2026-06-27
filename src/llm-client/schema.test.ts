import { describe, it, expect } from 'vitest';
import { ChatResponse, ChatMessage, ChatUsage, usageToBreakdown } from './schema';

describe('ChatResponse parsing (the wire seam, invariant #6)', () => {
  it('accepts a plain text completion with usage', () => {
    const parsed = ChatResponse.safeParse({
      choices: [{ message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts a tool-calling turn with null content and loose tool_calls (no id/type)', () => {
    const parsed = ChatResponse.safeParse({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an empty choices array (unusable → fail closed)', () => {
    expect(ChatResponse.safeParse({ choices: [] }).success).toBe(false);
  });

  it('rejects a missing choices field', () => {
    expect(ChatResponse.safeParse({ usage: {} }).success).toBe(false);
  });

  it('passes through unknown top-level fields', () => {
    const parsed = ChatResponse.safeParse({
      id: 'x',
      object: 'chat.completion',
      choices: [{ message: { content: 'ok' } }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('ChatMessage (persisted + re-parsed on resume)', () => {
  it('round-trips all four roles', () => {
    const msgs = [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'n', arguments: '{}' } }] },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
    ];
    for (const m of msgs) expect(ChatMessage.safeParse(m).success).toBe(true);
  });

  it('rejects an unknown role', () => {
    expect(ChatMessage.safeParse({ role: 'developer', content: 'x' }).success).toBe(false);
  });
});

describe('usageToBreakdown', () => {
  it('splits cached prompt tokens out of input (OpenAI prompt_tokens is inclusive)', () => {
    const b = usageToBreakdown({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 30 },
    });
    expect(b).toEqual({ input: 70, output: 20, cacheRead: 30 });
  });

  it('omits categories that were not reported (never a silent zero)', () => {
    expect(usageToBreakdown({ completion_tokens: 5 })).toEqual({ output: 5 });
    expect(usageToBreakdown(undefined)).toEqual({});
  });

  it('never produces a negative input when cached exceeds prompt', () => {
    const b = usageToBreakdown({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } });
    expect(b.input).toBe(0);
    expect(b.cacheRead).toBe(40);
  });
});

describe('non-finite usage (review finding [1] — must never reach the .int() run-result schema)', () => {
  it('drops a non-finite token count to undefined (fail-open to unknown)', () => {
    const u = ChatUsage.parse({ total_tokens: Infinity, completion_tokens: 5 });
    expect(u.total_tokens).toBeUndefined();
    expect(u.completion_tokens).toBe(5);
  });

  it('parses a response whose usage carries a non-finite count without failing the whole response', () => {
    const parsed = ChatResponse.safeParse({
      choices: [{ message: { content: 'x' } }],
      usage: { total_tokens: Infinity, completion_tokens: 5 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.usage?.total_tokens).toBeUndefined();
  });
});
