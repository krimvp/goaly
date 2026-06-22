import { describe, it, expect } from 'vitest';
import { makePlan } from '../testing/fakes';
import { AutoPlanGate, HumanPlanGate } from './plan-gates';

/** A scripted `ask` that returns the queued answers in order. */
function scriptedAsk(answers: string[]): { ask: (q: string) => Promise<string>; asked: string[] } {
  const asked: string[] = [];
  let i = 0;
  return { asked, ask: async (q) => (asked.push(q), answers[i++] ?? '') };
}

const plan = makePlan('phase one', { goal: 'phase two', intent: 'wire it', rubric: 'be clean' });

describe('AutoPlanGate', () => {
  it('approves and loudly logs the planHash + every phase', async () => {
    const logs: string[] = [];
    const decision = await new AutoPlanGate({ log: (m) => logs.push(m) }).approvePlan(plan);
    expect(decision).toEqual({ kind: 'approve' });
    expect(logs.join('\n')).toContain(plan.planHash);
    expect(logs.join('\n')).toContain('phase one');
    expect(logs.join('\n')).toContain('phase two');
  });
});

describe('HumanPlanGate', () => {
  it('approves on "a"', async () => {
    const { ask } = scriptedAsk(['a']);
    expect(await new HumanPlanGate({ ask, out: () => {} }).approvePlan(plan)).toEqual({
      kind: 'approve',
    });
  });

  it('collects free-text feedback on "f" → revise', async () => {
    const { ask } = scriptedAsk(['f', 'split phase two']);
    expect(await new HumanPlanGate({ ask, out: () => {} }).approvePlan(plan)).toEqual({
      kind: 'revise',
      feedback: 'split phase two',
    });
  });

  it('empty feedback fails closed to reject', async () => {
    const { ask } = scriptedAsk(['f', '   ']);
    const decision = await new HumanPlanGate({ ask, out: () => {} }).approvePlan(plan);
    expect(decision.kind).toBe('reject');
  });

  it('anything else rejects', async () => {
    const { ask } = scriptedAsk(['n']);
    const decision = await new HumanPlanGate({ ask, out: () => {} }).approvePlan(plan);
    expect(decision.kind).toBe('reject');
  });

  it('with allowRevise:false the prompt is the plain binary and "y" approves', async () => {
    const { ask, asked } = scriptedAsk(['y']);
    const decision = await new HumanPlanGate({ ask, out: () => {}, allowRevise: false }).approvePlan(
      plan,
    );
    expect(decision).toEqual({ kind: 'approve' });
    expect(asked[0]).toContain('[y/N]');
  });
});
