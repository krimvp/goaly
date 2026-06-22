import { describe, it, expect } from 'vitest';
import { SessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import { ClaudeCodeAdapter, parseClaudeOutput, type ExecFn } from './claude-code';

/** Build a fake exec that records its args and returns a canned process result. */
function fakeExec(
  result: { stdout: string; stderr: string; code: number; timedOut?: boolean },
  capture?: { args: string[][]; prompts: string[] },
): ExecFn {
  return async (args, input) => {
    capture?.args.push(args);
    capture?.prompts.push(input.prompt);
    return result;
  };
}

describe('parseClaudeOutput', () => {
  it('parses a whole-stdout JSON object', () => {
    const json = JSON.stringify({
      result: 'hello world',
      session_id: 'sess-123',
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const parsed = parseClaudeOutput(json);

    expect(parsed).toEqual({
      text: 'hello world',
      sessionId: 'sess-123',
      tokens: 15,
      breakdown: { input: 10, output: 5 },
    });
  });

  it('includes cache-read/cache-write tokens in the total and the breakdown', () => {
    const json = JSON.stringify({
      result: 'ok',
      session_id: 'sess-1',
      usage: {
        input_tokens: 3,
        output_tokens: 12,
        cache_read_input_tokens: 17_773,
        cache_creation_input_tokens: 3_273,
      },
    });
    const parsed = parseClaudeOutput(json);
    expect(parsed?.tokens).toBe(21_061);
    expect(parsed?.breakdown).toEqual({
      input: 3,
      output: 12,
      cacheRead: 17_773,
      cacheWrite: 3_273,
    });
  });

  it('prefers an explicit total_tokens over the input/output sum', () => {
    const json = JSON.stringify({
      result: 'x',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 42 },
    });

    expect(parseClaudeOutput(json)?.tokens).toBe(42);
  });

  it('parses JSON surrounded by log/noise lines', () => {
    const stdout = [
      '[info] starting claude',
      'some debug noise',
      JSON.stringify({ result: 'the answer', session_id: 'sess-9' }),
      '[info] done',
    ].join('\n');

    const parsed = parseClaudeOutput(stdout);

    expect(parsed).toEqual({ text: 'the answer', sessionId: 'sess-9' });
  });

  it('takes the LAST result-bearing line from stream-json', () => {
    const stdout = [
      JSON.stringify({ type: 'system', session_id: 'sess-1' }),
      JSON.stringify({ result: 'first', session_id: 'sess-1' }),
      JSON.stringify({ result: 'final', session_id: 'sess-1', usage: { total_tokens: 7 } }),
    ].join('\n');

    const parsed = parseClaudeOutput(stdout);

    expect(parsed).toEqual({ text: 'final', sessionId: 'sess-1', tokens: 7 });
  });

  it('returns null when there is no JSON object carrying text', () => {
    expect(parseClaudeOutput('just plain text, no json')).toBeNull();
    expect(parseClaudeOutput('')).toBeNull();
    expect(parseClaudeOutput(JSON.stringify({ session_id: 'x' }))).toBeNull();
  });
});

describe('ClaudeCodeAdapter', () => {
  it('exposes the harness name', () => {
    expect(new ClaudeCodeAdapter().name).toBe('claude-code');
  });

  it('returns completed with parsed session id and tokens on exit 0 + valid json', async () => {
    const capture = { args: [] as string[][], prompts: [] as string[] };
    const exec = fakeExec(
      {
        stdout: JSON.stringify({
          result: 'done!',
          session_id: 'sess-abc',
          usage: { input_tokens: 100, output_tokens: 23 },
        }),
        stderr: '',
        code: 0,
      },
      capture,
    );
    const adapter = new ClaudeCodeAdapter({ exec });

    const res = await adapter.run('do the thing');

    expect(res.status).toBe('completed');
    expect(res.output).toBe('done!');
    expect(res.sessionId).toBe(SessionId.parse('sess-abc'));
    expect(res.tokensUsed).toBe(123);
    // Result is a valid HarnessRunResult.
    expect(() => HarnessRunResult.parse(res)).not.toThrow();
    // CLI contract: claude -p <prompt> --output-format json --permission-mode acceptEdits
    expect(capture.args[0]).toEqual([
      '-p', 'do the thing', '--output-format', 'json', '--permission-mode', 'acceptEdits',
    ]);
  });

  it('adds --resume <sessionId> when a session is provided', async () => {
    const capture = { args: [] as string[][], prompts: [] as string[] };
    const exec = fakeExec(
      { stdout: JSON.stringify({ result: 'ok', session_id: 'sess-xyz' }), stderr: '', code: 0 },
      capture,
    );
    const adapter = new ClaudeCodeAdapter({ exec });

    await adapter.run('continue', SessionId.parse('sess-prev'));

    expect(capture.args[0]).toEqual([
      '-p',
      'continue',
      '--output-format',
      'json',
      '--permission-mode',
      'acceptEdits',
      '--resume',
      'sess-prev',
    ]);
  });

  it('threads --model after --output-format json and before --resume', async () => {
    const capture = { args: [] as string[][], prompts: [] as string[] };
    const exec = fakeExec(
      { stdout: JSON.stringify({ result: 'ok', session_id: 'sess' }), stderr: '', code: 0 },
      capture,
    );
    const adapter = new ClaudeCodeAdapter({ exec, model: 'opus-x' });

    await adapter.run('do it');
    expect(capture.args[0]).toEqual([
      '-p', 'do it', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--model', 'opus-x',
    ]);

    await adapter.run('again', SessionId.parse('sess-prev'));
    expect(capture.args[1]).toEqual([
      '-p', 'again', '--output-format', 'json', '--permission-mode', 'acceptEdits',
      '--model', 'opus-x', '--resume', 'sess-prev',
    ]);
  });

  it('parses through extra log lines around the json', async () => {
    const stdout = [
      'warning: experimental flag',
      JSON.stringify({ result: 'parsed anyway', session_id: 'sess-77' }),
    ].join('\n');
    const adapter = new ClaudeCodeAdapter({
      exec: fakeExec({ stdout, stderr: '', code: 0 }),
    });

    const res = await adapter.run('prompt');

    expect(res.status).toBe('completed');
    expect(res.output).toBe('parsed anyway');
    expect(res.sessionId).toBe(SessionId.parse('sess-77'));
  });

  it('returns crashed (but a valid RunResult) on a non-zero exit code', async () => {
    const adapter = new ClaudeCodeAdapter({
      exec: fakeExec({ stdout: '', stderr: 'boom: cli failed', code: 1 }),
    });

    const res = await adapter.run('prompt', SessionId.parse('sess-keep'));

    expect(res.status).toBe('crashed');
    expect(res.output).toBe('boom: cli failed');
    // Falls back to the passed-in session id.
    expect(res.sessionId).toBe(SessionId.parse('sess-keep'));
    expect(() => HarnessRunResult.parse(res)).not.toThrow();
  });

  it('falls back to claude-unknown when crashing with no session anywhere', async () => {
    const adapter = new ClaudeCodeAdapter({
      exec: fakeExec({ stdout: 'garbage', stderr: '', code: 1 }),
    });

    const res = await adapter.run('prompt');

    expect(res.status).toBe('crashed');
    expect(res.sessionId).toBe(SessionId.parse('claude-unknown'));
  });

  it('returns timeout when the exec reports timedOut', async () => {
    const adapter = new ClaudeCodeAdapter({
      exec: fakeExec({ stdout: '', stderr: 'killed', code: 137, timedOut: true }),
    });

    const res = await adapter.run('prompt');

    expect(res.status).toBe('timeout');
    expect(res.sessionId).toBe(SessionId.parse('claude-unknown'));
    expect(() => HarnessRunResult.parse(res)).not.toThrow();
  });

  it('returns truncated when exit 0 but stdout has no parseable json result', async () => {
    const adapter = new ClaudeCodeAdapter({
      exec: fakeExec({ stdout: 'partial output, connection drop', stderr: '', code: 0 }),
    });

    const res = await adapter.run('prompt', SessionId.parse('sess-t'));

    expect(res.status).toBe('truncated');
    expect(res.sessionId).toBe(SessionId.parse('sess-t'));
  });

  it('returns truncated when the json result is empty', async () => {
    const adapter = new ClaudeCodeAdapter({
      exec: fakeExec({
        stdout: JSON.stringify({ result: '', session_id: 'sess-e' }),
        stderr: '',
        code: 0,
      }),
    });

    const res = await adapter.run('prompt');

    expect(res.status).toBe('truncated');
    expect(res.sessionId).toBe(SessionId.parse('sess-e'));
  });

  it('never throws even if the injected exec rejects', async () => {
    const exec: ExecFn = async () => {
      throw new Error('exec exploded');
    };
    const adapter = new ClaudeCodeAdapter({ exec });

    const res = await adapter.run('prompt');

    expect(res.status).toBe('crashed');
    expect(res.output).toBe('exec exploded');
    expect(() => HarnessRunResult.parse(res)).not.toThrow();
  });
});
