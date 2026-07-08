import { describe, it, expect } from 'vitest';
import { initial, step } from './step';
import type { OrchestratorState } from './state';
import type { OrchestratorEvent, BudgetSnapshot } from '../domain/events';
import { makeConfig, makeFakeContract, makeFakePlan, passVerdict, dh } from '../testing/fakes';

const budget: BudgetSnapshot = { exceeded: false };
/** Phases 0+1 share wave group 1; phase 2 is sequential. */
const plan = makeFakePlan({
  phases: [
    { goal: 'wave member A', group: 1 },
    { goal: 'wave member B', group: 1 },
    { goal: 'sequential tail' },
  ],
});
const contract = makeFakeContract();

function agentRan(prev: string, post: string): OrchestratorEvent {
  const [p, q] = dh(prev, post);
  return {
    tag: 'AGENT_RAN',
    run: { output: '', sessionId: 'sess-1' as never, status: 'completed' },
    prevDiffHash: p!,
    diffHash: q!,
    budget,
  };
}

/** A phased+parallel run folded up to the plan-Seal approve (the wave decision point). */
function approvedPlan(parallel: boolean): readonly [OrchestratorState, readonly unknown[]] {
  const config = makeConfig({ phased: true, parallelPhases: parallel, autonomous: true });
  const [s0] = initial(config);
  const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
  return step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } });
}

