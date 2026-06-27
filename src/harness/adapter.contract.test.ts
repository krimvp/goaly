import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from './claude-code';
import { CodexAdapter } from './codex';
import { DroidAdapter } from './droid';
import { PiAdapter } from './pi';
import type { HarnessAdapter } from './adapter';
import { HarnessRunResult } from '../domain/events';
import { SessionId } from '../domain/ids';

/**
 * The same scenario matrix run against every real adapter. We assert the SEAM INVARIANTS
 * (never throws, always a valid reducer-safe HarnessRunResult, status within the enum) rather
 * than identical statuses — that is what makes the orchestrator genuinely harness-agnostic.
 */

type CommonExecResult = { stdout: string; stderr: string; code: number; timedOut?: boolean };

const claudeOk = JSON.stringify({
  result: 'done',
  session_id: 'sess-claude-1',
  usage: { total_tokens: 5 },
});
const codexOk = JSON.stringify({
  type: 'message',
  text: 'done',
  session_id: 'sess-codex-1',
  usage: { total_tokens: 5 },
});
const droidOk = JSON.stringify({
  type: 'result',
  result: 'done',
  session_id: 'sess-droid-1',
  usage: { input_tokens: 2, output_tokens: 3 },
});
// pi emits a JSONL event stream: the `session` line carries the id, the assistant `message_end`
// carries the text + pi's bare camelCase `usage` (input+output sum to 5 to match the matrix below).
const piOk = [
  JSON.stringify({ type: 'session', id: 'sess-pi-1' }),
  JSON.stringify({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5 },
      stopReason: 'end_turn',
    },
  }),
].join('\n');

function execFor(
  kind: 'claude' | 'codex' | 'droid' | 'pi',
  scenario: string,
): (args: string[], input: { prompt: string }) => Promise<CommonExecResult> {
  const ok = kind === 'claude' ? claudeOk : kind === 'codex' ? codexOk : kind === 'droid' ? droidOk : piOk;
  return async () => {
    switch (scenario) {
      case 'success':
        return { stdout: ok, stderr: '', code: 0 };
      case 'nonzero':
        return { stdout: ok, stderr: 'boom', code: 1 };
      case 'garbage':
        return { stdout: 'not json <<<', stderr: '', code: 0 };
      case 'timeout':
        return { stdout: '', stderr: '', code: 0, timedOut: true };
      case 'throw':
        throw new Error('spawn failed');
      default:
        return { stdout: '', stderr: '', code: 0 };
    }
  };
}

const adapters: Array<{ name: string; make: (scenario: string) => HarnessAdapter }> = [
  { name: 'claude-code', make: (s) => new ClaudeCodeAdapter({ exec: execFor('claude', s) }) },
  { name: 'codex', make: (s) => new CodexAdapter({ exec: execFor('codex', s) }) },
  { name: 'droid', make: (s) => new DroidAdapter({ exec: execFor('droid', s) }) },
  { name: 'pi', make: (s) => new PiAdapter({ exec: execFor('pi', s) }) },
];

const scenarios = ['success', 'nonzero', 'garbage', 'timeout', 'throw'];

describe('HarnessAdapter contract', () => {
  for (const adapter of adapters) {
    for (const scenario of scenarios) {
      it(`${adapter.name} / ${scenario}: never throws; returns a valid HarnessRunResult`, async () => {
        const result = await adapter.make(scenario).run('do the thing');
        expect(() => HarnessRunResult.parse(result)).not.toThrow();
        expect(SessionId.safeParse(result.sessionId).success).toBe(true);
        expect(['completed', 'crashed', 'truncated', 'timeout']).toContain(result.status);
      });
    }

    it(`${adapter.name}: a clean run maps to 'completed' with a session id and tokens`, async () => {
      const result = await adapter.make('success').run('go');
      expect(result.status).toBe('completed');
      expect(result.tokensUsed).toBe(5);
    });

    it(`${adapter.name}: a timed-out run maps to 'timeout'`, async () => {
      const result = await adapter.make('timeout').run('go');
      expect(result.status).toBe('timeout');
    });
  }
});
