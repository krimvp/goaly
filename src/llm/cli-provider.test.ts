import { describe, it, expect } from 'vitest';
import { CliLlmProvider, buildLlmArgs } from './cli-provider';
import type { ProcessResult } from '../util/spawn';

const ok = (stdout: string): ProcessResult => ({ stdout, stderr: '', code: 0, timedOut: false });

describe('buildLlmArgs', () => {
  it('defaults to -p --output-format json with no model', () => {
    expect(buildLlmArgs(undefined, undefined)).toEqual(['-p', '--output-format', 'json']);
  });

  it('appends --model to the default args when a model is set', () => {
    expect(buildLlmArgs(undefined, 'opus')).toEqual([
      '-p',
      '--output-format',
      'json',
      '--model',
      'opus',
    ]);
  });

  it('returns caller-supplied args untouched, ignoring the model', () => {
    expect(buildLlmArgs(['--print'], 'opus')).toEqual(['--print']);
  });
});

describe('CliLlmProvider', () => {
  it('combines system + prompt on stdin and returns trimmed plain-text stdout', async () => {
    let captured = '';
    const llm = new CliLlmProvider({
      exec: async (input) => {
        captured = input;
        return ok('  answer  ');
      },
    });
    const out = await llm.complete({ system: 'sys', prompt: 'p', temperature: 0 });
    expect(out.text).toBe('answer');
    expect(out.tokensUsed).toBeUndefined();
    expect(captured).toBe('sys\n\np');
  });

  it('parses a --output-format json envelope for result text and token usage', async () => {
    const json = JSON.stringify({ result: 'the answer', usage: { input_tokens: 7, output_tokens: 5 } });
    const llm = new CliLlmProvider({ exec: async () => ok(json) });
    const out = await llm.complete({ prompt: 'p' });
    expect(out.text).toBe('the answer');
    expect(out.tokensUsed).toBe(12);
    expect(out.tokenSource).toBe('reported');
  });

  it('estimates token usage from the streamed turns when the step self-reports none (issue #24)', async () => {
    // A claude stream-json reply whose closing `result` carries NO usage block.
    const streamJson = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Reasoning through it.' }] }, // 21 chars
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'verdict' }),
    ].join('\n');
    const llm = new CliLlmProvider({
      onEvent: () => {}, // streaming on → stream-json path
      exec: async (_input, onStdout) => {
        onStdout?.(streamJson);
        return ok(streamJson);
      },
    });
    const out = await llm.complete({ prompt: 'p' });
    expect(out.text).toBe('verdict');
    expect(out.tokenSource).toBe('estimated');
    expect(out.tokensUsed).toBe(Math.ceil('Reasoning through it.'.length / 4));
  });

  it('sends just the prompt when there is no system message', async () => {
    let captured = '';
    const llm = new CliLlmProvider({
      exec: async (input) => {
        captured = input;
        return ok('x');
      },
    });
    await llm.complete({ prompt: 'only' });
    expect(captured).toBe('only');
  });

  it('throws on a non-zero exit', async () => {
    const llm = new CliLlmProvider({
      exec: async () => ({ stdout: '', stderr: 'boom', code: 1, timedOut: false }),
    });
    await expect(llm.complete({ prompt: 'p' })).rejects.toThrow(/exited 1/);
  });

  it('throws on a timeout', async () => {
    const llm = new CliLlmProvider({
      exec: async () => ({ stdout: '', stderr: '', code: 0, timedOut: true }),
    });
    await expect(llm.complete({ prompt: 'p' })).rejects.toThrow(/timed out/);
  });
});
