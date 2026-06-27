import { describe, it, expect } from 'vitest';
import { OpenAiLlmProvider } from './openai-provider';
import type { ChatResult, LlmClient } from '../llm-client/openai-client';
import type { ChatRequest } from '../llm-client/schema';

/** A fake LlmClient that records requests and returns a scripted result. */
class FakeClient implements LlmClient {
  readonly name = 'fake';
  readonly requests: ChatRequest[] = [];
  constructor(private readonly result: ChatResult) {}
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    return this.result;
  }
}

const textResult = (content: string | null, usage?: ChatResult['usage']): ChatResult => ({
  content,
  toolCalls: [],
  finishReason: 'stop',
  ...(usage !== undefined ? { usage } : { usage: undefined }),
});

describe('OpenAiLlmProvider (read-only, Slice 0)', () => {
  it('sends a system+user exchange with no tools and temperature 0', async () => {
    const fake = new FakeClient(textResult('verdict'));
    const provider = new OpenAiLlmProvider({ client: fake, model: 'gpt-test' });
    await provider.complete({ system: 'you are a judge', prompt: 'grade this' });
    const req = fake.requests[0]!;
    expect(req.model).toBe('gpt-test');
    expect(req.temperature).toBe(0);
    expect(req.tools).toBeUndefined();
    expect(req.messages).toEqual([
      { role: 'system', content: 'you are a judge' },
      { role: 'user', content: 'grade this' },
    ]);
  });

  it('omits the system message when none is given', async () => {
    const fake = new FakeClient(textResult('ok'));
    await new OpenAiLlmProvider({ client: fake, model: 'm' }).complete({ prompt: 'just this' });
    expect(fake.requests[0]!.messages).toEqual([{ role: 'user', content: 'just this' }]);
  });

  it('maps reported usage onto tokensUsed + reported breakdown', async () => {
    const fake = new FakeClient(
      textResult('answer', { total: 15, breakdown: { input: 10, output: 5 } }),
    );
    const completion = await new OpenAiLlmProvider({ client: fake, model: 'm' }).complete({ prompt: 'q' });
    expect(completion).toEqual({
      text: 'answer',
      tokensUsed: 15,
      tokenSource: 'reported',
      tokenBreakdown: { input: 10, output: 5 },
    });
  });

  it('degrades to text-only when no usage is reported (never a silent zero)', async () => {
    const fake = new FakeClient(textResult('answer'));
    const completion = await new OpenAiLlmProvider({ client: fake, model: 'm' }).complete({ prompt: 'q' });
    expect(completion).toEqual({ text: 'answer' });
  });

  it('omits an all-empty breakdown', async () => {
    const fake = new FakeClient(textResult('answer', { total: 7, breakdown: {} }));
    const completion = await new OpenAiLlmProvider({ client: fake, model: 'm' }).complete({ prompt: 'q' });
    expect(completion).toEqual({ text: 'answer', tokensUsed: 7, tokenSource: 'reported' });
  });

  it('fails closed (throws) when the endpoint returns no text (invariant #4)', async () => {
    const fake = new FakeClient(textResult(null));
    await expect(
      new OpenAiLlmProvider({ client: fake, model: 'm' }).complete({ prompt: 'q' }),
    ).rejects.toThrow(/no text/);
  });

  it('fails closed on whitespace-only text', async () => {
    const fake = new FakeClient(textResult('   \n  '));
    await expect(
      new OpenAiLlmProvider({ client: fake, model: 'm' }).complete({ prompt: 'q' }),
    ).rejects.toThrow();
  });
});