/** Drive a compiling phase through Seal → run → verify(pass) → sign-off(approve). */
function runPhaseToBothKeys(compiling: OrchestratorState): OrchestratorState {
  const [sealed] = step(compiling, { tag: 'CONTRACT_COMPILED', contract });
  const [running] = step(sealed, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
  const [verifying] = step(running, agentRan('0000000', '0000aaa'));
  const [awaitSignoff] = step(verifying, { tag: 'VERIFIED', verdict: passVerdict() });
  return step(awaitSignoff, { tag: 'SIGNOFF_DECIDED', approval: { veto: false } })[0];
}

const waveTree = dh('00cafe0')[0]!;

describe('parallel waves reducer (EXPERIMENTAL --parallel-phases)', () => {
  it('plan approve fans a grouped prefix out as ONE RUN_WAVE with per-phase derived configs', () => {
    const [state, cmds] = approvedPlan(true);
    expect(state.tag).toBe('RUNNING_WAVE');
    if (state.tag === 'RUNNING_WAVE') expect(state.indices).toEqual([0, 1]);
    expect(cmds).toHaveLength(1); // driver invariant: exactly one command per state
    const cmd = cmds[0] as Extract<import('../domain/events').Command, { tag: 'RUN_WAVE' }>;
    expect(cmd.tag).toBe('RUN_WAVE');
    expect(cmd.phases.map((p) => p.index)).toEqual([0, 1]);
    expect(cmd.phases[0]!.config.goal).toBe('wave member A');
    expect(cmd.phases[1]!.config.goal).toBe('wave member B');
    // Each wave child is a normal single-contract, non-fanning run authored per sub-goal.
    for (const p of cmd.phases) {
      expect(p.config.verifier.kind).toBe('generate');
      expect(p.config.phased).toBe(false);
      expect(p.config.parallelPhases).toBe(false);
    }
  });

  it('the feature is OPT-IN: a grouped plan without --parallel-phases runs strictly sequentially', () => {
    const [state, cmds] = approvedPlan(false);
    expect(state.tag).toBe('COMPILING');
    if (state.tag === 'COMPILING') expect(state.config.goal).toBe('wave member A');
    expect(cmds[0]).toMatchObject({ tag: 'COMPILE_VERIFIER' });
  });

  it('all members merged → the machine advances PAST the group to the next phase', () => {
    const [wave] = approvedPlan(true);
    const [next, cmds] = step(wave, {
      tag: 'WAVE_RAN',
      outcomes: [
        { kind: 'merged', index: 0 },
        { kind: 'merged', index: 1 },
      ],
      tree: waveTree,
    });
    expect(next.tag).toBe('COMPILING');
    if (next.tag === 'COMPILING') {
      expect(next.config.goal).toBe('sequential tail');
      expect(next.phase).toMatchObject({ index: 2, skip: [0, 1] });
    }
    expect(cmds[0]).toMatchObject({ tag: 'COMPILE_VERIFIER' });
  });

  it('a partially-merged wave re-runs ONLY the unmerged member sequentially, then skips the merged one', () => {
    const [wave] = approvedPlan(true);
    const [fallback] = step(wave, {
      tag: 'WAVE_RAN',
      outcomes: [
        { kind: 'merged', index: 0 },
        { kind: 'unmerged', index: 1, reason: 'merge conflict: file.txt' },
      ],
      tree: waveTree,
    });
    // The unmerged member re-enters the CLASSIC sequential path (fresh compile, same sub-goal).
    expect(fallback.tag).toBe('COMPILING');
    if (fallback.tag === 'COMPILING') {
      expect(fallback.config.goal).toBe('wave member B');
      expect(fallback.phase).toMatchObject({ index: 1, skip: [0], waved: [0, 1] });
    }
    // When it completes both keys, the advance walks past the group to the tail — never back to 0.
    const advancing = runPhaseToBothKeys(fallback);
    expect(advancing.tag).toBe('ADVANCING_PHASE');
    const [tail] = step(advancing, { tag: 'PHASE_ADVANCED', tree: waveTree });
    expect(tail.tag).toBe('COMPILING');
    if (tail.tag === 'COMPILING') expect(tail.config.goal).toBe('sequential tail');
  });

  it('a fully-unmerged wave NEVER re-fans-out — every member downgrades to sequential', () => {
    const [wave] = approvedPlan(true);
    const [first] = step(wave, {
      tag: 'WAVE_RAN',
      outcomes: [
        { kind: 'unmerged', index: 0, reason: 'child run FAILED' },
        { kind: 'unmerged', index: 1, reason: 'child run FAILED' },
      ],
      tree: waveTree,
    });
    expect(first.tag).toBe('COMPILING'); // sequential, NOT another RUNNING_WAVE
    if (first.tag === 'COMPILING') expect(first.config.goal).toBe('wave member A');

    const advancing = runPhaseToBothKeys(first);
    const [second] = step(advancing, { tag: 'PHASE_ADVANCED', tree: waveTree });
    expect(second.tag).toBe('COMPILING'); // member B also sequential — the `waved` guard holds
    if (second.tag === 'COMPILING') expect(second.config.goal).toBe('wave member B');
  });

  it('a wave covering the LAST sub-goals advances into the cumulative ACCEPTANCE phase', () => {
    const twoPhase = makeFakePlan({
      phases: [
        { goal: 'wave member A', group: 7 },
        { goal: 'wave member B', group: 7 },
      ],
    });
    const config = makeConfig({ phased: true, parallelPhases: true, autonomous: true });
    const [s0] = initial(config);
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan: twoPhase });
    const [wave] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } });
    expect(wave.tag).toBe('RUNNING_WAVE');
    const [accept] = step(wave, {
      tag: 'WAVE_RAN',
      outcomes: [
        { kind: 'merged', index: 0 },
        { kind: 'merged', index: 1 },
      ],
      tree: waveTree,
    });
    expect(accept.tag).toBe('COMPILING');
    if (accept.tag === 'COMPILING') {
      // The acceptance phase is the ORIGINAL goal (decomposition can't green a broken whole).
      expect(accept.config.goal).toBe(config.goal);
      expect(accept.phase).toMatchObject({ index: 2 });
    }
  });

  it('ungrouped plans and the acceptance phase never fan out', () => {
    const linear = makeFakePlan({ phases: [{ goal: 'only phase' }] });
    const config = makeConfig({ phased: true, parallelPhases: true, autonomous: true });
    const [s0] = initial(config);
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan: linear });
    const [state] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } });
    expect(state.tag).toBe('COMPILING');
  });
});
