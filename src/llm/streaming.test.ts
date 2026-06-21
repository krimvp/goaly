import { describe, it, expect } from 'vitest';
import { AgentCliLlmProvider } from './agent-cli-provider';
import { CliLlmProvider, buildLlmArgs } from './cli-provider';
import { codexExtractor, codexStreamExtractor } from '../harness/codex';
import type { ProcessResult } from '../util/spawn';
import type { AgentStreamEvent } from '../agent-cli/stream';

const codexJsonl = [
  JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'verdict: PASS' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 2 } }),
].join('\n');

const claudeStreamJson = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success', result: 'verdict: PASS', usage: { input_tokens: 1, output_tokens: 1 } }),
].join('\n');

describe('AgentCliLlmProvider streaming', () => {
  it('forwards ordered events from a read-only completion and returns the final text', async () => {
    const events: AgentStreamEvent[] = [];
    const provider = new AgentCliLlmProvider({
      name: 'codex',
      command: 'codex',
      buildArgs: (prompt) => ['exec', '--sandbox', 'read-only', prompt, '--json'],
      extractor: codexExtractor,
      streamExtractor: codexStreamExtractor,
      onEvent: (e) => events.push(e),
      exec: async (_args, onStdout) => {
        if (onStdout !== undefined) for (const c of codexJsonl) onStdout(c); // char-by-char chunks
        return { stdout: codexJsonl, stderr: '', code: 0, timedOut: false };
      },
    });

    const text = await provider.complete({ prompt: 'judge this' });

    expect(text.text).toBe('verdict: PASS');
    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'usage', 'done']);
  });

  it('a throwing sink does not crash the step and does not change the returned text', async () => {
    const make = (onEvent?: (e: AgentStreamEvent) => void): AgentCliLlmProvider =>
      new AgentCliLlmProvider({
        name: 'codex',
        command: 'codex',
        buildArgs: (prompt) => ['exec', '--sandbox', 'read-only', prompt, '--json'],
        extractor: codexExtractor,
        streamExtractor: codexStreamExtractor,
        ...(onEvent !== undefined ? { onEvent } : {}),
        exec: async (_args, onStdout) => {
          if (onStdout !== undefined) onStdout(codexJsonl);
          return { stdout: codexJsonl, stderr: '', code: 0, timedOut: false };
        },
      });

    const baseline = await make().complete({ prompt: 'x' });
    const streamed = await make(() => {
      throw new Error('sink exploded');
    }).complete({ prompt: 'x' });
    expect(streamed).toEqual(baseline);
  });
});

describe('CliLlmProvider (claude) streaming', () => {
  it('builds stream-json args only when streaming', () => {
    expect(buildLlmArgs(undefined, undefined, true)).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(buildLlmArgs(undefined, undefined, false)).toEqual(['-p', '--output-format', 'json']);
  });

  it('switches to stream-json parsing + emits events when a sink is wired', async () => {
    const events: AgentStreamEvent[] = [];
    const exec = async (_input: string, onStdout?: (c: string) => void): Promise<ProcessResult> => {
      if (onStdout !== undefined) onStdout(claudeStreamJson);
      return { stdout: claudeStreamJson, stderr: '', code: 0, timedOut: false };
    };
    const provider = new CliLlmProvider({ exec, onEvent: (e) => events.push(e) });

    const text = await provider.complete({ prompt: 'judge this' });

    expect(text.text).toBe('verdict: PASS'); // recovered from the closing `result` event via flatExtractor
    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'usage', 'done']);
  });

  it('keeps the plain-text path unchanged when no sink is wired', async () => {
    const exec = async (): Promise<ProcessResult> => ({
      stdout: '  verdict: PASS  ',
      stderr: '',
      code: 0,
      timedOut: false,
    });
    const provider = new CliLlmProvider({ exec });
    expect((await provider.complete({ prompt: 'x' })).text).toBe('verdict: PASS');
  });
});
