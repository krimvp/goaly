import { describe, it, expect } from 'vitest';
import { CritiquedPlanner, PLAN_CRITIC_LENSES } from './critiqued-planner';
import { FakePlanner, makeFakePlan } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import { RunConfig } from '../domain/config';

const config = RunConfig.parse({
  goal: 'build the whole widget system',
  verifier: { kind: 'generate' },
  phased: true,
});

const pass = JSON.stringify({ verdict: 'pass', findings: [] });
const critical = (claim: string, fix?: string): string =>
  JSON.stringify({
    verdict: 'revise',
    findings: [{ severity: 'critical', claim, ...(fix !== undefined ? { fix } : {}) }],
  });

describe('CritiquedPlanner', () => {
  it('passes the plan through untouched (identical planHash) when no critic finds a critical issue', async () => {
    const plan = makeFakePlan();
    const inner = new FakePlanner(plan);
    const llm = new FakeLlm([pass]);
    const planner = new CritiquedPlanner({ inner, llm, critics: 2, rounds: 1 });

    const result = await planner.plan(config);

    expect(result.planHash).toBe(plan.planHash);
    expect(inner.feedbacks).toEqual([undefined]);
    expect(llm.requests).toHaveLength(2);
  });

  it('re-plans with the findings as feedback on a critical finding', async () => {
    const first = makeFakePlan({ phases: [{ goal: 'do everything at once' }] });
    const second = makeFakePlan({ phases: [{ goal: 'part one' }, { goal: 'part two' }] });
    const inner = new FakePlanner([first, second]);
    const llm = new FakeLlm([critical('phase 1 is unverifiable', 'split it'), pass, pass]);
    const planner = new CritiquedPlanner({ inner, llm, critics: 1, rounds: 2 });

    const result = await planner.plan(config);

    expect(result.planHash).toBe(second.planHash);
    expect(inner.feedbacks).toHaveLength(2);
    expect(inner.feedbacks[1]).toContain('phase 1 is unverifiable');
    expect(inner.feedbacks[1]).toContain('split it');
  });

  it('stops after `rounds` critique rounds and passes the last plan through (plan Seal still gates)', async () => {
    const inner = new FakePlanner(makeFakePlan());
    const llm = new FakeLlm([critical('still too coarse')]); // clamps: every critic finds it
    const planner = new CritiquedPlanner({ inner, llm, critics: 1, rounds: 2 });

    await planner.plan(config);

    expect(inner.feedbacks).toHaveLength(3); // 1 initial + 2 bounded re-plans, never a third
    expect(llm.requests).toHaveLength(2);
  });

  it('composes plan-Seal revise feedback with the panel findings', async () => {
    const inner = new FakePlanner(makeFakePlan());
    const llm = new FakeLlm([critical('missing migration phase'), pass]);
    const planner = new CritiquedPlanner({ inner, llm, critics: 1, rounds: 2 });

    await planner.plan(config, 'keep it under four phases');

    expect(inner.feedbacks[0]).toBe('keep it under four phases');
    expect(inner.feedbacks[1]).toContain('keep it under four phases');
    expect(inner.feedbacks[1]).toContain('missing migration phase');
  });

  it('passes through when the whole panel errors or returns garbage (advisory fail-open)', async () => {
    const plan = makeFakePlan();
    const inner = new FakePlanner(plan);
    const llm = new FakeLlm(['not json']);
    const planner = new CritiquedPlanner({ inner, llm, critics: 2, rounds: 1 });

    const result = await planner.plan(config);

    expect(result.planHash).toBe(plan.planHash);
    expect(inner.feedbacks).toHaveLength(1);
  });

  it('cycles the plan-critic lenses and shows the plan (with intent/rubric) in the prompt', async () => {
    const inner = new FakePlanner(
      makeFakePlan({ phases: [{ goal: 'parse the input', intent: 'add a vitest', rubric: 'parses all fixtures' }] }),
    );
    const llm = new FakeLlm([pass]);
    const planner = new CritiquedPlanner({ inner, llm, critics: 2, rounds: 1 });

    await planner.plan(config);

    expect(llm.requests[0]?.system).toContain(PLAN_CRITIC_LENSES[0]);
    expect(llm.requests[1]?.system).toContain(PLAN_CRITIC_LENSES[1]);
    const prompt = llm.requests[0]?.prompt ?? '';
    expect(prompt).toContain('build the whole widget system');
    expect(prompt).toContain('parse the input');
    expect(prompt).toContain('intent: add a vitest');
    expect(prompt).toContain('rubric: parses all fixtures');
  });
});
