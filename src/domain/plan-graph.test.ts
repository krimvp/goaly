import { describe, it, expect } from 'vitest';
import { Plan, canonicalPlanString, waveIndicesAt, type SubGoal } from './plan';
import {
  describePlanGraphViolation,
  planDependencies,
  readyFrontier,
  validatePlanGraph,
} from './plan-graph';
import { freezePlan, hashPlan } from '../util/hash';

/**
 * The PRE-DAG scheduler, verbatim (goaly ≤ #122): consecutive phases sharing a `group` value form a
 * wave, a mid-band index never re-fans-out, everything else is a singleton. It is the ORACLE for the
 * back-compat proof below — the new topological scheduler must reproduce it exactly on every plan
 * expressible before `dependsOn` existed.
 */
function legacyWaveIndicesAt(
  phases: readonly SubGoal[],
  index: number,
): readonly number[] {
  const phase = phases[index];
  if (phase === undefined || phase.group === undefined) return [index];
  if (index > 0 && phases[index - 1]?.group === phase.group) return [index];
  const wave: number[] = [index];
  for (let i = index + 1; i < phases.length; i += 1) {
    if (phases[i]?.group !== phase.group) break;
    wave.push(i);
  }
  return wave;
}

describe('planDependencies — `group` is sugar that LOWERS to dependsOn (issue #123)', () => {
  it('a plain linear plan lowers to "each phase depends on everything before it"', () => {
    expect(planDependencies([{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }])).toEqual([
      [],
      [0],
      [0, 1],
    ]);
  });

  it('a contiguous group band lowers to "every member depends on everything BEFORE the band"', () => {
    const phases: readonly SubGoal[] = [
      { goal: 'a' },
      { goal: 'b', group: 1 },
      { goal: 'c', group: 1 },
      { goal: 'd' },
    ];
    expect(planDependencies(phases)).toEqual([[], [0], [0], [0, 1, 2]]);
  });

  it('non-contiguous same-group phases are NOT one band (adjacency was always the rule)', () => {
    const phases: readonly SubGoal[] = [
      { goal: 'a', group: 1 },
      { goal: 'b', group: 2 },
      { goal: 'c', group: 1 },
    ];
    expect(planDependencies(phases)).toEqual([[], [0], [0, 1]]);
  });

  it('explicit dependsOn wins over position: "C needs A and B, D needs only A"', () => {
    const phases: readonly SubGoal[] = [
      { goal: 'a', id: 'a', dependsOn: [] },
      { goal: 'b', id: 'b', dependsOn: [] },
      { goal: 'c', id: 'c', dependsOn: ['a', 'b'] },
      { goal: 'd', id: 'd', dependsOn: ['a'] },
    ];
    expect(planDependencies(phases)).toEqual([[], [], [0, 1], [0]]);
  });

  it('deduplicates + sorts declared edges, and MIXES with the positional default per phase', () => {
    const phases: readonly SubGoal[] = [
      { goal: 'a', id: 'a' },
      { goal: 'b', id: 'b', dependsOn: ['a', 'a'] },
      { goal: 'c' }, // no dependsOn ⇒ the conservative positional default (all previous)
    ];
    expect(planDependencies(phases)).toEqual([[], [0], [0, 1]]);
  });

  it('an UNRESOLVABLE id degrades to the conservative positional default (never runs too early)', () => {
    // Parsing rejects this plan; the total function must still never widen the frontier.
    const phases: readonly SubGoal[] = [
      { goal: 'a', id: 'a' },
      { goal: 'b', id: 'b', dependsOn: ['nope'] },
    ];
    expect(planDependencies(phases)).toEqual([[], [0]]);
  });
});

