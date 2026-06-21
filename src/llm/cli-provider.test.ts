import { describe, it, expect } from 'vitest';
import { CliLlmProvider, buildLlmArgs } from './cli-provider';
import type { ProcessResult } from '../util/spawn';

const ok = (stdout: string): ProcessResult => ({ stdout, stderr: '', code: 0, timedOut: false });

describe('buildLlmArgs', () => {
  it('defaults to -p with no model', () => {
    expect(buildLlmArgs(undefined, undefined)).toEqual(['-p']);
  });

  it('appends --model to the default args when a model is set', () => {
    expect(buildLlmArgs(undefined, 'opus')).toEqual(['-p', '--model', 'opus']);
  });

  it('returns caller-supplied args untouched, ignoring the model', () => {
    expect(buildLlmArgs(['--print'], 'opus')).toEqual(['--print']);
  });
});

describe('CliLlmProvider', () => {
  it('combines system + prompt on stdin and returns trimmed stdout', async () => {
    let captured = '';
    const llm = new CliLlmProvider({
      exec: async (input) => {
        captured = input;
        return ok('  answer  ');
      },
    });
    const out = await llm.complete({ system: 'sys', prompt: 'p', temperature: 0 });
    expect(out).toBe('answer');
    expect(captured).toBe('sys\n\np');
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
