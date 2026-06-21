import { describe, it, expect } from 'vitest';
import { CodexAdapter } from './codex';
import { ClaudeCodeAdapter } from './claude-code';
import { DroidAdapter } from './droid';
import type { AgentStreamEvent } from '../agent-cli/stream';

/**
 * An exec that replays canned stdout through the live `onStdout` tap in tiny chunks (to exercise
 * partial-line buffering across chunk boundaries), then resolves with the full buffered stdout —
 * exactly how a real subprocess behaves.
 */
function streamingExec(stdout: string, code = 0, chunk = 5) {
  return async (
    _args: string[],
    _input: { prompt: string },
    onStdout?: (c: string) => void,
  ): Promise<{ stdout: string; stderr: string; code: number }> => {
    if (onStdout !== undefined) {
      for (let i = 0; i < stdout.length; i += chunk) onStdout(stdout.slice(i, i + chunk));
    }
    return { stdout, stderr: '', code };
  };
}

const codexJsonl = [
  JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }),
  JSON.stringify({
    type: 'item.started',
    item: { id: 'b', type: 'command_execution', command: 'npm test' },
  }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: 'b', type: 'command_execution', aggregated_output: 'pass', exit_code: 0 },
  }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }),
].join('\n');

const claudeStreamJson = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', result: 'final answer', usage: { input_tokens: 3, output_tokens: 4 } }),
].join('\n');

const claudeJson = JSON.stringify({ result: 'final answer', session_id: 'sess-1', usage: { total_tokens: 7 } });

const droidStreamJson = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'd-1' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'shipped' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', result: 'shipped', usage: { input_tokens: 1, output_tokens: 2 } }),
].join('\n');

describe('CodexAdapter streaming', () => {
  it('forwards ordered intermediate events while preserving the final result', async () => {
    const events: AgentStreamEvent[] = [];
    const adapter = new CodexAdapter({ exec: streamingExec(codexJsonl) });

    const result = await adapter.run('go', undefined, (e) => events.push(e));

    expect(events.map((e) => e.kind)).toEqual([
      'session',
      'tool_use',
      'tool_result',
      'message',
      'usage',
      'done',
    ]);
    // Final-result assembly is unchanged by streaming.
    expect(result.status).toBe('completed');
    expect(result.output).toBe('Done.');
    expect(result.sessionId).toBe('th-1');
    expect(result.tokensUsed).toBe(15);
  });

  it('produces an identical result whether or not streaming is on', async () => {
    const withStream = await new CodexAdapter({ exec: streamingExec(codexJsonl) }).run(
      'go',
      undefined,
      () => {},
    );
    const without = await new CodexAdapter({ exec: streamingExec(codexJsonl) }).run('go');
    expect(withStream).toEqual(without);
  });

  it('a throwing sink never crashes the run and never changes the result', async () => {
    const baseline = await new CodexAdapter({ exec: streamingExec(codexJsonl) }).run('go');
    const result = await new CodexAdapter({ exec: streamingExec(codexJsonl) }).run('go', undefined, () => {
      throw new Error('sink exploded');
    });
    expect(result).toEqual(baseline);
  });
});

describe('ClaudeCodeAdapter streaming', () => {
  it('switches to stream-json + --verbose only when an onEvent sink is supplied', async () => {
    const seenArgs: string[][] = [];
    const exec = async (
      args: string[],
      _input: { prompt: string },
      onStdout?: (c: string) => void,
    ) => {
      seenArgs.push(args);
      const out = onStdout !== undefined ? claudeStreamJson : claudeJson;
      if (onStdout !== undefined) onStdout(out);
      return { stdout: out, stderr: '', code: 0 };
    };

    const events: AgentStreamEvent[] = [];
    const streamed = await new ClaudeCodeAdapter({ exec }).run('go', undefined, (e) => events.push(e));
    const plain = await new ClaudeCodeAdapter({ exec }).run('go');

    expect(seenArgs[0]).toContain('stream-json');
    expect(seenArgs[0]).toContain('--verbose');
    expect(seenArgs[1]).toContain('json');
    expect(seenArgs[1]).not.toContain('stream-json');

    // Same final text recovered from the stream-json `result` event as from the flat envelope.
    expect(streamed.output).toBe('final answer');
    expect(plain.output).toBe('final answer');
    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'usage', 'done']);
  });
});

