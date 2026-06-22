import { describe, it, expect } from 'vitest';
import {
  freezePlan,
  canonicalPlanString,
  phaseConfig,
  isAcceptancePhase,
  totalPhases,
  Plan,
} from './plan';
import { makeConfig } from '../testing/fakes';

describe('freezePlan / canonicalPlanString', () => {
  it('hashes the plan deterministically and parses through the schema', () => {
    const a = freezePlan({ phases: [{ goal: 'p1' }, { goal: 'p2', intent: 'i', rubric: 'r' }] });
    const b = freezePlan({ phases: [{ goal: 'p1' }, { goal: 'p2', intent: 'i', rubric: 'r' }] });
    expect(a.planHash).toBe(b.planHash);
    expect(Plan.safeParse(a).success).toBe(true);
  });

  it('order is significant — reordered phases hash differently', () => {
    const a = freezePlan({ phases: [{ goal: 'p1' }, { goal: 'p2' }] });
    const b = freezePlan({ phases: [{ goal: 'p2' }, { goal: 'p1' }] });
    expect(a.planHash).not.toBe(b.planHash);
  });

  it('canonical string is stable regardless of optional-key presence ordering', () => {
    expect(canonicalPlanString({ phases: [{ goal: 'g' }] })).toBe(
      canonicalPlanString({ phases: [{ goal: 'g', intent: undefined, rubric: undefined }] }),
    );
  });
});

describe('phaseConfig', () => {
  const base = makeConfig({
    goal: 'the whole thing',
    verifier: { kind: 'existing', ref: 'npm test' },
    rubric: 'base rubric',
    phased: true,
    maxIterations: 7,
  });
  const plan = freezePlan({
    phases: [{ goal: 'sub one', intent: 'add a parser' }, { goal: 'sub two', rubric: 'sub rubric' }],
  });

  it('scopes a sub-goal phase to its goal with a generate verifier + its own intent/rubric', () => {
    const c0 = phaseConfig(base, plan, 0);
    expect(c0.goal).toBe('sub one');
    expect(c0.verifier).toEqual({ kind: 'generate', intent: 'add a parser' });
    // The base rubric is dropped when the sub-goal has none of its own.
    expect(c0.rubric).toBeUndefined();
    // Pure wiring (iteration budget etc.) is carried through unchanged.
    expect(c0.maxIterations).toBe(7);

    const c1 = phaseConfig(base, plan, 1);
    expect(c1.goal).toBe('sub two');
    expect(c1.verifier).toEqual({ kind: 'generate' });
    expect(c1.rubric).toBe('sub rubric');
  });

  it('the acceptance phase (index past the last sub-goal) is the ORIGINAL goal + verifier', () => {
    const accept = phaseConfig(base, plan, plan.phases.length);
    expect(accept.goal).toBe('the whole thing');
    expect(accept.verifier).toEqual({ kind: 'existing', ref: 'npm test' });
    expect(accept.rubric).toBe('base rubric');
    expect(isAcceptancePhase(plan, plan.phases.length)).toBe(true);
    expect(isAcceptancePhase(plan, 0)).toBe(false);
  });

  it('totalPhases counts the sub-goals plus the acceptance phase', () => {
    expect(totalPhases(plan)).toBe(3);
  });
});
