import { describe, it, expect } from 'vitest';
import { AgentCliLlmProvider } from './agent-cli-provider';
import { codexCodec } from '../agent-cli/codex-codec';
import { droidCodec } from '../agent-cli/droid-codec';
import { piCodec } from '../agent-cli/pi-codec';

const codexExtractor = codexCodec.fieldExtractor;
const droidExtractor = droidCodec.fieldExtractor;
const piExtractor = piCodec.fieldExtractor;

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

    expect(out.text).toBe('the verdict');
    expect(out.tokensUsed).toBe(3);
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

    expect((await llm.complete({ prompt: 'p' })).text).toBe('looks good');
    expect(sink[0]).not.toContain('--auto');
  });

  it('parses pi JSONL output via its codec read-only argv (read-only tools, no edit/write)', async () => {
    const sink: string[][] = [];
    const piJsonl = [
      JSON.stringify({ type: 'session', id: 's-pi' }),
      JSON.stringify({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: 'the verdict' }], usage: { input: 1, output: 2, totalTokens: 3 } },
      }),
    ].join('\n');
    const llm = new AgentCliLlmProvider({
      name: piCodec.name,
      command: piCodec.command,
      extractor: piExtractor,
      buildArgs: (p) => piCodec.readonlyArgs({ prompt: p, model: 'ollama/qwen3:8b', stream: false }),
      exec: fakeExec({ stdout: piJsonl, stderr: '', code: 0 }, sink),
    });

    const out = await llm.complete({ prompt: 'judge this' });
    expect(out.text).toBe('the verdict');
    expect(out.tokensUsed).toBe(3);
    expect(sink[0]).toContain('read,grep,find,ls');
    expect(sink[0]).not.toContain('edit');
    expect(sink[0]).not.toContain('write');
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
