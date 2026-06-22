import { describe, it, expect } from 'vitest';
import { initial, step } from './step';
import type { OrchestratorState } from './state';
import type { OrchestratorEvent, Command, BudgetSnapshot } from '../domain/events';
import { freezePlan, type Plan } from '../domain/plan';
import { makeFakeContract, makeConfig, passVerdict, approve, dh } from '../testing/fakes';

const phasedConfig = makeConfig({ goal: 'big goal', phased: true, maxGateARevisions: 2 });
const plan: Plan = freezePlan({ phases: [{ goal: 'phase one' }, { goal: 'phase two' }] });
const budget: BudgetSnapshot = { exceeded: false };

/** A frozen contract whose hash differs per phase (so we can prove the right one is carried). */
const contractFor = (goal: string) => makeFakeContract({ goal });

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

/**
 * Drive a single phase from COMPILING through to its both-keys Gate-B decision, returning the
 * resulting state AND the commands that decision emitted (e.g. CHECKPOINT_PHASE for a sub-goal phase).
 */
function runPhaseToDecision(
  start: OrchestratorState,
  goal: string,
): readonly [OrchestratorState, Command[]] {
  const contract = contractFor(goal);
  let s = step(start, { tag: 'CONTRACT_COMPILED', contract })[0];
  s = step(s, { tag: 'GATE_A_DECIDED', decision: { kind: 'approve' } })[0];
  s = step(s, agentRan('0000000', '0000001'))[0];
  s = step(s, { tag: 'VERIFIED', verdict: passVerdict() })[0];
  return step(s, { tag: 'GATE_B_DECIDED', approval: approve() });
}

