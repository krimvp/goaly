import { describe, it, expect } from 'vitest';
import { SessionId } from '../domain/ids';
import { claudeCodec } from './claude-codec';
import { codexCodec } from './codex-codec';
import { droidCodec, makeDroidCodec } from './droid-codec';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyFlatRun,
  defaultAgentExec,
  runCodecHarness,
  type AgentCliCodec,
  type AgentExecFn,
} from './codec';

const sid = (s: string): SessionId => SessionId.parse(s);

/**
 * One codec owns BOTH argv dialects for its CLI. These pin the write-mode (harness) and read-only
 * (LLM) argv so the two consumers — the HarnessAdapter and the AgentCliLlmProvider — stay in lockstep
 * from one source of truth.
 */
describe('AgentCliCodec argv dialects', () => {
  describe('claude', () => {
    it('harnessArgs: -p <prompt> --output-format json --permission-mode acceptEdits, then model, then resume', () => {
      expect(claudeCodec.harnessArgs({ prompt: 'go', model: undefined, stream: false })).toEqual([
        '-p', 'go', '--output-format', 'json', '--permission-mode', 'acceptEdits',
      ]);
      expect(
        claudeCodec.harnessArgs({ prompt: 'go', model: 'opus', sessionId: sid('s-1'), stream: false }),
      ).toEqual([
        '-p', 'go', '--output-format', 'json', '--permission-mode', 'acceptEdits',
        '--model', 'opus', '--resume', 's-1',
      ]);
    });

    it('harnessArgs: streaming swaps json → stream-json --verbose (still acceptEdits)', () => {
      expect(claudeCodec.harnessArgs({ prompt: 'go', model: undefined, stream: true })).toEqual([
        '-p', 'go', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      ]);
    });

    it('readonlyArgs: no prompt positional (prompt goes on stdin)', () => {
      expect(claudeCodec.readonlyArgs({ prompt: 'ignored', model: 'opus', stream: false })).toEqual([
        '-p', '--output-format', 'json', '--model', 'opus',
      ]);
      expect(claudeCodec.promptOnStdin).toBe(true);
    });
  });

  describe('codex', () => {
    it('harnessArgs: --full-auto, model before the prompt, --json (resume threads the id)', () => {
      expect(codexCodec.harnessArgs({ prompt: 'do it', model: 'gpt-x', stream: false })).toEqual([
        'exec', '--full-auto', '--model', 'gpt-x', 'do it', '--json',
      ]);
      expect(
        codexCodec.harnessArgs({ prompt: 'more', model: undefined, sessionId: sid('prev'), stream: false }),
      ).toEqual(['exec', 'resume', 'prev', '--full-auto', 'more', '--json']);
    });

    it('readonlyArgs: --sandbox read-only (never --full-auto), model before the prompt', () => {
      expect(codexCodec.readonlyArgs({ prompt: 'judge this', model: 'gpt-x', stream: false })).toEqual([
        'exec', '--sandbox', 'read-only', '--model', 'gpt-x', 'judge this', '--json',
      ]);
    });
  });

  describe('droid', () => {
    it('harnessArgs: flags first (default autonomy low), prompt last; streaming swaps the format', () => {
      expect(droidCodec.harnessArgs({ prompt: 'go', model: undefined, stream: false })).toEqual([
        'exec', '--output-format', 'json', '--auto', 'low', 'go',
      ]);
      expect(
        makeDroidCodec('medium').harnessArgs({ prompt: 'go', model: 'm1', sessionId: sid('s'), stream: true }),
      ).toEqual([
        'exec', '--output-format', 'stream-json', '--auto', 'medium', '--model', 'm1', '--session-id', 's', 'go',
      ]);
    });

    it('readonlyArgs: never passes --auto (the exec default cannot edit the tree)', () => {
      const args = droidCodec.readonlyArgs({ prompt: 'p', model: 'm1', stream: false });
      expect(args).toEqual(['exec', '--output-format', 'json', '--model', 'm1', 'p']);
      expect(args).not.toContain('--auto');
    });
  });
});