describe('token estimation fallback (issue #24)', () => {
  // A claude stream-json run whose closing `result` carries NO `usage` block.
  const claudeStreamNoUsage = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Working on it now.' }] }, // 18 chars
    }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
  ].join('\n');

  it('claude: estimates from streamed turns when the run self-reports no usage', async () => {
    const result = await new ClaudeCodeAdapter({ exec: streamingExec(claudeStreamNoUsage) }).run(
      'go',
      undefined,
      () => {},
    );
    expect(result.status).toBe('completed');
    expect(result.tokenSource).toBe('estimated');
    // 18 chars of assistant text → ceil(18 / 4) = 5.
    expect(result.tokensUsed).toBe(5);
  });

  it('claude: marks a self-reported count as reported, never estimated', async () => {
    const result = await new ClaudeCodeAdapter({ exec: streamingExec(claudeStreamJson) }).run(
      'go',
      undefined,
      () => {},
    );
    expect(result.tokenSource).toBe('reported');
    expect(result.tokensUsed).toBe(7); // 3 + 4 from the reported usage block
  });

  it('codex: estimates from streamed turns when turn.completed carries no usage (no delta double-count)', async () => {
    const noUsage = [
      JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }),
      // Incremental deltas for the same turn — must NOT be counted on top of the full message.
      JSON.stringify({ type: 'assistant.delta', delta: 'All set ' }),
      JSON.stringify({ type: 'assistant.delta', delta: 'here.' }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'All set here.' }, // 13 chars — the only counted text
      }),
      JSON.stringify({ type: 'turn.completed' }), // no usage block
    ].join('\n');
    const result = await new CodexAdapter({ exec: streamingExec(noUsage) }).run('go', undefined, () => {});
    expect(result.status).toBe('completed');
    expect(result.tokenSource).toBe('estimated');
    // 13 chars → ceil(13 / 4) = 4, NOT inflated by the streamed deltas.
    expect(result.tokensUsed).toBe(Math.ceil('All set here.'.length / 4));
  });

  it('does NOT estimate when not streaming (the lean envelope still reports usage)', async () => {
    const result = await new ClaudeCodeAdapter({ exec: streamingExec(claudeJson) }).run('go');
    expect(result.tokenSource).toBe('reported');
    expect(result.tokensUsed).toBe(7);
  });
});

describe('DroidAdapter streaming', () => {
  it('requests stream-json and forwards the SDK turns when an onEvent sink is supplied', async () => {
    const seenArgs: string[][] = [];
    const exec = async (
      args: string[],
      _input: { prompt: string },
      onStdout?: (c: string) => void,
    ) => {
      seenArgs.push(args);
      if (onStdout !== undefined) onStdout(droidStreamJson);
      return { stdout: droidStreamJson, stderr: '', code: 0 };
    };
    const events: AgentStreamEvent[] = [];
    const result = await new DroidAdapter({ exec }).run('go', undefined, (e) => events.push(e));

    expect(seenArgs[0]).toContain('stream-json');
    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'usage', 'done']);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('shipped');
  });

  it('uses the lean json envelope when not streaming', async () => {
    const seenArgs: string[][] = [];
    const exec = async (args: string[]) => {
      seenArgs.push(args);
      return {
        stdout: JSON.stringify({ type: 'result', result: 'shipped', session_id: 'd-1' }),
        stderr: '',
        code: 0,
      };
    };
    await new DroidAdapter({ exec }).run('go');
    expect(seenArgs[0]).toContain('json');
    expect(seenArgs[0]).not.toContain('stream-json');
  });
});
