import { describe, it, expect } from 'vitest';
import { SessionId } from '../domain/ids';
import { HarnessRunResult } from '../domain/events';
import { AgentCliHarness } from '../harness/agent-cli-harness';
import { droidCodec, makeDroidCodec } from './droid-codec';
import { type AgentExecFn } from './codec';

/** Build a fake exec that records its args/prompts and returns a canned process result. */
function fakeExec(
  result: { stdout: string; stderr: string; code: number; timedOut?: boolean },
  capture?: { args: string[][]; prompts: string[] },
): AgentExecFn {
  return async (args, input) => {
    capture?.args.push(args);
    capture?.prompts.push(input.prompt);
    return result;
  };
}

/** A real `droid exec --output-format json` envelope captured from droid 0.164.0. */
const droidRealSample = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  duration_ms: 1858,
  num_turns: 1,
  result: 'ready',
  session_id: '37afb4b6-fb90-480f-971e-56cbf7ad1cae',
  usage: {
    input_tokens: 13716,
    output_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
});

/**
 * A real `droid exec --output-format stream-json` transcript captured from droid 0.164.0 (trimmed:
 * long paths/tool lists shortened; keys and line shapes verbatim). Note the droid-NATIVE envelope —
 * message/reasoning/tool_call/tool_result/completion — not the Anthropic agent-SDK one, and the
 * duplicated reasoning line, which droid really emits.
 */