describe('readyFrontier — the PURE topological scheduler (issue #123)', () => {
  const diamond: readonly SubGoal[] = [
    { goal: 'a', id: 'a', dependsOn: [] },
    { goal: 'b', id: 'b', dependsOn: ['a'] },
    { goal: 'c', id: 'c', dependsOn: ['a'] },
    { goal: 'd', id: 'd', dependsOn: ['b', 'c'] },
  ];

  const table: ReadonlyArray<{
    name: string;
    phases: readonly SubGoal[];
    completed: readonly number[];
    frontier: readonly number[];
  }> = [
    { name: 'diamond: nothing done ⇒ only the root', phases: diamond, completed: [], frontier: [0] },
    { name: 'diamond: root done ⇒ both middles fan out', phases: diamond, completed: [0], frontier: [1, 2] },
    { name: 'diamond: one middle done ⇒ the other alone', phases: diamond, completed: [0, 1], frontier: [2] },
    { name: 'diamond: both middles done ⇒ the join', phases: diamond, completed: [0, 1, 2], frontier: [3] },
    { name: 'diamond: all done ⇒ empty (the plan is exhausted)', phases: diamond, completed: [0, 1, 2, 3], frontier: [] },
    {
      name: 'independent roots fan out together',
      phases: [
        { goal: 'a', id: 'a', dependsOn: [] },
        { goal: 'b', id: 'b', dependsOn: [] },
        { goal: 'c', id: 'c', dependsOn: ['a', 'b'] },
      ],
      completed: [],
      frontier: [0, 1],
    },
    {
      name: 'a linear plan is its own degenerate frontier',
      phases: [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }],
      completed: [0],
      frontier: [1],
    },
    {
      name: 'a group band is the frontier once its prefix is complete',
      phases: [{ goal: 'a' }, { goal: 'b', group: 1 }, { goal: 'c', group: 1 }],
      completed: [0],
      frontier: [1, 2],
    },
    {
      name: 'a completed phase is NEVER re-offered (resume repeats no phase)',
      phases: [{ goal: 'a' }, { goal: 'b', group: 1 }, { goal: 'c', group: 1 }],
      completed: [0, 1],
      frontier: [2],
    },
    {
      name: 'out-of-order completion still respects unmet dependencies',
      phases: diamond,
      completed: [0, 2],
      frontier: [1],
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      expect(readyFrontier({ phases: row.phases }, row.completed)).toEqual(row.frontier);
    });
  }

  it('is pure: it never mutates the plan or the completed set', () => {
    const completed = [0];
    const phases = [...diamond];
    readyFrontier({ phases }, completed);
    expect(completed).toEqual([0]);
    expect(phases).toEqual(diamond);
  });
});

describe('validatePlanGraph — FAIL-CLOSED typed violations (issue #123)', () => {
  it('accepts a well-formed DAG', () => {
    expect(
      validatePlanGraph([
        { goal: 'a', id: 'a' },
        { goal: 'b', id: 'b', dependsOn: ['a'] },
      ]),
    ).toBeUndefined();
  });

  it('rejects a duplicate id (ids must be plan-locally unique to be referenceable)', () => {
    const v = validatePlanGraph([
      { goal: 'a', id: 'dup' },
      { goal: 'b', id: 'dup' },
    ]);
    expect(v).toEqual({ kind: 'duplicate-id', index: 1, id: 'dup' });
  });

  it('rejects a self-reference', () => {
    const v = validatePlanGraph([{ goal: 'a', id: 'a', dependsOn: ['a'] }]);
    expect(v).toEqual({ kind: 'self-dependency', index: 0, id: 'a' });
  });

  it('rejects a dangling reference to an unknown id', () => {
    const v = validatePlanGraph([{ goal: 'a', id: 'a' }, { goal: 'b', dependsOn: ['ghost'] }]);
    expect(v).toEqual({ kind: 'unknown-dependency', index: 1, dependency: 'ghost' });
  });

  it('rejects a cycle (and names it) — never a silently linearized plan', () => {
    const v = validatePlanGraph([
      { goal: 'a', id: 'a', dependsOn: ['b'] },
      { goal: 'b', id: 'b', dependsOn: ['a'] },
    ]);
    expect(v?.kind).toBe('cycle');
    if (v?.kind === 'cycle') expect(v.cycle).toContain('a');
  });

  it('rejects a longer cycle spanning three phases', () => {
    const v = validatePlanGraph([
      { goal: 'a', id: 'a', dependsOn: ['c'] },
      { goal: 'b', id: 'b', dependsOn: ['a'] },
      { goal: 'c', id: 'c', dependsOn: ['b'] },
    ]);
    expect(v?.kind).toBe('cycle');
  });

  it('rejects a FORWARD edge — the phase list must be a topological order', () => {
    const v = validatePlanGraph([
      { goal: 'a', id: 'a', dependsOn: ['b'] },
      { goal: 'b', id: 'b', dependsOn: [] },
    ]);
    expect(v).toEqual({ kind: 'forward-dependency', index: 0, dependency: 'b' });
  });

  it('describes every violation kind in one actionable line', () => {
    const kinds = [
      { kind: 'duplicate-id', index: 1, id: 'x' },
      { kind: 'self-dependency', index: 0, id: 'x' },
      { kind: 'unknown-dependency', index: 1, dependency: 'ghost' },
      { kind: 'cycle', cycle: ['a', 'b', 'a'] },
      { kind: 'forward-dependency', index: 0, dependency: 'b' },
    ] as const;
    for (const v of kinds) {
      const text = describePlanGraphViolation(v);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('plan graph');
    }
  });
});

