import { describe, it, expect } from 'vitest';
import { FakeLlm, type LlmProvider, type LlmRequest, type LlmCompletion } from './provider';
import { runCriticPanel, CRITIC_DIVERSITY_TEMPERATURE } from './critic-panel';

const pass = JSON.stringify({ verdict: 'pass', findings: [] });
const revise = (claim: string): string =>
  JSON.stringify({ verdict: 'revise', findings: [{ severity: 'critical', claim }] });

const baseOpts = { system: 'BASE SYSTEM', prompt: 'critique this', lenses: [] as string[] };

describe('runCriticPanel', () => {
  it('runs count critics and returns their parsed outputs', async () => {
    const llm = new FakeLlm([pass, revise('vacuous command')]);
    const outputs = await runCriticPanel({ ...baseOpts, llm, count: 2 });
    expect(outputs).toHaveLength(2);
    expect(outputs[0]?.verdict).toBe('pass');
    expect(outputs[1]?.findings[0]?.claim).toBe('vacuous command');
  });

  it('appends lens i to critic i prompt (cycled), keeping the system panel-constant', async () => {
    const llm = new FakeLlm([pass]);
    await runCriticPanel({ ...baseOpts, llm, lenses: ['LENS_A', 'LENS_B'], count: 3 });
    expect(llm.requests[0]?.prompt).toContain('LENS_A');
    expect(llm.requests[1]?.prompt).toContain('LENS_B');
    expect(llm.requests[2]?.prompt).toContain('LENS_A');
    // Panel-constant system + shared prompt prefix: the cacheable-prefix invariant.
    for (const req of llm.requests) {
      expect(req.system).toBe('BASE SYSTEM');
      expect(req.prompt.startsWith('critique this')).toBe(true);
    }
  });

  it('leaves the prompt bare with no lenses', async () => {
    const llm = new FakeLlm([pass]);
    await runCriticPanel({ ...baseOpts, llm, count: 1 });
    expect(llm.requests[0]?.system).toBe('BASE SYSTEM');
    expect(llm.requests[0]?.prompt).toBe('critique this');
  });

  it('samples at temperature 0 for one critic and diversity temperature for a panel', async () => {
    const single = new FakeLlm([pass]);
    await runCriticPanel({ ...baseOpts, llm: single, count: 1 });
    expect(single.requests[0]?.temperature).toBe(0);

    const panel = new FakeLlm([pass]);
    await runCriticPanel({ ...baseOpts, llm: panel, count: 2 });
    expect(panel.requests[0]?.temperature).toBe(CRITIC_DIVERSITY_TEMPERATURE);
    expect(panel.requests[1]?.temperature).toBe(CRITIC_DIVERSITY_TEMPERATURE);
  });

  it('drops an unparseable critic and keeps the parseable siblings (advisory fail-open)', async () => {
    const llm = new FakeLlm(['no json at all', revise('real finding'), '{"verdict":"revise","findings":[]}']);
    const outputs = await runCriticPanel({ ...baseOpts, llm, count: 3 });
    // The bare prose critic and the incoherent revise-with-no-findings critic are both dropped.
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.findings[0]?.claim).toBe('real finding');
  });

  it('drops a throwing critic and keeps the siblings', async () => {
    class ThrowFirst implements LlmProvider {
      readonly name = 'throw-first';
      #i = 0;
      async complete(_req: LlmRequest): Promise<LlmCompletion> {
        this.#i += 1;
        if (this.#i === 1) throw new Error('llm down');
        return { text: pass };
      }
    }
    const outputs = await runCriticPanel({ ...baseOpts, llm: new ThrowFirst(), count: 2 });
    expect(outputs).toHaveLength(1);
  });

  it('returns [] without calling the llm when count is 0', async () => {
    const llm = new FakeLlm([pass]);
    const outputs = await runCriticPanel({ ...baseOpts, llm, count: 0 });
    expect(outputs).toEqual([]);
    expect(llm.requests).toHaveLength(0);
  });

  it('tolerates prose/fences around the JSON', async () => {
    const llm = new FakeLlm(['Here is my critique:\n```json\n' + revise('gamed bar') + '\n```']);
    const outputs = await runCriticPanel({ ...baseOpts, llm, count: 1 });
    expect(outputs[0]?.findings[0]?.claim).toBe('gamed bar');
  });
});
