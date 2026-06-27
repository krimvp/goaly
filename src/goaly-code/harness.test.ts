import { describe, it, expect } from 'vitest';
import { GoalyCodeHarness } from './harness';
import { InMemorySessionStore, type SessionStore } from './session-store';
import type { ToolHost } from './tools';
import type { ChatResult, LlmClient } from '../llm-client/openai-client';
import type { ChatRequest, ChatMessage } from '../llm-client/schema';
import { HarnessRunResult } from '../domain/events';
import { SessionId } from '../domain/ids';
import { recordingLogger } from '../testing/fakes';

class ScriptedLlmClient implements LlmClient {
  readonly name = 'scripted';
  readonly requests: ChatRequest[] = [];
  #i = 0;
  constructor(private readonly script: Array<ChatResult | Error>) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const next = this.script[Math.min(this.#i, this.script.length - 1)];
    this.#i += 1;
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('no scripted result');
    return next;
  }
}

class StubHost implements ToolHost {
  async readFile(): Promise<string> {
    return 'content';
  }
  async listDir(): Promise<string> {
    return 'a';
  }
  async grep(): Promise<string> {
    return 'm';
  }
  async writeFile(): Promise<string> {
    return 'wrote';
  }
  async editFile(): Promise<string> {
    return 'edited';
  }
  async runShell(): Promise<string> {
    return 'exit code: 0';
  }
}

const finishTurn = (summary: string, usage?: ChatResult['usage']): ChatResult => ({
  content: null,
  toolCalls: [{ id: 'c1', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ summary }) } }],
  finishReason: 'tool_calls',
  usage,
});

function makeHarness(script: Array<ChatResult | Error>, overrides: Record<string, unknown> = {}) {
  return new GoalyCodeHarness({
    client: new ScriptedLlmClient(script),
    model: 'm',
    host: new StubHost(),
    sessionStore: new InMemorySessionStore(),
    mintSessionId: () => 'sdk-fixed',
    ...overrides,
  });
}

const scenarios: Array<{ name: string; script: Array<ChatResult | Error> }> = [
  { name: 'finish', script: [finishTurn('done')] },
  { name: 'final-text', script: [{ content: 'answer', toolCalls: [], finishReason: 'stop', usage: undefined }] },
  { name: 'client-throws', script: [new Error('network down')] },
];

describe('GoalyCodeHarness contract (mirrors adapter.contract.test.ts: never throws)', () => {
  for (const s of scenarios) {
    it(`${s.name}: returns a valid HarnessRunResult, never throws`, async () => {
      const result = await makeHarness(s.script).run('do the thing');
      expect(() => HarnessRunResult.parse(result)).not.toThrow();
      expect(SessionId.safeParse(result.sessionId).success).toBe(true);
      expect(['completed', 'crashed', 'truncated', 'timeout']).toContain(result.status);
    });
  }

  it('maps a finish to completed with the summary as output', async () => {
    const r = await makeHarness([finishTurn('I changed X')]).run('go');
    expect(r.status).toBe('completed');
    expect(r.output).toBe('I changed X');
  });

  it('maps a client failure to crashed (feeds STUCK_HARNESS_CRASH)', async () => {
    const r = await makeHarness([new Error('500')]).run('go');
    expect(r.status).toBe('crashed');
  });

  it('times out when the per-run wall-clock budget is spent before the next turn', async () => {
    // Advancing clock: deadline = now()(=0) + 10; the first loop turn reads now()(=1000) ≥ 10 → timeout.
    let t = 0;
    const now = (): number => {
      const v = t;
      t += 1000;
      return v;
    };
    const r = await makeHarness([finishTurn('done')], { timeoutMs: 10, now }).run('go');
    expect(r.status).toBe('timeout');
  });
});

describe('GoalyCodeHarness sessions', () => {
  it('mints a goaly-code- session id when none is provided', async () => {
    const r = await new GoalyCodeHarness({
      client: new ScriptedLlmClient([finishTurn('done')]),
      model: 'm',
      host: new StubHost(),
      sessionStore: new InMemorySessionStore(),
    }).run('go');
    expect(r.sessionId).toMatch(/^goaly-code-/);
  });

  it('persists then resumes a session — the second run appends to the prior history', async () => {
    const store = new InMemorySessionStore();
    const client = new ScriptedLlmClient([finishTurn('done')]);
    const harness = new GoalyCodeHarness({ client, model: 'm', host: new StubHost(), sessionStore: store, mintSessionId: () => 'sdk-1' });
    const r1 = await harness.run('first goal');
    const r2 = await harness.run('second goal', r1.sessionId);
    expect(r2.sessionId).toBe(r1.sessionId);
    const saved = (await store.load(SessionId.parse('sdk-1')))!;
    const userMsgs = saved.filter((m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user').map((m) => m.content);
    expect(userMsgs).toEqual(['first goal', 'second goal']);
    // only ONE system message — the resume did not re-seed the system prompt
    expect(saved.filter((m) => m.role === 'system')).toHaveLength(1);
  });

  it('degrades to a fresh session (logged loudly) when the resumed id is unknown', async () => {
    const { logger, records } = recordingLogger();
    const client = new ScriptedLlmClient([finishTurn('done')]);
    const harness = new GoalyCodeHarness({ client, model: 'm', host: new StubHost(), sessionStore: new InMemorySessionStore(), logger });
    await harness.run('go', SessionId.parse('sdk-never-saved'));
    // fresh history begins with the system prompt
    expect(client.requests[0]!.messages[0]!.role).toBe('system');
    expect(records.some((r) => r.level === 'warn' && /fresh session/.test(r.msg))).toBe(true);
  });

  it('a persist failure is logged but never fails the run', async () => {
    const failing: SessionStore = {
      load: async () => null,
      save: async () => {
        throw new Error('disk full');
      },
    };
    const { logger, records } = recordingLogger();
    const r = await makeHarness([finishTurn('done')], { sessionStore: failing, logger }).run('go');
    expect(r.status).toBe('completed');
    expect(records.some((rec) => rec.level === 'warn' && /persist failed/.test(rec.msg))).toBe(true);
  });

  it('passes reported token usage through to the run result', async () => {
    const r = await makeHarness([finishTurn('done', { total: 42, breakdown: { input: 30, output: 12 } })]).run('go');
    expect(r.tokensUsed).toBe(42);
    expect(r.tokenSource).toBe('reported');
    expect(r.tokenBreakdown).toEqual({ input: 30, output: 12 });
  });
});
