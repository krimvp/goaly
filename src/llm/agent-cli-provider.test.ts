import { describe, it, expect } from 'vitest';
import { AgentCliLlmProvider } from './agent-cli-provider';
import { claudeCodec } from '../agent-cli/claude-codec';
import { codexCodec } from '../agent-cli/codex-codec';
import { droidCodec } from '../agent-cli/droid-codec';
import { piCodec } from '../agent-cli/pi-codec';
import type { AgentStreamEvent } from '../agent-cli/stream';

type ExecResult = { stdout: string; stderr: string; code: number; timedOut?: boolean };
const ok = (stdout: string): ExecResult => ({ stdout, stderr: '', code: 0, timedOut: false });

/** A fake exec that records the (args, input) it was called with, then returns a fixed result. */
function recExec(result: ExecResult, rec?: { args: string[]; input: string | undefined }[]) {
  return async (args: string[], input: string | undefined): Promise<ExecResult> => {
    rec?.push({ args, input });
    return result;
  };
}

/** A fake exec that pushes its whole stdout to the live tap, then returns it. */
function streamExec(stdout: string) {
  return async (
    _args: string[],
    _input: string | undefined,
    onStdout?: (c: string) => void,
  ): Promise<ExecResult> => {
    onStdout?.(stdout);
    return ok(stdout);
  };
}

