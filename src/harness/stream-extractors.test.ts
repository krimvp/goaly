import { describe, it, expect } from 'vitest';
import { StreamTap, type AgentStreamEvent, type StreamEventExtractor } from '../agent-cli/stream';
import { codexCodec } from '../agent-cli/codex-codec';
import { claudeCodec } from '../agent-cli/claude-codec';
import { droidCodec } from '../agent-cli/droid-codec';

const codexStreamExtractor = codexCodec.streamExtractor;
const claudeStreamExtractor = claudeCodec.streamExtractor;
const droidStreamExtractor = droidCodec.streamExtractor;

/** Feed canned JSONL through a tap and return the ordered events it forwards. */
function run(extract: StreamEventExtractor, lines: object[]): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const tap = new StreamTap(extract, (e) => events.push(e));
  tap.push(lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  tap.end();
  return events;
}

describe('codexStreamExtractor', () => {
  it('maps a full codex turn to ordered canonical events', () => {
    const events = run(codexStreamExtractor, [
      { type: 'thread.started', thread_id: 'th-9' },
      { type: 'assistant.delta', delta: { text: 'thinking ' } },
      {
        type: 'item.started',
        item: { id: 'b', type: 'command_execution', command: 'node --test' },
      },
      {
        type: 'item.completed',
        item: {
          id: 'b',
          type: 'command_execution',
          command: 'node --test',
          aggregated_output: 'ok',
          exit_code: 0,
        },
      },
      { type: 'item.completed', item: { id: 'c', type: 'agent_message', text: 'Updated sum.mjs.' } },
      { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 23, cached_input_tokens: 90 } },
    ]);
    expect(events).toEqual([
      { kind: 'session', sessionId: 'th-9' },
      { kind: 'message', text: 'thinking ', delta: true },
      { kind: 'tool_use', id: 'b', name: 'command', input: 'node --test' },
      { kind: 'tool_result', id: 'b', output: 'ok', exitCode: 0, isError: false },
      { kind: 'message', text: 'Updated sum.mjs.' },
      { kind: 'usage', inputTokens: 100, outputTokens: 23, cachedTokens: 90, totalTokens: 123 },
      { kind: 'done', status: 'turn.completed' },
    ]);
  });

  it('flags a non-zero command exit as a tool_result error', () => {
    const events = run(codexStreamExtractor, [
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'boom', exit_code: 2 } },
    ]);
    expect(events).toEqual([{ kind: 'tool_result', output: 'boom', exitCode: 2, isError: true }]);
  });

  it('maps a failed turn to a done event', () => {
    expect(run(codexStreamExtractor, [{ type: 'turn.failed' }])).toEqual([
      { kind: 'done', status: 'turn.failed' },
    ]);
  });

  it('emits nothing for unrelated lines', () => {
    expect(run(codexStreamExtractor, [{ type: 'item.started', item: { type: 'agent_message' } }])).toEqual([]);
  });
});

describe('claudeStreamExtractor (stream-json)', () => {
  it('maps a full claude turn to ordered canonical events', () => {
    const events = run(claudeStreamExtractor, [
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'let me look' },
            { type: 'text', text: 'On it.' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file.ts' }] },
      },
      { type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 5, output_tokens: 7 } },
    ]);
    expect(events).toEqual([
      { kind: 'session', sessionId: 'sess-1' },
      { kind: 'reasoning', text: 'let me look' },
      { kind: 'message', text: 'On it.' },
      { kind: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } },
      { kind: 'tool_result', id: 'tu1', output: 'file.ts' },
      { kind: 'usage', inputTokens: 5, outputTokens: 7, totalTokens: 12 },
      { kind: 'done', status: 'success' },
    ]);
  });

  it('flattens an array-shaped tool_result content and flags errors', () => {
    const events = run(claudeStreamExtractor, [
      {
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'x', content: [{ type: 'text', text: 'oops' }], is_error: true },
          ],
        },
      },
    ]);
    expect(events).toEqual([{ kind: 'tool_result', id: 'x', output: 'oops', isError: true }]);
  });
});

describe('droidStreamExtractor (Anthropic agent-SDK stream-json)', () => {
  it('maps droid stream-json turns the same way as claude (shared SDK mapping)', () => {
    const events = run(droidStreamExtractor, [
      { type: 'system', subtype: 'init', session_id: 'd-1' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'all set' }] } },
      { type: 'result', subtype: 'success', result: 'all set', usage: { input_tokens: 2, output_tokens: 3 } },
    ]);
    expect(events).toEqual([
      { kind: 'session', sessionId: 'd-1' },
      { kind: 'message', text: 'all set' },
      { kind: 'usage', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      { kind: 'done', status: 'success' },
    ]);
  });

  it('marks the done status `error` when droid sets is_error on the result line', () => {
    const events = run(droidStreamExtractor, [
      { type: 'result', result: 'oops', is_error: true, usage: { input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(events.at(-1)).toEqual({ kind: 'done', status: 'error' });
  });

  it('degrades a lone final result envelope to usage + done (final text recovered separately)', () => {
    const events = run(droidStreamExtractor, [
      { type: 'result', result: 'all set', session_id: 'd-1', usage: { input_tokens: 2, output_tokens: 3 } },
    ]);
    expect(events).toEqual([
      { kind: 'usage', inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      { kind: 'done', status: 'completed' },
    ]);
  });
});
