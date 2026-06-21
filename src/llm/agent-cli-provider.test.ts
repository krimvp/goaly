import { describe, it, expect } from 'vitest';
import { AgentCliLlmProvider } from './agent-cli-provider';
import { codexExtractor } from '../harness/codex';
import { droidExtractor } from '../harness/droid';

type ExecResult = { stdout: string; stderr: string; code: number; timedOut?: boolean };

function fakeExec(result: ExecResult, sink?: string[][]) {
  return async (args: string[]): Promise<ExecResult> => {
    sink?.push(args);
    return result;
  };
}

const codexJsonl = JSON.stringify({ type: 'result', text: 'the verdict', usage: { total_tokens: 3 } });

describe('AgentCliLlmProvider', () => {
  it('combines system + prompt, runs the built argv, and returns the parsed text', async () => {
    const sink: string[][] = [];
    const llm = new AgentCliLlmProvider({
      name: 'codex',
      command: 'codex',
      extractor: codexExtractor,
      buildArgs: (p) => ['exec', '--sandbox', 'read-only', '--model', 'gpt-x', p, '--json'],
      exec: fakeExec({ stdout: codexJsonl, stderr: '', code: 0 }, sink),
    });

    const out = await llm.complete({ system: 'sys', prompt: 'judge this' });

    expect(out).toBe('the verdict');
    expect(sink[0]).toEqual([
      'exec', '--sandbox', 'read-only', '--model', 'gpt-x', 'sys\n\njudge this', '--json',
    ]);
  });

  it('parses droid output and never passes --auto (read-only)', async () => {
    const sink: string[][] = [];
    const droidJson = JSON.stringify({ result: 'looks good', session_id: 's' });
    const llm = new AgentCliLlmProvider({
      name: 'droid',
      command: 'droid',
      extractor: droidExtractor,
      buildArgs: (p) => ['exec', '--output-format', 'json', p],
      exec: fakeExec({ stdout: droidJson, stderr: '', code: 0 }, sink),
    });

    expect(await llm.complete({ prompt: 'p' })).toBe('looks good');
    expect(sink[0]).not.toContain('--auto');
  });

  it('throws on a non-zero exit (fail closed)', async () => {
    const llm = new AgentCliLlmProvider({
      name: 'codex', command: 'codex', extractor: codexExtractor,
      buildArgs: (p) => [p], exec: fakeExec({ stdout: '', stderr: 'boom', code: 7 }),
    });
    await expect(llm.complete({ prompt: 'p' })).rejects.toThrow(/exited 7/);
  });

  it('throws when no parseable text comes back (fail closed)', async () => {
    const llm = new AgentCliLlmProvider({
      name: 'codex', command: 'codex', extractor: codexExtractor,
      buildArgs: (p) => [p], exec: fakeExec({ stdout: 'garbage, not json', stderr: '', code: 0 }),
    });
    await expect(llm.complete({ prompt: 'p' })).rejects.toThrow(/no parseable text/);
  });

  it('throws on a timeout', async () => {
    const llm = new AgentCliLlmProvider({
      name: 'codex', command: 'codex', extractor: codexExtractor,
      buildArgs: (p) => [p], exec: fakeExec({ stdout: '', stderr: '', code: 0, timedOut: true }),
    });
    await expect(llm.complete({ prompt: 'p' })).rejects.toThrow(/timed out/);
  });
});
