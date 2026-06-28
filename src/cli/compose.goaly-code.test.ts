import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeDeps, EndpointConfigError } from './compose';
import { makeConfig, InMemoryLogFs } from '../testing/fakes';
import { asRunId } from '../domain/ids';
import type { ComposeOptions } from './compose';
import type { FetchLike } from '../llm-client/openai-client';

const base = (over: Partial<ComposeOptions> = {}): ComposeOptions => ({
  harness: 'fake',
  workspaceRoot: '/tmp/x',
  runId: asRunId('run-sdk-1'),
  noLogConsole: true,
  logFs: new InMemoryLogFs(),
  ...over,
});

describe('composeDeps — goaly-code harness wiring', () => {
  it('builds a GoalyCodeHarness for --harness goaly-code with a base url + model', () => {
    const deps = composeDeps(
      makeConfig(),
      base({ harness: 'goaly-code', baseUrl: 'https://api.openai.com/v1', models: { model: 'gpt-x' } }),
    );
    expect(deps.harness.name).toBe('goaly-code');
  });

  it('fails closed when --harness goaly-code has no base url', () => {
    expect(() => composeDeps(makeConfig(), base({ harness: 'goaly-code', models: { model: 'gpt-x' } }))).toThrow(
      EndpointConfigError,
    );
  });

  it('fails closed when --harness goaly-code has no model', () => {
    expect(() =>
      composeDeps(makeConfig(), base({ harness: 'goaly-code', baseUrl: 'https://api.openai.com/v1' })),
    ).toThrow(EndpointConfigError);
  });
});

describe('composeDeps — goaly-code --max-agent-turns wiring (follow-on E)', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  // A fake endpoint that ALWAYS asks for a (non-terminal, unknown) tool call, so the loop never
  // finishes on its own — the ONLY thing that stops it is the turn cap → status `truncated`. Counts
  // its invocations so the test can assert the loop ran exactly `--max-agent-turns` model turns.
  const neverFinishing = (counter: { calls: number }): FetchLike => {
    const body = JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    return () => {
      counter.calls += 1;
      return Promise.resolve({ ok: true, status: 200, text: async () => body });
    };
  };

  it('threads goalyCodeMaxTurns into the goaly-code loop (a non-finishing run truncates at the cap)', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-maxturns-'));
    const counter = { calls: 0 };
    const deps = composeDeps(
      makeConfig(),
      base({
        harness: 'goaly-code',
        baseUrl: 'https://fake.endpoint/v1',
        llmFetch: neverFinishing(counter),
        models: { model: 'gpt-x' },
        workspaceRoot: dir,
        goalyCodeMaxTurns: 3,
      }),
    );
    const result = await deps.harness.run('do work');
    expect(result.status).toBe('truncated');
    expect(counter.calls).toBe(3); // capped at exactly --max-agent-turns model turns
  });

  it('falls back to the harness default (50) turns when --max-agent-turns is absent', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-maxturns-'));
    const counter = { calls: 0 };
    const deps = composeDeps(
      makeConfig(),
      base({
        harness: 'goaly-code',
        baseUrl: 'https://fake.endpoint/v1',
        llmFetch: neverFinishing(counter),
        models: { model: 'gpt-x' },
        workspaceRoot: dir,
        // no goalyCodeMaxTurns → DEFAULT_GOALY_CODE_MAX_TURNS (50)
      }),
    );
    const result = await deps.harness.run('do work');
    expect(result.status).toBe('truncated');
    expect(counter.calls).toBe(50);
  });
});

describe('composeDeps — OpenAI LLM provider wiring', () => {
  it('builds the LLM steps against an OpenAI endpoint (no network at construction)', () => {
    expect(() =>
      composeDeps(
        makeConfig(),
        base({ llmProvider: 'openai', baseUrl: 'https://api.openai.com/v1', models: { model: 'gpt-x' } }),
      ),
    ).not.toThrow();
  });

  it('fails closed when --llm-provider openai has no base url', () => {
    expect(() =>
      composeDeps(makeConfig(), base({ llmProvider: 'openai', models: { model: 'gpt-x' } })),
    ).toThrow(EndpointConfigError);
  });

  it('fails closed when --llm-provider openai has no resolved model', () => {
    expect(() =>
      composeDeps(makeConfig(), base({ llmProvider: 'openai', baseUrl: 'https://api.openai.com/v1' })),
    ).toThrow(EndpointConfigError);
  });
});