describe('phased reducer — PLAN → plan gate → phases → ACCEPT', () => {
  it('initial(phased) seeds PLANNING + a single PLAN command', () => {
    const [state, cmds] = initial(phasedConfig);
    expect(state.tag).toBe('PLANNING');
    expect(cmds).toEqual([{ tag: 'PLAN', config: phasedConfig }]);
  });

  it('a non-phased config still seeds COMPILING (behavior unchanged)', () => {
    const [state] = initial(makeConfig());
    expect(state.tag).toBe('COMPILING');
  });

  it('PLAN_COMPILED → AWAIT_PLAN_GATE + REQUEST_PLAN_GATE', () => {
    const [s0] = initial(phasedConfig);
    const [s1, cmds] = step(s0, { tag: 'PLAN_COMPILED', plan });
    expect(s1.tag).toBe('AWAIT_PLAN_GATE');
    expect(cmds[0]).toEqual({ tag: 'REQUEST_PLAN_GATE', plan });
  });

  it('PLAN_FAILED → FAILED (fail-closed, no contract frozen)', () => {
    const [s0] = initial(phasedConfig);
    const [s1] = step(s0, { tag: 'PLAN_FAILED', reason: 'unparseable plan' });
    expect(s1).toMatchObject({ tag: 'FAILED', reason: 'unparseable plan', contractHash: undefined });
  });

  it('plan gate approve → COMPILING phase 0, scoped to the first sub-goal (generate verifier)', () => {
    const s1 = step(initial(phasedConfig)[0], { tag: 'PLAN_COMPILED', plan })[0];
    const [s2, cmds] = step(s1, { tag: 'PLAN_GATE_DECIDED', decision: { kind: 'approve' } });
    expect(s2.tag).toBe('COMPILING');
    if (s2.tag === 'COMPILING') {
      expect(s2.config.goal).toBe('phase one');
      expect(s2.config.verifier).toEqual({ kind: 'generate' });
      expect(s2.plan).toMatchObject({ phaseIndex: 0, priorIterations: 0 });
      expect(s2.plan?.plan.planHash).toBe(plan.planHash);
    }
    expect(cmds[0]).toMatchObject({ tag: 'COMPILE_VERIFIER' });
  });

  it('plan gate reject → ABORTED before any phase runs', () => {
    const s1 = step(initial(phasedConfig)[0], { tag: 'PLAN_COMPILED', plan })[0];
    const [s2] = step(s1, {
      tag: 'PLAN_GATE_DECIDED',
      decision: { kind: 'reject', reason: 'bad decomposition' },
    });
    expect(s2).toMatchObject({ tag: 'ABORTED', reason: 'bad decomposition' });
  });

  it('plan gate revise → PLANNING (round+1) + PLAN carrying the feedback; cap aborts', () => {
    const s1 = step(initial(phasedConfig)[0], { tag: 'PLAN_COMPILED', plan })[0];
    const [s2, cmds] = step(s1, {
      tag: 'PLAN_GATE_DECIDED',
      decision: { kind: 'revise', feedback: 'split phase two' },
    });
    expect(s2).toMatchObject({ tag: 'PLANNING', reviseRound: 1 });
    expect(cmds[0]).toEqual({ tag: 'PLAN', config: phasedConfig, feedback: 'split phase two' });
  });

  it('re-plan only via the gated path — it never auto-rewrites; the cap is enforced', () => {
    // maxGateARevisions: 2 → two revises allowed, the third aborts.
    let s = step(initial(phasedConfig)[0], { tag: 'PLAN_COMPILED', plan })[0];
    for (let round = 0; round < 2; round += 1) {
      s = step(s, { tag: 'PLAN_GATE_DECIDED', decision: { kind: 'revise', feedback: 'again' } })[0];
      expect(s.tag).toBe('PLANNING');
      s = step(s, { tag: 'PLAN_COMPILED', plan })[0]; // a fresh plan comes back to the gate
      expect(s.tag).toBe('AWAIT_PLAN_GATE');
    }
    const [aborted] = step(s, {
      tag: 'PLAN_GATE_DECIDED',
      decision: { kind: 'revise', feedback: 'third' },
    });
    expect(aborted).toMatchObject({ tag: 'ABORTED' });
    if (aborted.tag === 'ABORTED') expect(aborted.reason).toContain('plan revision cap');
  });

  it('a completed sub-goal phase → CHECKPOINTING + CHECKPOINT_PHASE (not DONE yet)', () => {
    const s1 = step(initial(phasedConfig)[0], { tag: 'PLAN_COMPILED', plan })[0];
    const phase0Start = step(s1, { tag: 'PLAN_GATE_DECIDED', decision: { kind: 'approve' } })[0];
    const [afterPhase0, enterCmds] = runPhaseToDecision(phase0Start, 'phase one');
    expect(afterPhase0.tag).toBe('CHECKPOINTING');
    // Entering CHECKPOINTING emits the between-phase checkpoint command (issue #47 primitive).
    expect(enterCmds[0]).toEqual({ tag: 'CHECKPOINT_PHASE' });
    const [, nextCmds] = step(afterPhase0, { tag: 'PHASE_CHECKPOINTED', tree: dh('00000aa')[0]! });
    expect(nextCmds[0]).toMatchObject({ tag: 'COMPILE_VERIFIER' });
  });

  it('PHASE_CHECKPOINTED advances to the next phase, scoped to the next sub-goal', () => {
    const s1 = step(initial(phasedConfig)[0], { tag: 'PLAN_COMPILED', plan })[0];
    const phase0Start = step(s1, { tag: 'PLAN_GATE_DECIDED', decision: { kind: 'approve' } })[0];
    const [checkpointing] = runPhaseToDecision(phase0Start, 'phase one');
    const [phase1Start] = step(checkpointing, { tag: 'PHASE_CHECKPOINTED', tree: dh('00000aa')[0]! });
    expect(phase1Start.tag).toBe('COMPILING');
    if (phase1Start.tag === 'COMPILING') {
      expect(phase1Start.config.goal).toBe('phase two');
      expect(phase1Start.plan).toMatchObject({ phaseIndex: 1 });
    }
  });

  it('the acceptance phase reaching both keys → whole-run DONE (no further checkpoint)', () => {
    // Advance through phase 0, checkpoint, phase 1, checkpoint, then the acceptance phase.
    const s1 = step(initial(phasedConfig)[0], { tag: 'PLAN_COMPILED', plan })[0];
    let s = step(s1, { tag: 'PLAN_GATE_DECIDED', decision: { kind: 'approve' } })[0];
    [s] = runPhaseToDecision(s, 'phase one'); // CHECKPOINTING
    s = step(s, { tag: 'PHASE_CHECKPOINTED', tree: dh('00000a1')[0]! })[0]; // phase 1 COMPILING
    [s] = runPhaseToDecision(s, 'phase two'); // CHECKPOINTING
    s = step(s, { tag: 'PHASE_CHECKPOINTED', tree: dh('00000a2')[0]! })[0]; // acceptance COMPILING
    expect(s.tag).toBe('COMPILING');
    const [done] = runPhaseToDecision(s, 'big goal'); // acceptance both keys
    expect(done.tag).toBe('DONE');
    if (done.tag === 'DONE') expect(done.iterations).toBe(3); // one iteration per phase
  });

  it('the plan hash is immutable across the whole phased run', () => {
    const s1 = step(initial(phasedConfig)[0], { tag: 'PLAN_COMPILED', plan })[0];
    let s = step(s1, { tag: 'PLAN_GATE_DECIDED', decision: { kind: 'approve' } })[0];
    const hashes: string[] = [];
    const record = (st: OrchestratorState): void => {
      if (st.tag === 'COMPILING' && st.plan !== undefined) hashes.push(st.plan.plan.planHash);
      if (st.tag === 'CHECKPOINTING') hashes.push(st.progress.plan.planHash);
    };
    record(s);
    [s] = runPhaseToDecision(s, 'phase one');
    record(s);
    s = step(s, { tag: 'PHASE_CHECKPOINTED', tree: dh('00000a1')[0]! })[0];
    record(s);
    expect(hashes.length).toBeGreaterThan(0);
    expect(new Set(hashes)).toEqual(new Set([plan.planHash]));
  });
});