const SID = '11222393-d4e2-464e-bd63-eb6b96d7a40e';
const droidStreamLines = [
  { type: 'system', subtype: 'init', cwd: '/tmp/probe', session_id: SID, tools: ['Read', 'Execute', 'Create'], model: 'claude-opus-4-8', reasoning_effort: 'high' },
  { type: 'message', role: 'user', id: 'f8401e2e', text: 'create a file named probe.txt containing the word hello, then report done', timestamp: 1783373407509, session_id: SID },
  { type: 'reasoning', id: '5a9e1859', text: 'The user wants me to create a simple file named probe.txt.', timestamp: 1783373409985, session_id: SID },
  { type: 'reasoning', id: '5a9e1859', text: 'The user wants me to create a simple file named probe.txt.', timestamp: 1783373409985, session_id: SID },
  { type: 'tool_call', id: 'call_4wv2tm9k', messageId: '5a9e1859', toolId: 'Create', toolName: 'Create', parameters: { file_path: '/tmp/probe/probe.txt', content: 'hello' }, timestamp: 1783373409985, session_id: SID },
  { type: 'tool_result', id: 'call_4wv2tm9k', messageId: 'ff11ae55', toolId: 'Create', isError: false, value: '{"success":true,"file_path":"/tmp/probe/probe.txt"}', timestamp: 1783373410009, session_id: SID },
  { type: 'message', role: 'assistant', id: 'f213682c', text: 'Done. Created `probe.txt` containing the word "hello".', timestamp: 1783373411553, session_id: SID },
  { type: 'completion', finalText: 'Done. Created `probe.txt` containing the word "hello".', numTurns: 2, durationMs: 4074, session_id: SID, timestamp: 1783373411556, usage: { input_tokens: 30671, output_tokens: 116, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
];
const droidStreamStdout = (n = droidStreamLines.length) =>
  droidStreamLines.slice(0, n).map((l) => JSON.stringify(l)).join('\n');

describe('droidCodec.parse', () => {
  it('extracts result text, session id, and summed tokens from a real envelope', () => {
    const parsed = droidCodec.parse(droidRealSample);
    expect(parsed).toEqual({
      text: 'ready',
      sessionId: '37afb4b6-fb90-480f-971e-56cbf7ad1cae',
      tokens: 13718,
      breakdown: { input: 13716, output: 2, cacheRead: 0, cacheWrite: 0 },
      isError: false,
    });
  });

  it('prefers an explicit total_tokens over the input/output sum', () => {
    const json = JSON.stringify({
      result: 'x',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 42 },
    });
    expect(droidCodec.parse(json)?.tokens).toBe(42);
  });

  it('parses a JSON object surrounded by log/noise lines', () => {
    const stdout = [
      '[info] booting droid',
      'some debug noise',
      JSON.stringify({ result: 'the answer', session_id: 'sess-9' }),
      '[info] done',
    ].join('\n');
    expect(droidCodec.parse(stdout)).toEqual({ text: 'the answer', sessionId: 'sess-9' });
  });

  it('takes the LAST result-bearing line but latches the FIRST session id from a stream', () => {
    const stdout = [
      JSON.stringify({ type: 'system', session_id: 'sess-1' }),
      JSON.stringify({ result: 'first', session_id: 'sess-1' }),
      JSON.stringify({ result: 'final', usage: { total_tokens: 7 } }),
    ].join('\n');
    expect(droidCodec.parse(stdout)).toEqual({ text: 'final', sessionId: 'sess-1', tokens: 7 });
  });

  it('surfaces is_error when droid reports a failed result', () => {
    const stdout = JSON.stringify({ result: 'could not finish', is_error: true, session_id: 's1' });
    expect(droidCodec.parse(stdout)).toEqual({
      text: 'could not finish',
      sessionId: 's1',
      isError: true,
    });
  });

  it('returns null when there is no JSON object carrying text', () => {
    expect(droidCodec.parse('just plain text, no json')).toBeNull();
    expect(droidCodec.parse('')).toBeNull();
    expect(droidCodec.parse(JSON.stringify({ session_id: 'x', is_error: false }))).toBeNull();
  });
});

describe('droidCodec.parse (native stream-json transcript, captured 0.164.0)', () => {
  it('recovers finalText from the completion line, with the session and full usage', () => {
    expect(droidCodec.parse(droidStreamStdout())).toEqual({
      text: 'Done. Created `probe.txt` containing the word "hello".',
      sessionId: SID,
      tokens: 30787,
      breakdown: { input: 30671, output: 116, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('never salvages the echoed USER prompt as result text (stream cut after the echo)', () => {
    // system + user-message lines only: a run that died right after starting.
    expect(droidCodec.parse(droidStreamStdout(2))).toBeNull();
  });

  it('does not treat reasoning or tool traffic as result text', () => {
    // through system, user echo, both reasoning lines, tool_call, tool_result — still no result.
    expect(droidCodec.parse(droidStreamStdout(6))).toBeNull();
  });

  it('salvages the last assistant message when the stream dies before completion', () => {
    const parsed = droidCodec.parse(droidStreamStdout(7));
    expect(parsed?.text).toBe('Done. Created `probe.txt` containing the word "hello".');
    expect(parsed?.sessionId).toBe(SID);
  });
});

describe('AgentCliHarness(droidCodec)', () => {
  it('exposes the harness name', () => {
    expect(new AgentCliHarness(droidCodec).name).toBe('droid');
  });

  it('maps a clean run to completed with parsed session id and tokens', async () => {
    const capture = { args: [] as string[][], prompts: [] as string[] };
    const adapter = new AgentCliHarness(droidCodec, { exec: fakeExec({ stdout: droidRealSample, stderr: '', code: 0 }, capture) });

    const res = await adapter.run('do the thing');

    expect(res.status).toBe('completed');
    expect(res.output).toBe('ready');
    expect(res.sessionId).toBe(SessionId.parse('37afb4b6-fb90-480f-971e-56cbf7ad1cae'));
    expect(res.tokensUsed).toBe(13718);
    expect(() => HarnessRunResult.parse(res)).not.toThrow();
    // CLI contract: flags first (default autonomy is `low`), prompt last.
    expect(capture.args[0]).toEqual([
      'exec', '--output-format', 'json', '--auto', 'low', 'do the thing',
    ]);
  });

  it('resumes via --fork <id> (exec -s fetches remotely and fails for local sessions), prompt last', async () => {
    const capture = { args: [] as string[][], prompts: [] as string[] };
    const adapter = new AgentCliHarness(droidCodec, { exec: fakeExec({ stdout: droidRealSample, stderr: '', code: 0 }, capture) });

    await adapter.run('continue', SessionId.parse('sess-prev'));

    expect(capture.args[0]).toEqual([
      'exec', '--output-format', 'json', '--auto', 'low', '--fork', 'sess-prev', 'continue',
    ]);
  });

  it('honors a configured autonomy level', async () => {
    const capture = { args: [] as string[][], prompts: [] as string[] };
    const adapter = new AgentCliHarness(makeDroidCodec('medium'), {
      exec: fakeExec({ stdout: droidRealSample, stderr: '', code: 0 }, capture),
    });

    await adapter.run('go');

    expect(capture.args[0]).toEqual([
      'exec', '--output-format', 'json', '--auto', 'medium', 'go',
    ]);
  });

  it('threads --model among the leading flags, prompt last (fresh + resume)', async () => {
    const capture = { args: [] as string[][], prompts: [] as string[] };
    const adapter = new AgentCliHarness(droidCodec, {
      model: 'm1',
      exec: fakeExec({ stdout: droidRealSample, stderr: '', code: 0 }, capture),
    });

    await adapter.run('do it');
    expect(capture.args[0]).toEqual([
      'exec', '--output-format', 'json', '--auto', 'low', '--model', 'm1', 'do it',
    ]);

    await adapter.run('more', SessionId.parse('sess-prev'));
    expect(capture.args[1]).toEqual([
      'exec', '--output-format', 'json', '--auto', 'low', '--model', 'm1', '--fork', 'sess-prev', 'more',
    ]);
  });

  it('returns crashed (but a valid RunResult) on a non-zero exit code', async () => {
    const adapter = new AgentCliHarness(droidCodec, { exec: fakeExec({ stdout: '', stderr: 'boom: cli failed', code: 1 }) });

    const res = await adapter.run('prompt', SessionId.parse('sess-keep'));

    expect(res.status).toBe('crashed');
    expect(res.output).toBe('boom: cli failed');
    expect(res.sessionId).toBe(SessionId.parse('sess-keep'));
    expect(() => HarnessRunResult.parse(res)).not.toThrow();
  });

  it('falls back to droid-unknown when crashing with no session anywhere', async () => {
    const adapter = new AgentCliHarness(droidCodec, { exec: fakeExec({ stdout: 'garbage', stderr: '', code: 1 }) });

    const res = await adapter.run('prompt');

    expect(res.status).toBe('crashed');
    expect(res.sessionId).toBe(SessionId.parse('droid-unknown'));
  });

  it('returns truncated when exit 0 but stdout has no parseable json result', async () => {
    const adapter = new AgentCliHarness(droidCodec, {
      exec: fakeExec({ stdout: 'partial output, connection drop', stderr: '', code: 0 }),
    });

    const res = await adapter.run('prompt', SessionId.parse('sess-t'));

    expect(res.status).toBe('truncated');
    expect(res.sessionId).toBe(SessionId.parse('sess-t'));
  });

  it('returns truncated when droid reports is_error on a clean exit', async () => {
    const stdout = JSON.stringify({ result: 'aborted mid-task', is_error: true, session_id: 'sess-e' });
    const adapter = new AgentCliHarness(droidCodec, { exec: fakeExec({ stdout, stderr: '', code: 0 }) });

    const res = await adapter.run('go');

    expect(res.status).toBe('truncated');
    expect(res.output).toBe('aborted mid-task');
    expect(res.sessionId).toBe(SessionId.parse('sess-e'));
  });

  it('maps a timed-out run to timeout, salvaging any parsed text and session', async () => {
    const adapter = new AgentCliHarness(droidCodec, {
      exec: fakeExec({ stdout: droidRealSample, stderr: '', code: 0, timedOut: true }),
    });

    const res = await adapter.run('slow task');

    expect(res.status).toBe('timeout');
    expect(res.output).toBe('ready');
    expect(res.sessionId).toBe(SessionId.parse('37afb4b6-fb90-480f-971e-56cbf7ad1cae'));
  });

  it('never throws even if the injected exec rejects', async () => {
    const exec: AgentExecFn = async () => {
      throw new Error('spawn ENOENT');
    };
    const adapter = new AgentCliHarness(droidCodec, { exec });

    const res = await adapter.run('prompt');

    expect(res.status).toBe('crashed');
    expect(res.output).toBe('spawn ENOENT');
    expect(res.sessionId).toBe(SessionId.parse('droid-unknown'));
    expect(() => HarnessRunResult.parse(res)).not.toThrow();
  });

  it('omits tokensUsed when the envelope carries no usage', async () => {
    const stdout = JSON.stringify({ result: 'done', session_id: 's1' });
    const adapter = new AgentCliHarness(droidCodec, { exec: fakeExec({ stdout, stderr: '', code: 0 }) });

    const res = await adapter.run('go');

    expect(res.status).toBe('completed');
    expect(res.tokensUsed).toBeUndefined();
  });
});