describe('the plan SEAM parses the graph fail-closed (invariant #6)', () => {
  const bad: ReadonlyArray<{ name: string; phases: readonly SubGoal[]; match: RegExp }> = [
    { name: 'a cycle', phases: [
      { goal: 'a', id: 'a', dependsOn: ['b'] },
      { goal: 'b', id: 'b', dependsOn: ['a'] },
    ], match: /cycle/ },
    { name: 'a dangling id', phases: [{ goal: 'a', dependsOn: ['ghost'] }], match: /unknown/ },
    { name: 'a self-reference', phases: [{ goal: 'a', id: 'a', dependsOn: ['a'] }], match: /itself/ },
    { name: 'a duplicate id', phases: [{ goal: 'a', id: 'x' }, { goal: 'b', id: 'x' }], match: /duplicate/ },
    { name: 'a forward edge', phases: [
      { goal: 'a', id: 'a', dependsOn: ['b'] },
      { goal: 'b', id: 'b', dependsOn: [] },
    ], match: /later phase/ },
  ];

  for (const row of bad) {
    it(`Plan.parse rejects ${row.name}`, () => {
      expect(() => Plan.parse({ phases: row.phases })).toThrow(row.match);
    });
    it(`freezePlan rejects ${row.name} (the freeze seam too)`, () => {
      expect(() => freezePlan({ phases: [...row.phases] })).toThrow(row.match);
    });
  }

  it('an empty id is rejected by the schema itself', () => {
    expect(() => Plan.parse({ phases: [{ goal: 'a', id: '' }] })).toThrow();
  });
});

describe('BACK-COMPAT: pre-existing frozen plans keep byte-identical semantics (issue #123)', () => {
  const legacyPlans: ReadonlyArray<readonly SubGoal[]> = [
    [{ goal: 'a' }],
    [{ goal: 'a' }, { goal: 'b' }, { goal: 'c' }],
    [{ goal: 'a', group: 1 }, { goal: 'b', group: 1 }, { goal: 'c' }],
    [{ goal: 'a' }, { goal: 'b', group: 2 }, { goal: 'c', group: 2 }, { goal: 'd', group: 3 }],
    [{ goal: 'a', group: 1 }, { goal: 'b', group: 2 }, { goal: 'c', group: 1 }],
    [{ goal: 'a', group: 5 }, { goal: 'b', group: 5 }, { goal: 'c', group: 5 }],
  ];

  it('the topological scheduler reproduces the legacy wave at EVERY index of EVERY legacy plan', () => {
    for (const phases of legacyPlans) {
      const plan = freezePlan({ phases: [...phases] });
      // +1 covers the cumulative ACCEPTANCE phase index (out of range ⇒ singleton).
      for (let i = 0; i <= phases.length; i += 1) {
        expect(waveIndicesAt(plan, i)).toEqual(legacyWaveIndicesAt(phases, i));
      }
    }
  });

  it('the canonical string (and therefore planHash) of a legacy plan is unchanged', () => {
    // Byte-identical to the pre-#123 canonicalization: goal, intent, rubric, then `group` only when set.
    expect(canonicalPlanString({ phases: [{ goal: 'x' }] })).toBe(
      JSON.stringify({ phases: [{ goal: 'x', intent: null, rubric: null }] }),
    );
    expect(canonicalPlanString({ phases: [{ goal: 'x', group: 1 }] })).toBe(
      JSON.stringify({ phases: [{ goal: 'x', intent: null, rubric: null, group: 1 }] }),
    );
  });

  it('id + dependsOn are FROZEN into planHash — no transition can re-shuffle the graph', () => {
    const base = hashPlan({ phases: [{ goal: 'x', id: 'a' }, { goal: 'y', id: 'b' }] });
    const withEdge = hashPlan({
      phases: [{ goal: 'x', id: 'a' }, { goal: 'y', id: 'b', dependsOn: ['a'] }],
    });
    const renamed = hashPlan({ phases: [{ goal: 'x', id: 'z' }, { goal: 'y', id: 'b' }] });
    const anonymous = hashPlan({ phases: [{ goal: 'x' }, { goal: 'y' }] });
    expect(new Set([base, withEdge, renamed, anonymous]).size).toBe(4);
  });

  it('dependency ORDER is not semantic: the same edge set canonicalizes identically', () => {
    const ab = hashPlan({
      phases: [
        { goal: 'x', id: 'a' },
        { goal: 'y', id: 'b' },
        { goal: 'z', id: 'c', dependsOn: ['a', 'b'] },
      ],
    });
    const ba = hashPlan({
      phases: [
        { goal: 'x', id: 'a' },
        { goal: 'y', id: 'b' },
        { goal: 'z', id: 'c', dependsOn: ['b', 'a', 'b'] },
      ],
    });
    expect(ab).toBe(ba);
  });
});
