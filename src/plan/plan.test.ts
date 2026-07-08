import { describe, it, expect } from 'vitest';
import { AgentPlanner } from './agent-planner';
import { StaticPlanner } from './static-planner';
import { AutoPlanGate, HumanPlanGate } from './plan-gates';
import { FakeLlm } from '../llm/provider';
import { freezePlan, hashPlan } from '../util/hash';
import { canonicalPlanString, waveIndicesAt } from '../domain/plan';
import { makeConfig } from '../testing/fakes';

const config = makeConfig({ phased: true, goal: 'build a CLI', maxPhases: 5 });

describe('freezePlan / hashPlan (issue #48)', () => {
  it('is deterministic and order-sensitive (the plan IS ordered)', () => {
    const a = hashPlan({ phases: [{ goal: 'x' }, { goal: 'y' }] });
    const b = hashPlan({ phases: [{ goal: 'x' }, { goal: 'y' }] });
    const reordered = hashPlan({ phases: [{ goal: 'y' }, { goal: 'x' }] });
    expect(a).toBe(b);
    expect(a).not.toBe(reordered);
  });

  it('freezePlan parses + stamps a planHash matching hashPlan', () => {
    const frozen = freezePlan({ phases: [{ goal: 'only' }] });
    expect(frozen.planHash).toBe(hashPlan({ phases: [{ goal: 'only' }] }));
    expect(frozen.phases).toHaveLength(1);
  });

  it('a wave `group` is FROZEN into the hash, and groupless plans keep their legacy hash (back-compat)', () => {
    // Grouping is part of the frozen plan — re-shuffling it would be a different plan.
    const grouped = hashPlan({ phases: [{ goal: 'x', group: 1 }, { goal: 'y', group: 1 }] });
    const ungrouped = hashPlan({ phases: [{ goal: 'x' }, { goal: 'y' }] });
    const regrouped = hashPlan({ phases: [{ goal: 'x', group: 1 }, { goal: 'y', group: 2 }] });
    expect(grouped).not.toBe(ungrouped);
    expect(grouped).not.toBe(regrouped);
    // Back-compat: a plan WITHOUT groups canonicalizes exactly as before the field existed, so every
    // pre-existing run log's planHash still matches on replay.
    expect(canonicalPlanString({ phases: [{ goal: 'x' }] })).toBe(
      JSON.stringify({ phases: [{ goal: 'x', intent: null, rubric: null }] }),
    );
  });
});

describe('waveIndicesAt — consecutive same-group members (EXPERIMENTAL parallel waves)', () => {
  const plan = freezePlan({
    phases: [
      { goal: 'a', group: 1 },
      { goal: 'b', group: 1 },
      { goal: 'c' },
      { goal: 'd', group: 2 },
    ],
  });

  it('the group head fans out over its consecutive members', () => {
    expect(waveIndicesAt(plan, 0)).toEqual([0, 1]);
  });

  it('a MID-group index never fans out (a sequential fallback walks members one at a time)', () => {
    expect(waveIndicesAt(plan, 1)).toEqual([1]);
  });

  it('an ungrouped phase and a singleton group are singletons', () => {
    expect(waveIndicesAt(plan, 2)).toEqual([2]);
    expect(waveIndicesAt(plan, 3)).toEqual([3]);
  });

  it('an out-of-range index is a singleton (the acceptance phase)', () => {
    expect(waveIndicesAt(plan, 4)).toEqual([4]);
  });
});

