import { describe, it, expect } from 'vitest';
import { SeededCompiler, SeededPlanner, combineFeedback } from './seeded';
import { FakeCompiler, FakePlanner, makeConfig, makeFakeContract, makeFakePlan } from '../testing/fakes';

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
