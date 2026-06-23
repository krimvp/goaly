import { describe, it, expect } from 'vitest';
import { initial, step } from './step';
import type { OrchestratorState } from './state';
import type { OrchestratorEvent, BudgetSnapshot } from '../domain/events';
import { makeConfig, makeFakeContract, makeFakePlan, passVerdict, failVerdict, dh } from '../testing/fakes';

const budget: BudgetSnapshot = { exceeded: false };
const plan = makeFakePlan({ phases: [{ goal: 'phase one' }, { goal: 'phase two', intent: 'add a test' }] });
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

/** Drive a freshly-compiled phase contract through Seal → run → verify(pass) → sign-off(approve). */
function runPhaseToBothKeys(compiling: OrchestratorState): OrchestratorState {
  const [sealed] = step(compiling, { tag: 'CONTRACT_COMPILED', contract });
  const [running] = step(sealed, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
  const [verifying] = step(running, agentRan('0000000', '0000aaa'));
  const [awaitSignoff] = step(verifying, { tag: 'VERIFIED', verdict: passVerdict() });
  return step(awaitSignoff, { tag: 'SIGNOFF_DECIDED', approval: { veto: false } })[0];
}

describe('phased reducer (issue #48): PLAN → plan Seal → phase loop → ACCEPT', () => {
  it('initial() with --phased seeds PLANNING + a single COMPILE_PLAN command', () => {
    const config = makeConfig({ phased: true });
    const [state, commands] = initial(config);
    expect(state.tag).toBe('PLANNING');
    expect(commands).toEqual([{ tag: 'COMPILE_PLAN', config }]);
  });

  it('a classic run is unchanged: initial() seeds COMPILING (no plan)', () => {
    const [state] = initial(makeConfig());
    expect(state.tag).toBe('COMPILING');
  });

  it('PLAN_COMPILED → AWAIT_PLAN_SEAL + REQUEST_PLAN_SEAL', () => {
    const [s0] = initial(makeConfig({ phased: true }));
    const [s1, cmds] = step(s0, { tag: 'PLAN_COMPILED', plan });
    expect(s1.tag).toBe('AWAIT_PLAN_SEAL');
    expect(cmds[0]).toEqual({ tag: 'REQUEST_PLAN_SEAL', plan });
  });

  it('PLAN_FAILED → terminal FAILED (fail-closed, never a skipped decomposition)', () => {
    const [s0] = initial(makeConfig({ phased: true }));
    const [s1] = step(s0, { tag: 'PLAN_FAILED', reason: 'planner blew up' });
    expect(s1).toMatchObject({ tag: 'FAILED', reason: 'planner blew up' });
  });

  it('plan Seal approve → compiles phase 0 with a derived config (sub-goal + --generate)', () => {
    const [s0] = initial(makeConfig({ phased: true }));
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    const [s2, cmds] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } });
    expect(s2.tag).toBe('COMPILING');
    if (s2.tag === 'COMPILING') {
      expect(s2.config.goal).toBe('phase one');
      expect(s2.config.verifier.kind).toBe('generate');
      expect(s2.config.phased).toBe(false); // the inner phase run is a normal single-contract run
      expect(s2.phase).toMatchObject({ index: 0 });
    }
    expect(cmds[0]).toMatchObject({ tag: 'COMPILE_VERIFIER' });
  });

  it('plan Seal reject → ABORTED (the phase loop never starts)', () => {
    const [s0] = initial(makeConfig({ phased: true }));
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    const [s2] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'reject', reason: 'too big' } });
    expect(s2).toMatchObject({ tag: 'ABORTED', reason: 'too big' });
  });

  it('plan Seal revise re-plans with feedback, bounded by maxPlanRevisions', () => {
    const config = makeConfig({ phased: true, maxPlanRevisions: 1 });
    const [s0] = initial(config);
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    // Round 1: revise re-authors the plan, carrying the human's feedback.
    const [s2, cmds] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'revise', feedback: 'split phase 2' } });
    expect(s2).toMatchObject({ tag: 'PLANNING', reviseRound: 1 });
    expect(cmds[0]).toMatchObject({ tag: 'COMPILE_PLAN', feedback: 'split phase 2' });
    // Round 2: the revise budget is exhausted → ABORTED (terminates, never loops forever).
    const [s3] = step(s2, { tag: 'PLAN_COMPILED', plan });
    const [s4] = step(s3, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'revise', feedback: 'again' } });
    expect(s4.tag).toBe('ABORTED');
    if (s4.tag === 'ABORTED') expect(s4.reason).toContain('revision cap');
  });

  it('a sub-goal phase reaching both keys ADVANCES (checkpoint) instead of finishing the run', () => {
    const [s0] = initial(makeConfig({ phased: true }));
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    const [compiling] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } });
    const done = runPhaseToBothKeys(compiling);
    // NOT DONE — it advances via a between-phase checkpoint (issue #47).
    expect(done.tag).toBe('ADVANCING_PHASE');
    const [, cmds] = step(done, { tag: 'PHASE_ADVANCED', tree: dh('0000bbb')[0]! });
    void cmds;
  });

  it('PHASE_ADVANCED compiles the NEXT phase; the last sub-goal advances to the cumulative ACCEPTANCE phase', () => {
    const config = makeConfig({ phased: true, goal: 'THE ORIGINAL GOAL', verifier: { kind: 'existing', ref: 'npm test' } });
    const [s0] = initial(config);
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    let state = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } })[0];

    // Phase 0 (sub-goal 1) → advance → phase 1 compiles.
    state = runPhaseToBothKeys(state);
    expect(state.tag).toBe('ADVANCING_PHASE');
    state = step(state, { tag: 'PHASE_ADVANCED', tree: dh('0000b01')[0]! })[0];
    expect(state.tag).toBe('COMPILING');
    if (state.tag === 'COMPILING') expect(state.config.goal).toBe('phase two');

    // Phase 1 (last sub-goal) → advance → the ACCEPTANCE phase: ORIGINAL goal + ORIGINAL verifier.
    state = runPhaseToBothKeys(state);
    expect(state.tag).toBe('ADVANCING_PHASE');
    state = step(state, { tag: 'PHASE_ADVANCED', tree: dh('0000b02')[0]! })[0];
    expect(state.tag).toBe('COMPILING');
    if (state.tag === 'COMPILING') {
      expect(state.config.goal).toBe('THE ORIGINAL GOAL');
      expect(state.config.verifier).toEqual({ kind: 'existing', ref: 'npm test' });
      expect(state.phase).toMatchObject({ index: 2 }); // === plan.phases.length ⇒ acceptance
    }

    // The acceptance phase reaching both keys is the WHOLE-RUN DONE.
    state = runPhaseToBothKeys(state);
    expect(state.tag).toBe('DONE');
  });

  it('whole-run DONE requires acceptance: all phases pass but acceptance FAILS ⇒ run FAILED', () => {
    const config = makeConfig({ phased: true, maxIterations: 1 });
    const [s0] = initial(config);
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan: makeFakePlan({ phases: [{ goal: 'only phase' }] }) });
    let state = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } })[0];
    // The single sub-goal passes and advances to acceptance.
    state = runPhaseToBothKeys(state);
    state = step(state, { tag: 'PHASE_ADVANCED', tree: dh('0000b03')[0]! })[0];
    // Acceptance: compile + seal, run, but the ladder FAILS and the iteration cap (1) is hit → FAILED.
    const [sealed] = step(state, { tag: 'CONTRACT_COMPILED', contract });
    const [running] = step(sealed, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
    const [verifying] = step(running, agentRan('0000ccc', '0000ddd'));
    const [failed] = step(verifying, { tag: 'VERIFIED', verdict: failVerdict('integration broken') });
    expect(failed.tag).toBe('FAILED');
    if (failed.tag === 'FAILED') expect(failed.reason).toContain('acceptance phase');
  });

  it('a phase failure fails the WHOLE run, named by phase (no silent skip)', () => {
    const [s0] = initial(makeConfig({ phased: true, maxCompileRetries: 0 }));
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    const [compiling] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } });
    const [failed] = step(compiling, { tag: 'COMPILE_FAILED', reason: 'bad authoring' });
    expect(failed.tag).toBe('FAILED');
    if (failed.tag === 'FAILED') {
      expect(failed.reason).toContain('phase 1/2');
      expect(failed.reason).toContain('phase one');
      expect(failed.reason).toContain('bad authoring');
    }
  });

  it('the frozen plan is carried by reference and never rewritten across phases', () => {
    const [s0] = initial(makeConfig({ phased: true }));
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    let state = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } })[0];
    const hash = state.tag === 'COMPILING' ? state.phase?.plan.planHash : undefined;
    expect(hash).toBe(plan.planHash);
    // Advance through every phase; the planHash the reducer carries must be byte-identical throughout.
    for (let i = 0; i < plan.phases.length; i += 1) {
      state = runPhaseToBothKeys(state);
      state = step(state, { tag: 'PHASE_ADVANCED', tree: dh(`0000e0${i}`)[0]! })[0];
      if (state.tag === 'COMPILING') expect(state.phase?.plan.planHash).toBe(plan.planHash);
    }
  });
});
