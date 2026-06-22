import { describe, it, expect } from 'vitest';
import { FakeLlm } from '../llm/provider';
import { PlanHash } from '../domain/ids';
import { makeConfig } from '../testing/fakes';
import { AgentPlanner } from './agent-planner';

describe('AgentPlanner', () => {
  it('authors an ordered, frozen plan from the LLM JSON (tolerating markdown fences)', async () => {
    const llm = new FakeLlm([
      '```json\n{ "phases": [ { "goal": "parser", "intent": "add a vitest" }, { "goal": "cli" } ] }\n```',
    ]);
    const planner = new AgentPlanner({ llm });

    const plan = await planner.plan(makeConfig({ goal: 'big', phased: true }));

    expect(plan.phases).toEqual([{ goal: 'parser', intent: 'add a vitest' }, { goal: 'cli' }]);
    expect(() => PlanHash.parse(plan.planHash)).not.toThrow();
  });

  it('is deterministic: the same sub-goals freeze to the same hash', async () => {
    const json = '{ "phases": [ { "goal": "a" }, { "goal": "b" } ] }';
    const p1 = await new AgentPlanner({ llm: new FakeLlm([json]) }).plan(makeConfig());
    const p2 = await new AgentPlanner({ llm: new FakeLlm([json]) }).plan(makeConfig());
    expect(p1.planHash).toBe(p2.planHash);
  });

  it('threads a revise note into the prompt', async () => {
    const llm = new FakeLlm(['{ "phases": [ { "goal": "x" } ] }']);
    await new AgentPlanner({ llm }).plan(makeConfig({ goal: 'g' }), 'split phase 2 in half');
    expect(llm.requests[0]?.prompt).toContain('split phase 2 in half');
  });

  it('fails closed on a response with no JSON object', async () => {
    const planner = new AgentPlanner({ llm: new FakeLlm(['sorry, I cannot help with that']) });
    await expect(planner.plan(makeConfig())).rejects.toThrow(/no JSON object/);
  });

  it('fails closed on an empty phase list (schema rejects min(1))', async () => {
    const planner = new AgentPlanner({ llm: new FakeLlm(['{ "phases": [] }']) });
    await expect(planner.plan(makeConfig())).rejects.toThrow();
  });

  it('refuses to freeze a plan that exceeds --max-phases (fail-closed)', async () => {
    const llm = new FakeLlm(['{ "phases": [ { "goal": "a" }, { "goal": "b" }, { "goal": "c" } ] }']);
    const planner = new AgentPlanner({ llm });
    await expect(planner.plan(makeConfig({ maxPhases: 2 }))).rejects.toThrow(/exceeding --max-phases/);
  });
});
