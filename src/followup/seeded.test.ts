import { describe, it, expect } from 'vitest';
import { SeededCompiler, SeededPlanner, combineFeedback } from './seeded';
import { FakeCompiler, FakePlanner, makeConfig, makeFakeContract, makeFakePlan } from '../testing/fakes';
import { AgentCompiler } from '../compile/agent-compiler';
import { AgentPlanner } from '../plan/agent-planner';
import { FakeLlm } from '../llm/provider';
import { UNTRUSTED_SYSTEM_CLAUSE } from '../verify/prompt-safety';

describe('combineFeedback', () => {
  it('uses the seed alone when no command feedback is present', () => {
    expect(combineFeedback('SEED', undefined)).toBe('SEED');
    expect(combineFeedback('SEED', '')).toBe('SEED');
  });
  it('prepends the seed to existing command feedback', () => {
    expect(combineFeedback('SEED', 'revise: tighten it')).toBe('SEED\n\nrevise: tighten it');
  });
});

describe('SeededCompiler', () => {
  it('threads the seed into the first compile (no command feedback)', async () => {
    const inner = new FakeCompiler(makeFakeContract());
    await new SeededCompiler(inner, 'SEED').compile(makeConfig());
    expect(inner.feedbacks).toEqual(['SEED']);
  });

  it('combines the seed with a Seal-revise / compile-retry feedback on later attempts', async () => {
    const inner = new FakeCompiler([makeFakeContract(), makeFakeContract()]);
    const seeded = new SeededCompiler(inner, 'SEED');
    await seeded.compile(makeConfig());
    await seeded.compile(makeConfig(), 'the path was wrong');
    expect(inner.feedbacks).toEqual(['SEED', 'SEED\n\nthe path was wrong']);
  });
});

describe('SeededPlanner', () => {
  it('threads the seed into the plan authoring feedback', async () => {
    const inner = new FakePlanner(makeFakePlan());
    await new SeededPlanner(inner, 'SEED').plan(makeConfig({ phased: true }));
    expect(inner.feedbacks).toEqual(['SEED']);
  });
});

/**
 * The seed carries worker-authored text under a random-nonce UNTRUSTED fence (`compactRun`). A
 * fence only works if the key reading it has been told the rule, so BOTH consumers of this
 * channel — the contract compiler and (under `--phased`) the planner — must restate it in their
 * system prompt, exactly like the judge / approver / adversarial rung do.
 */
describe('the keys that consume the follow-up seed restate the untrusted-fence rule', () => {
  it("the contract compiler's system prompt carries the clause", async () => {
    const llm = new FakeLlm([
      JSON.stringify({ command: 'npx --no-install vitest run t.test.ts', rubric: 'r' }),
    ]);
    await new SeededCompiler(new AgentCompiler({ llm }), 'SEED').compile(
      makeConfig({ verifier: { kind: 'generate', intent: undefined } }),
    );
    expect(llm.requests[0]?.system).toContain(UNTRUSTED_SYSTEM_CLAUSE);
  });

  it("the planner's system prompt carries the clause", async () => {
    const llm = new FakeLlm([JSON.stringify({ phases: [{ goal: 'do the first bit' }] })]);
    await new SeededPlanner(new AgentPlanner({ llm }), 'SEED').plan(makeConfig({ phased: true }));
    expect(llm.requests[0]?.system).toContain(UNTRUSTED_SYSTEM_CLAUSE);
  });
});
