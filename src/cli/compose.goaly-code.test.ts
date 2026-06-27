import { describe, it, expect } from 'vitest';
import { composeDeps, EndpointConfigError } from './compose';
import { makeConfig, InMemoryLogFs } from '../testing/fakes';
import { asRunId } from '../domain/ids';
import type { ComposeOptions } from './compose';

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
