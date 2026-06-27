import { describe, it, expect } from 'vitest';
import { runAgentLoop } from './loop';
import { DEFAULT_TOOLS, type ToolHost } from './tools';
import type { ChatResult, LlmClient } from '../llm-client/openai-client';
import type { ChatRequest } from '../llm-client/schema';
import type { AgentStreamEvent } from '../agent-cli/stream';

/** A scripted client: returns the next ChatResult per call (repeats the last), or throws. */
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

const text = (content: string | null, usage?: ChatResult['usage']): ChatResult => ({
  content,
  toolCalls: [],
  finishReason: 'stop',
  usage,
});
const call = (name: string, args: string, id = 'c1') => ({
  id,
  type: 'function' as const,
  function: { name, arguments: args },
});
const toolTurn = (calls: ReturnType<typeof call>[], usage?: ChatResult['usage']): ChatResult => ({
  content: null,
  toolCalls: calls,
  finishReason: 'tool_calls',
  usage,
});

/** A host that records calls and returns canned strings. */
class RecordingHost implements ToolHost {
  readonly calls: Array<{ tool: string; args: unknown[] }> = [];
  async readFile(p: string, range?: unknown): Promise<string> {
    this.calls.push({ tool: 'readFile', args: [p, range] });
    return 'file contents';
  }
  async listDir(p: string): Promise<string> {
    this.calls.push({ tool: 'listDir', args: [p] });
    return 'a\nb';
  }
  async grep(pattern: string, p: string | undefined): Promise<string> {
    this.calls.push({ tool: 'grep', args: [pattern, p] });
    return 'match';
  }
  async writeFile(p: string, content: string): Promise<string> {
    this.calls.push({ tool: 'writeFile', args: [p, content] });
    return 'wrote';
  }
  async editFile(p: string, o: string, n: string): Promise<string> {
    this.calls.push({ tool: 'editFile', args: [p, o, n] });
    return 'edited';
  }
  async runShell(command: string): Promise<string> {
    this.calls.push({ tool: 'runShell', args: [command] });
    return 'exit code: 0';
  }
}

function base(client: LlmClient, host: ToolHost = new RecordingHost(), overrides = {}) {
  return { client, model: 'm', tools: DEFAULT_TOOLS, host, messages: [{ role: 'user' as const, content: 'go' }], maxTurns: 10, ...overrides };
}

describe('runAgentLoop', () => {
  it('converges: dispatches tools then completes on finish', async () => {
    const host = new RecordingHost();
    const client = new ScriptedLlmClient([
      toolTurn([call('read_file', '{"path":"x.ts"}')]),
      toolTurn([call('finish', '{"summary":"all done"}')]),
    ]);
    const r = await runAgentLoop(base(client, host));
    expect(r.status).toBe('completed');
    expect(r.output).toBe('all done');
    expect(host.calls[0]).toEqual({ tool: 'readFile', args: ['x.ts', undefined] });
    // history: user, assistant(tool), tool, assistant(finish), tool(finish)
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
  });

  it('completes on a final text answer with no tool calls', async () => {
    const client = new ScriptedLlmClient([text('here is the answer')]);
    const r = await runAgentLoop(base(client));
    expect(r.status).toBe('completed');
    expect(r.output).toBe('here is the answer');
  });

  it('truncates when the turn cap is hit without finishing', async () => {
    const host = new RecordingHost();
    const client = new ScriptedLlmClient([toolTurn([call('read_file', '{"path":"x"}')])]);
    const r = await runAgentLoop(base(client, host, { maxTurns: 2 }));
    expect(r.status).toBe('truncated');
    expect(host.calls).toHaveLength(2); // one read per turn
  });

  it('crashes (typed, never throws) when the client throws', async () => {
    const client = new ScriptedLlmClient([new Error('502 bad gateway')]);
    const r = await runAgentLoop(base(client));
    expect(r.status).toBe('crashed');
    expect(r.output).toMatch(/502/);
  });

  it('times out when the deadline is already past', async () => {
    const client = new ScriptedLlmClient([text('never reached')]);
    const r = await runAgentLoop(base(client, new RecordingHost(), { now: () => 1000, deadlineMs: 500 }));
    expect(r.status).toBe('timeout');
    expect(client.requests).toHaveLength(0); // never called the model
  });

  it('feeds a tool failure back as a result string and recovers', async () => {
    const client = new ScriptedLlmClient([
      toolTurn([call('does_not_exist', '{}')]),
      text('recovered'),
    ]);
    const r = await runAgentLoop(base(client));
    expect(r.status).toBe('completed');
    const toolMsg = r.messages.find((m) => m.role === 'tool');
    expect(toolMsg && 'content' in toolMsg && toolMsg.content).toMatch(/unknown tool/);
  });

  it('feeds invalid JSON arguments back as a result string', async () => {
    const client = new ScriptedLlmClient([toolTurn([call('read_file', '{not json')]), text('ok')]);
    const r = await runAgentLoop(base(client));
    const toolMsg = r.messages.find((m) => m.role === 'tool');
    expect(toolMsg && 'content' in toolMsg && toolMsg.content).toMatch(/not valid JSON/);
  });

  it('sums reported usage across turns (reported source + breakdown)', async () => {
    const client = new ScriptedLlmClient([
      toolTurn([call('read_file', '{"path":"x"}')], { total: 10, breakdown: { input: 6, output: 4 } }),
      text('done', { total: 5, breakdown: { input: 3, output: 2 } }),
    ]);
    const r = await runAgentLoop(base(client));
    expect(r.tokens).toEqual({ tokensUsed: 15, tokenSource: 'reported', tokenBreakdown: { input: 9, output: 6 } });
  });

  it('falls back to an estimate when no usage is reported and a sink is attached', async () => {
    const client = new ScriptedLlmClient([text('some streamed words to estimate from')]);
    const events: AgentStreamEvent[] = [];
    const r = await runAgentLoop(base(client, new RecordingHost(), { onEvent: (e: AgentStreamEvent) => events.push(e) }));
    expect(r.tokens.tokenSource).toBe('estimated');
    expect(r.tokens.tokensUsed).toBeGreaterThan(0);
    expect(events.some((e) => e.kind === 'message')).toBe(true);
    expect(events.some((e) => e.kind === 'done')).toBe(true);
  });

  it('leaves tokens unknown when nothing is reported and nothing streamed', async () => {
    const client = new ScriptedLlmClient([text('done')]);
    const r = await runAgentLoop(base(client));
    expect(r.tokens.tokensUsed).toBeUndefined();
  });

  it('a throwing event sink never crashes the loop (fail-closed observability)', async () => {
    const client = new ScriptedLlmClient([text('done')]);
    const r = await runAgentLoop(base(client, new RecordingHost(), {
      onEvent: () => {
        throw new Error('sink boom');
      },
    }));
    expect(r.status).toBe('completed');
  });

  it('advertises all default tools to the model', async () => {
    const client = new ScriptedLlmClient([text('done')]);
    await runAgentLoop(base(client));
    const names = (client.requests[0]!.tools ?? []).map((t) => t.function.name);
    expect(names).toEqual(['read_file', 'list_dir', 'grep', 'write_file', 'edit_file', 'run_shell', 'finish']);
  });
});
