import { describe, it, expect } from 'vitest';
import { SessionId } from '../domain/ids';
import { CodexAdapter, parseCodexOutput, type ExecFn, type ExecResult } from './codex';

/** Build an ExecFn that returns a canned result and records the args it was called with. */
function fakeExec(
  result: ExecResult,
  sink?: { args: string[][]; prompts: string[] },
): ExecFn {
  return async (args, input) => {
    sink?.args.push(args);
    sink?.prompts.push(input.prompt);
    return result;
  };
}

const successJsonl = [
  JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-42' }),
  JSON.stringify({ type: 'assistant.delta', delta: { text: 'partial ' } }),
  JSON.stringify({
    type: 'result',
    text: 'all done, files written',
    usage: { input_tokens: 100, output_tokens: 23 },
  }),
].join('\n');

describe('parseCodexOutput', () => {
  it('extracts final text, session id, and tokens from success JSONL', () => {
    const parsed = parseCodexOutput(successJsonl);
    expect(parsed).not.toBeNull();
    expect(parsed?.text).toBe('all done, files written');
    expect(parsed?.sessionId).toBe('codex-thread-42');
    expect(parsed?.tokens).toBe(123);
  });

  it('tolerates non-JSON and partial lines, keeping the last valid text', () => {
    const stdout = [
      'not json at all',
      '{ broken json',
      JSON.stringify({ text: 'first' }),
      '',
      JSON.stringify({ message: { content: 'second' } }),
    ].join('\n');
    const parsed = parseCodexOutput(stdout);
    expect(parsed?.text).toBe('second');
  });

  it('returns null when no line is valid JSON', () => {
    expect(parseCodexOutput('garbage\nmore garbage')).toBeNull();
  });

  it('returns null when JSON is valid but carries no text', () => {
    const stdout = JSON.stringify({ type: 'thread.started', thread_id: 'x' });
    expect(parseCodexOutput(stdout)).toBeNull();
  });

  it('extracts text from a content array of parts', () => {
    const stdout = JSON.stringify({ content: [{ text: 'a' }, { text: 'b' }] });
    expect(parseCodexOutput(stdout)?.text).toBe('ab');
  });
});

describe('CodexAdapter', () => {
  it('has the name "codex"', () => {
    expect(new CodexAdapter().name).toBe('codex');
  });

  it('maps a clean success run to status "completed" with session id and tokens', async () => {
    const sink = { args: [] as string[][], prompts: [] as string[] };
    const exec = fakeExec({ stdout: successJsonl, stderr: '', code: 0 }, sink);
    const adapter = new CodexAdapter({ exec });

    const result = await adapter.run('do the thing');

    expect(result.status).toBe('completed');
    expect(result.output).toBe('all done, files written');
    expect(result.sessionId).toBe('codex-thread-42');
    expect(result.tokensUsed).toBe(123);
    // Default (no resume) args.
    expect(sink.args[0]).toEqual(['exec', 'do the thing', '--json']);
  });

  it('passes a resume flag and session id when resuming', async () => {
    const sink = { args: [] as string[][], prompts: [] as string[] };
    const exec = fakeExec({ stdout: successJsonl, stderr: '', code: 0 }, sink);
    const adapter = new CodexAdapter({ exec });

    const sid = SessionId.parse('prev-session');
    await adapter.run('continue', sid);

    expect(sink.args[0]).toEqual(['exec', 'resume', 'prev-session', 'continue', '--json']);
  });

  it('threads --model before the prompt positional (fresh + resume)', async () => {
    const sink = { args: [] as string[][], prompts: [] as string[] };
    const exec = fakeExec({ stdout: successJsonl, stderr: '', code: 0 }, sink);
    const adapter = new CodexAdapter({ exec, model: 'gpt-x' });

    await adapter.run('do it');
    expect(sink.args[0]).toEqual(['exec', '--model', 'gpt-x', 'do it', '--json']);

    await adapter.run('more', SessionId.parse('prev'));
    expect(sink.args[1]).toEqual(['exec', 'resume', 'prev', '--model', 'gpt-x', 'more', '--json']);
  });

  it('maps malformed stdout to "crashed" but still a valid RunResult', async () => {
    const exec = fakeExec({ stdout: 'totally not json', stderr: 'boom', code: 1 });
    const adapter = new CodexAdapter({ exec });

    const result = await adapter.run('go');

    expect(result.status).toBe('crashed');
    expect(result.output).toBe('');
    // Fallback session id is used (and is a valid SessionId).
    expect(result.sessionId).toBe('codex-unknown');
  });

  it('falls back to the resume session id when output omits one (crash path)', async () => {
    const exec = fakeExec({ stdout: 'nope', stderr: '', code: 1 });
    const adapter = new CodexAdapter({ exec });

    const sid = SessionId.parse('resumed-1');
    const result = await adapter.run('go', sid);

    expect(result.status).toBe('crashed');
    expect(result.sessionId).toBe('resumed-1');
  });

  it('maps a timed-out run to status "timeout"', async () => {
    const exec = fakeExec({ stdout: successJsonl, stderr: '', code: null, timedOut: true });
    const adapter = new CodexAdapter({ exec });

    const result = await adapter.run('slow task');

    expect(result.status).toBe('timeout');
    // Even on timeout we salvage any text/session we managed to parse.
    expect(result.output).toBe('all done, files written');
    expect(result.sessionId).toBe('codex-thread-42');
  });

  it('maps a non-zero exit with parseable text to "truncated"', async () => {
    const stdout = JSON.stringify({ text: 'half-finished', session_id: 'sess-9' });
    const exec = fakeExec({ stdout, stderr: '', code: 137 });
    const adapter = new CodexAdapter({ exec });

    const result = await adapter.run('go');

    expect(result.status).toBe('truncated');
    expect(result.output).toBe('half-finished');
    expect(result.sessionId).toBe('sess-9');
  });

  it('never throws when the exec seam itself rejects', async () => {
    const exec: ExecFn = async () => {
      throw new Error('spawn ENOENT');
    };
    const adapter = new CodexAdapter({ exec });

    const result = await adapter.run('go');

    expect(result.status).toBe('crashed');
    expect(result.sessionId).toBe('codex-unknown');
  });

  it('omits tokensUsed when the output carries no usage', async () => {
    const stdout = JSON.stringify({ text: 'done', session_id: 's1' });
    const exec = fakeExec({ stdout, stderr: '', code: 0 });
    const adapter = new CodexAdapter({ exec });

    const result = await adapter.run('go');

    expect(result.status).toBe('completed');
    expect(result.tokensUsed).toBeUndefined();
  });
});