describe('AgentCliLlmProvider — one codec-driven provider for every CLI', () => {
  it('codex: prompt on argv (not stdin), model from ctor, parsed text + tokens', async () => {
    const rec: { args: string[]; input: string | undefined }[] = [];
    const jsonl = JSON.stringify({ type: 'result', text: 'the verdict', usage: { total_tokens: 3 } });
    const llm = new AgentCliLlmProvider({
      codec: codexCodec,
      model: 'gpt-x',
      exec: recExec(ok(jsonl), rec),
    });

    const out = await llm.complete({ system: 'sys', prompt: 'judge this' });

    expect(out.text).toBe('the verdict');
    expect(out.tokensUsed).toBe(3);
    // codex is argv-delivered: the combined prompt rides in argv, not on stdin.
    expect(rec[0]!.input).toBeUndefined();
    expect(rec[0]!.args).toEqual([
      'exec', '--sandbox', 'read-only', '--model', 'gpt-x', 'sys\n\njudge this', '--json',
    ]);
  });

  it('droid: parses output and never passes --auto (read-only)', async () => {
    const rec: { args: string[]; input: string | undefined }[] = [];
    const droidJson = JSON.stringify({ result: 'looks good', session_id: 's' });
    const llm = new AgentCliLlmProvider({ codec: droidCodec, exec: recExec(ok(droidJson), rec) });

    expect((await llm.complete({ prompt: 'p' })).text).toBe('looks good');
    expect(rec[0]!.args).not.toContain('--auto');
  });

  it('pi: read-only tools (no edit/write), parses JSONL, reports tokens', async () => {
    const rec: { args: string[]; input: string | undefined }[] = [];
    const piJsonl = [
      JSON.stringify({ type: 'session', id: 's-pi' }),
      JSON.stringify({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'the verdict' }],
          usage: { input: 1, output: 2, totalTokens: 3 },
        },
      }),
    ].join('\n');
    const llm = new AgentCliLlmProvider({
      codec: piCodec,
      model: 'ollama/qwen3:8b',
      exec: recExec(ok(piJsonl), rec),
    });

    const out = await llm.complete({ prompt: 'judge this' });
    expect(out.text).toBe('the verdict');
    expect(out.tokensUsed).toBe(3);
    expect(rec[0]!.args).toContain('read,grep,find,ls');
    expect(rec[0]!.args).not.toContain('edit');
    expect(rec[0]!.args).not.toContain('write');
  });

  it('claude: combines system + prompt ON STDIN and parses the JSON envelope', async () => {
    const rec: { args: string[]; input: string | undefined }[] = [];
    const json = JSON.stringify({ result: 'answer', usage: { input_tokens: 7, output_tokens: 5 } });
    const llm = new AgentCliLlmProvider({ codec: claudeCodec, exec: recExec(ok(json), rec) });

    const out = await llm.complete({ system: 'sys', prompt: 'p', temperature: 0 });

    expect(out.text).toBe('answer');
    expect(out.tokensUsed).toBe(12);
    expect(out.tokenSource).toBe('reported');
    // claude is stdin-delivered: the prompt is on stdin, never an argv positional.
    expect(rec[0]!.input).toBe('sys\n\np');
    expect(rec[0]!.args).toEqual(['-p', '--output-format', 'json']);
  });

  it('claude: sends just the prompt on stdin when there is no system message', async () => {
    const rec: { args: string[]; input: string | undefined }[] = [];
    const json = JSON.stringify({ result: 'x' });
    const llm = new AgentCliLlmProvider({ codec: claudeCodec, exec: recExec(ok(json), rec) });
    await llm.complete({ prompt: 'only' });
    expect(rec[0]!.input).toBe('only');
  });

  it('claude: threads resumeSessionId as --resume and surfaces the completion sessionId', async () => {
    const rec: { args: string[]; input: string | undefined }[] = [];
    const envelope = JSON.stringify({ result: 'revised json', session_id: 'sess-2' });
    const llm = new AgentCliLlmProvider({ codec: claudeCodec, exec: recExec(ok(envelope), rec) });

    expect(llm.supportsResume).toBe(true);
    const out = await llm.complete({ prompt: 'revise it', resumeSessionId: 'sess-1' });

    expect(rec[0]!.args).toContain('--resume');
    expect(rec[0]!.args[rec[0]!.args.indexOf('--resume') + 1]).toBe('sess-1');
    expect(out.sessionId).toBe('sess-2');
  });

  it('claude: never resumes with the unknown-session sentinel (degrades to a fresh call)', async () => {
    const rec: { args: string[]; input: string | undefined }[] = [];
    const envelope = JSON.stringify({ result: 'fresh', session_id: 'sess-3' });
    const llm = new AgentCliLlmProvider({ codec: claudeCodec, exec: recExec(ok(envelope), rec) });

    await llm.complete({ prompt: 'p', resumeSessionId: claudeCodec.unknownSession });

    expect(rec[0]!.args).not.toContain('--resume');
  });

  it('a codec without read-only resume ignores resumeSessionId (fresh call, no resume argv)', async () => {
    const rec: { args: string[]; input: string | undefined }[] = [];
    const jsonl = JSON.stringify({ type: 'result', text: 'verdict', usage: { total_tokens: 1 } });
    const llm = new AgentCliLlmProvider({ codec: codexCodec, exec: recExec(ok(jsonl), rec) });

    expect(llm.supportsResume).toBe(false);
    await llm.complete({ prompt: 'p', resumeSessionId: 'sess-1' });

    expect(rec[0]!.args.join(' ')).not.toContain('sess-1');
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
    const llm = new AgentCliLlmProvider({
      codec: claudeCodec,
      onEvent: () => {}, // streaming on → stream-json path
      exec: streamExec(streamJson),
    });
    const out = await llm.complete({ prompt: 'p' });
    expect(out.text).toBe('verdict');
    expect(out.tokenSource).toBe('estimated');
    expect(out.tokensUsed).toBe(Math.ceil('Reasoning through it.'.length / 4));
  });

  it('codex: forwards ordered stream events and returns the final text', async () => {
    const events: AgentStreamEvent[] = [];
    const codexStream = [
      JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'verdict: PASS' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 8, output_tokens: 2 } }),
    ].join('\n');
    const llm = new AgentCliLlmProvider({
      codec: codexCodec,
      onEvent: (e) => events.push(e),
      exec: streamExec(codexStream),
    });

    const out = await llm.complete({ prompt: 'judge this' });

    expect(out.text).toBe('verdict: PASS');
    expect(events.map((e) => e.kind)).toEqual(['session', 'message', 'usage', 'done']);
  });

  it('a throwing stream sink does not crash the step or change the returned text', async () => {
    const codexStream = [
      JSON.stringify({ type: 'thread.started', thread_id: 'th-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'PASS' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');
    const make = (onEvent?: (e: AgentStreamEvent) => void): AgentCliLlmProvider =>
      new AgentCliLlmProvider({
        codec: codexCodec,
        ...(onEvent !== undefined ? { onEvent } : {}),
        exec: streamExec(codexStream),
      });

    const baseline = await make().complete({ prompt: 'x' });
    const streamed = await make(() => {
      throw new Error('sink exploded');
    }).complete({ prompt: 'x' });
    expect(streamed).toEqual(baseline);
  });

  it('throws on a non-zero exit after exhausting bounded retries (fail closed)', async () => {
    let calls = 0;
    const llm = new AgentCliLlmProvider({
      codec: codexCodec,
      sleep: () => Promise.resolve(),
      exec: async () => {
        calls += 1;
        return { stdout: '', stderr: 'boom', code: 7 };
      },
    });
    await expect(llm.complete({ prompt: 'p' })).rejects.toThrow(/exited 7/);
    expect(calls).toBe(3); // default: 2 retries → 3 attempts
  });

  it('throws when no parseable text comes back — fail closed, no plain-text fallback', async () => {
    // Both the argv-delivered (codex) and stdin-delivered (claude) codecs fail closed on garbage —
    // the old claude "return raw stdout" fallback is gone (invariant #4).
    for (const codec of [codexCodec, claudeCodec]) {
      const llm = new AgentCliLlmProvider({
        codec,
        sleep: () => Promise.resolve(),
        exec: async () => ok('garbage, not json'),
      });
      await expect(llm.complete({ prompt: 'p' })).rejects.toThrow(/no parseable text/);
    }
  });

  it('recovers when a transient failure clears on a later attempt (retry with backoff)', async () => {
    const jsonl = JSON.stringify({ type: 'result', text: 'verdict', usage: { total_tokens: 3 } });
    const slept: number[] = [];
    let calls = 0;
    const llm = new AgentCliLlmProvider({
      codec: codexCodec,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      exec: async () => {
        calls += 1;
        return calls < 3 ? { stdout: '', stderr: 'rate limited', code: 1 } : ok(jsonl);
      },
    });
    const out = await llm.complete({ prompt: 'p' });
    expect(out.text).toBe('verdict');
    expect(calls).toBe(3);
    expect(slept).toEqual([1000, 2000]); // linear backoff between attempts
  });

  it('does NOT retry a timeout — the wall-clock cap is the run\'s own guard', async () => {
    let calls = 0;
    const llm = new AgentCliLlmProvider({
      codec: codexCodec,
      sleep: () => Promise.resolve(),
      exec: async () => {
        calls += 1;
        return { stdout: '', stderr: '', code: 0, timedOut: true };
      },
    });
    await expect(llm.complete({ prompt: 'p' })).rejects.toThrow(/timed out/);
    expect(calls).toBe(1);
  });
});