describe('AgentPlanner — LLM-authored plan (issue #48)', () => {
  it('parses the JSON the LLM emits into a frozen, ordered plan', async () => {
    const llm = new FakeLlm([
      '{"phases":[{"goal":"scaffold"},{"goal":"add parser","intent":"unit test it"}]}',
    ]);
    const planner = new AgentPlanner({ llm });
    const plan = await planner.plan(config);
    expect(plan.phases.map((p) => p.goal)).toEqual(['scaffold', 'add parser']);
    expect(plan.phases[1]!.intent).toBe('unit test it');
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('tolerates prose / markdown fences around the JSON', async () => {
    const llm = new FakeLlm(['Here is the plan:\n```json\n{"phases":[{"goal":"a"}]}\n```\nDone.']);
    const plan = await new AgentPlanner({ llm }).plan(config);
    expect(plan.phases).toHaveLength(1);
  });

  it('throws (→ PLAN_FAILED) on no JSON', async () => {
    const planner = new AgentPlanner({ llm: new FakeLlm(['sorry, I cannot help']) });
    await expect(planner.plan(config)).rejects.toThrow(/no JSON object/);
  });

  it('throws fail-closed on an empty phases array (a plan must have ≥1 phase)', async () => {
    const planner = new AgentPlanner({ llm: new FakeLlm(['{"phases":[]}']) });
    await expect(planner.plan(config)).rejects.toThrow();
  });

  it('threads plan-Seal revise feedback into the authoring prompt', async () => {
    const llm = new FakeLlm(['{"phases":[{"goal":"a"}]}']);
    await new AgentPlanner({ llm }).plan(config, 'make phase 1 smaller');
    expect(llm.requests[0]!.prompt).toContain('make phase 1 smaller');
  });
});

describe('StaticPlanner — --plan-file (issue #48)', () => {
  it('reads + freezes a structured plan file', async () => {
    const read = async () => JSON.stringify({ phases: [{ goal: 'one' }, { goal: 'two' }] });
    const plan = await new StaticPlanner({ path: 'plan.json', read }).plan(config);
    expect(plan.phases.map((p) => p.goal)).toEqual(['one', 'two']);
  });

  it('fails closed on invalid JSON', async () => {
    const planner = new StaticPlanner({ path: 'p.json', read: async () => 'not json {' });
    await expect(planner.plan(config)).rejects.toThrow(/not valid JSON/);
  });

  it('fails closed on a bad shape (no phases)', async () => {
    const planner = new StaticPlanner({ path: 'p.json', read: async () => '{"phases":[]}' });
    await expect(planner.plan(config)).rejects.toThrow();
  });

  it('fails closed on an unreadable file', async () => {
    const planner = new StaticPlanner({
      path: 'missing.json',
      read: async () => {
        throw new Error('ENOENT');
      },
    });
    await expect(planner.plan(config)).rejects.toThrow(/could not read --plan-file/);
  });
});

describe('plan Seal gates (issue #48)', () => {
  const plan = freezePlan({ phases: [{ goal: 'a' }, { goal: 'b' }] });

  it('AutoPlanGate approves and logs the frozen plan loudly (--autonomous)', async () => {
    const logs: string[] = [];
    const decision = await new AutoPlanGate({ log: (m) => logs.push(m) }).approvePlan(plan);
    expect(decision).toEqual({ kind: 'approve' });
    expect(logs.join('\n')).toContain(plan.planHash);
  });

  it('HumanPlanGate maps approve / reject / revise answers', async () => {
    const out: string[] = [];
    const approveGate = new HumanPlanGate({ out: (m) => out.push(m), ask: async () => 'a' });
    expect(await approveGate.approvePlan(plan)).toEqual({ kind: 'approve' });

    const answers = ['f', 'split phase 2'];
    let i = 0;
    const reviseGate = new HumanPlanGate({ out: () => {}, ask: async () => answers[i++]! });
    expect(await reviseGate.approvePlan(plan)).toEqual({ kind: 'revise', feedback: 'split phase 2' });

    const rejectGate = new HumanPlanGate({ out: () => {}, ask: async () => 'n' });
    expect((await rejectGate.approvePlan(plan)).kind).toBe('reject');
  });

  it('HumanPlanGate fails closed to reject on empty revise feedback', async () => {
    const answers = ['f', '   '];
    let i = 0;
    const gate = new HumanPlanGate({ out: () => {}, ask: async () => answers[i++]! });
    expect((await gate.approvePlan(plan)).kind).toBe('reject');
  });
});

describe('AgentPlanner — authoring session-resume (re-plan rounds)', () => {
  const config = makeConfig({ verifier: { kind: 'generate' }, phased: true });
  const planJson = (goal: string): string => JSON.stringify({ phases: [{ goal }] });

  it('resumes its own session on a feedback round with a delta prompt', async () => {
    const llm = new FakeLlm(
      [
        { text: planJson('one big phase'), sessionId: 'plan-sess-1' },
        { text: planJson('two smaller phases'), sessionId: 'plan-sess-2' },
      ],
      { supportsResume: true },
    );
    const planner = new AgentPlanner({ llm });

    await planner.plan(config);
    await planner.plan(config, 'split phase one');

    expect(llm.requests[0]?.resumeSessionId).toBeUndefined();
    expect(llm.requests[0]?.prompt).toContain('Goal:');
    expect(llm.requests[1]?.resumeSessionId).toBe('plan-sess-1');
    expect(llm.requests[1]?.prompt).toContain('split phase one');
    expect(llm.requests[1]?.prompt).not.toContain('Goal:');
  });

  it('sends the full prompt on a feedback round when the provider cannot resume', async () => {
    const llm = new FakeLlm([planJson('a'), planJson('b')]);
    const planner = new AgentPlanner({ llm });

    await planner.plan(config);
    await planner.plan(config, 'revise it');

    expect(llm.requests[1]?.resumeSessionId).toBeUndefined();
    expect(llm.requests[1]?.prompt).toContain('Goal:');
    expect(llm.requests[1]?.prompt).toContain('revise it');
  });
});
