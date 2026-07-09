import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from './args';

const RUN = ['run', '--goal', 'g', '--verify-cmd', 'true'];

describe('parseArgs — goaly-code harness / OpenAI provider flags', () => {
  it('accepts --harness goaly-code', async () => {
    const a = await parseArgs([...RUN, '--harness', 'goaly-code']);
    expect(a.harness).toBe('goaly-code');
  });

  it('accepts --llm-provider openai', async () => {
    const a = await parseArgs([...RUN, '--llm-provider', 'openai']);
    expect(a.llmProvider).toBe('openai');
  });

  it('--harness goaly-code derives the openai LLM provider (the same endpoint backs the LLM steps)', async () => {
    const a = await parseArgs([...RUN, '--harness', 'goaly-code']);
    expect(a.llmProvider).toBe('openai');
    expect(a.llmProviderExplicit).toBe(false);
  });

  it('--harness goaly-code still honors an explicit --llm-provider', async () => {
    const a = await parseArgs([...RUN, '--harness', 'goaly-code', '--llm-provider', 'claude']);
    expect(a.llmProvider).toBe('claude');
  });

  it('parses --base-url', async () => {
    const a = await parseArgs([...RUN, '--base-url', 'https://api.openai.com/v1']);
    expect(a.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('defaults --llm-api-key-env to OPENAI_API_KEY and honors an override', async () => {
    const def = await parseArgs([...RUN]);
    expect(def.llmApiKeyEnv).toBe('OPENAI_API_KEY');
    const over = await parseArgs([...RUN, '--llm-api-key-env', 'TOGETHER_API_KEY']);
    expect(over.llmApiKeyEnv).toBe('TOGETHER_API_KEY');
  });

  it('still rejects an unknown harness / provider (sdk & openai are the only new members)', async () => {
    await expect(parseArgs([...RUN, '--harness', 'bogus'])).rejects.toBeInstanceOf(UsageError);
    await expect(parseArgs([...RUN, '--llm-provider', 'bogus'])).rejects.toBeInstanceOf(UsageError);
  });
});