describe('codexCodec.classify (the inverted, bespoke status policy)', () => {
  const base = { stderr: '', sessionId: undefined };

  it('no-parse → crashed (vs the flat codecs, which map no-parse on a clean exit to truncated)', () => {
    const r = codexCodec.classify({ ...base, stdout: 'not json', code: 0 });
    expect(r.status).toBe('crashed');
    expect(r.sessionId).toBe('codex-unknown');
  });

  it('non-zero exit WITH parseable text → truncated', () => {
    const stdout = JSON.stringify({ text: 'half', session_id: 'sess-9' });
    const r = codexCodec.classify({ ...base, stdout, code: 137 });
    expect(r.status).toBe('truncated');
    expect(r.output).toBe('half');
    expect(r.sessionId).toBe('sess-9');
  });

  it('a null (signal-killed) exit with text → truncated', () => {
    const stdout = JSON.stringify({ text: 'partial' });
    expect(codexCodec.classify({ ...base, stdout, code: null }).status).toBe('truncated');
  });

  it('timeout salvages parsed text', () => {
    const stdout = JSON.stringify({ text: 'salvaged', session_id: 's' });
    const r = codexCodec.classify({ ...base, stdout, code: null, timedOut: true });
    expect(r.status).toBe('timeout');
    expect(r.output).toBe('salvaged');
  });
});

describe('classifyFlatRun (claude/droid shared policy)', () => {
  it('treats a null (signal-killed) exit as a non-zero crash', () => {
    const r = classifyFlatRun({ parsed: null, code: null, stderr: 'boom', unknownSession: 'unk' });
    expect(r.status).toBe('crashed');
    expect(r.output).toBe('boom');
  });
});

describe('runCodecHarness', () => {
  /** A minimal codec that records the argv it was asked for and classifies trivially. */
  function spyCodec(captured: { args: string[][] }): AgentCliCodec {
    return {
      ...claudeCodec,
      harnessArgs(opts) {
        const args = claudeCodec.harnessArgs(opts);
        captured.args.push(args);
        return args;
      },
    };
  }

  it('threads the codec argv into exec and classifies the result', async () => {
    const captured = { args: [] as string[][] };
    const exec: AgentExecFn = async () => ({
      stdout: JSON.stringify({ result: 'done', session_id: 's-1', usage: { total_tokens: 9 } }),
      stderr: '',
      code: 0,
    });
    const result = await runCodecHarness(spyCodec(captured), exec, 'opus', 'go', sid('prev'));
    expect(captured.args[0]).toEqual([
      '-p', 'go', '--output-format', 'json', '--permission-mode', 'acceptEdits', '--model', 'opus', '--resume', 'prev',
    ]);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('done');
    expect(result.tokensUsed).toBe(9);
  });

  it('never throws when the exec seam itself rejects — fails closed to crashed', async () => {
    const exec: AgentExecFn = async () => {
      throw new Error('spawn ENOENT');
    };
    const result = await runCodecHarness(codexCodec, exec, undefined, 'go');
    expect(result.status).toBe('crashed');
    expect(result.output).toBe('spawn ENOENT');
    expect(result.sessionId).toBe('codex-unknown');
  });

  it('forwards streamed turns to the onEvent sink and still returns the final result', async () => {
    const kinds: string[] = [];
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's-1' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }),
    ].join('\n');
    const exec: AgentExecFn = async (_args, _input, onStdout) => {
      onStdout?.(stream);
      return { stdout: stream, stderr: '', code: 0 };
    };
    const result = await runCodecHarness(claudeCodec, exec, undefined, 'go', undefined, (e) => kinds.push(e.kind));
    expect(result.status).toBe('completed');
    expect(result.output).toBe('done');
    expect(kinds).toEqual(['session', 'message', 'usage', 'done']);
  });
});

describe('defaultAgentExec cwd (the agent runs IN the workspace)', () => {
  it('spawns the binary in the provided cwd, not goaly\'s process cwd', async () => {
    const ws = await realpath(await mkdtemp(join(tmpdir(), 'goaly-cwd-')));
    const exec = defaultAgentExec('node', 5000, false, ws);
    const r = await exec(['-e', 'process.stdout.write(process.cwd())'], { prompt: '' });
    expect(r.code).toBe(0);
    expect(await realpath(r.stdout.trim())).toBe(ws);
    expect(r.stdout.trim()).not.toBe(process.cwd()); // would be the bug: agent in goaly's cwd
  });

  it('falls back to the inherited cwd when none is given (sandbox sets the jail cwd itself)', async () => {
    const exec = defaultAgentExec('node', 5000, false);
    const r = await exec(['-e', 'process.stdout.write(process.cwd())'], { prompt: '' });
    expect(await realpath(r.stdout.trim())).toBe(await realpath(process.cwd()));
  });
});
