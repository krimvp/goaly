import { describe, it, expect } from 'vitest';
import { initial, step } from './step';
import type { OrchestratorEvent, BudgetSnapshot } from '../domain/events';
import { makeFakeContract, makeConfig, passVerdict, failVerdict, dh } from '../testing/fakes';

const contract = makeFakeContract();
const budget: BudgetSnapshot = { exceeded: false };

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

describe('step() transitions', () => {
  it('initial() seeds COMPILING + a COMPILE_VERIFIER command', () => {
    const [state, commands] = initial(makeConfig());
    expect(state.tag).toBe('COMPILING');
    expect(commands).toEqual([{ tag: 'COMPILE_VERIFIER', config: makeConfig() }]);
  });

  it('CONTRACT_COMPILED → AWAIT_GATE_A + REQUEST_GATE_A', () => {
    const [state] = initial(makeConfig());
    const [next, cmds] = step(state, { tag: 'CONTRACT_COMPILED', contract });
    expect(next.tag).toBe('AWAIT_GATE_A');
    expect(cmds[0]).toEqual({ tag: 'REQUEST_GATE_A', contract });
  });

  it('COMPILE_FAILED → FAILED with no contractHash', () => {
    const [state] = initial(makeConfig());
    const [next] = step(state, { tag: 'COMPILE_FAILED', reason: 'nope' });
    expect(next).toMatchObject({ tag: 'FAILED', reason: 'nope', contractHash: undefined });
  });

  it('Gate A approval starts the first iteration with an initial prompt', () => {
    const [s0] = initial(makeConfig());
    const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
    const [s2, cmds] = step(s1, { tag: 'GATE_A_DECIDED', decision: { kind: 'approve' } });
    expect(s2.tag).toBe('RUNNING_AGENT');
    expect(cmds[0]).toMatchObject({ tag: 'RUN_AGENT', sessionId: undefined });
    if (cmds[0]?.tag === 'RUN_AGENT') expect(cmds[0].prompt).toContain(contract.goal);
  });

  it('Gate A rejection → ABORTED before the loop starts', () => {
    const [s0] = initial(makeConfig());
    const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
    const [s2] = step(s1, {
      tag: 'GATE_A_DECIDED',
      decision: { kind: 'reject', reason: 'bad bar' },
    });
    expect(s2).toMatchObject({ tag: 'ABORTED', reason: 'bad bar' });
  });

  it('Gate A revise → back to COMPILING with a feedback-carrying COMPILE_VERIFIER', () => {
    const [s0] = initial(makeConfig());
    const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
    const [s2, cmds] = step(s1, {
      tag: 'GATE_A_DECIDED',
      decision: { kind: 'revise', feedback: 'make it stricter' },
    });
    expect(s2).toMatchObject({ tag: 'COMPILING', reviseRound: 1 });
    expect(cmds[0]).toEqual({
      tag: 'COMPILE_VERIFIER',
      config: makeConfig(),
      feedback: 'make it stricter',
    });
  });

  it('revise carries reviseRound forward and re-presents at Gate A', () => {
    const [s0] = initial(makeConfig());
    const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
    const [s2] = step(s1, {
      tag: 'GATE_A_DECIDED',
      decision: { kind: 'revise', feedback: 'again' },
    });
    // The re-compile lands back at AWAIT_GATE_A with reviseRound preserved.
    const [s3] = step(s2, { tag: 'CONTRACT_COMPILED', contract });
    expect(s3).toMatchObject({ tag: 'AWAIT_GATE_A', reviseRound: 1 });
  });

  it('revise past maxGateARevisions → ABORTED', () => {
    const config = makeConfig({ maxGateARevisions: 1 });
    let state = step(initial(config)[0], { tag: 'CONTRACT_COMPILED', contract })[0];
    // First revise is allowed (round 0 → 1).
    state = step(state, { tag: 'GATE_A_DECIDED', decision: { kind: 'revise', feedback: 'a' } })[0];
    state = step(state, { tag: 'CONTRACT_COMPILED', contract })[0];
    // Second revise exceeds the cap of 1 → abort.
    const [aborted] = step(state, {
      tag: 'GATE_A_DECIDED',
      decision: { kind: 'revise', feedback: 'b' },
    });
    expect(aborted).toMatchObject({ tag: 'ABORTED' });
    if (aborted.tag === 'ABORTED') expect(aborted.reason).toContain('revision cap');
  });

  it('maxGateARevisions: 0 aborts on the first revise', () => {
    const config = makeConfig({ maxGateARevisions: 0 });
    const state = step(initial(config)[0], { tag: 'CONTRACT_COMPILED', contract })[0];
    const [aborted] = step(state, {
      tag: 'GATE_A_DECIDED',
      decision: { kind: 'revise', feedback: 'x' },
    });
    expect(aborted).toMatchObject({ tag: 'ABORTED' });
  });

  it('AGENT_RAN → VERIFYING + RUN_VERIFIER, threading the session id', () => {
    const ra = runningAgent();
    const [next, cmds] = step(ra, agentRan('0000000', '0000001'));
    expect(next.tag).toBe('VERIFYING');
    expect(cmds[0]).toEqual({ tag: 'RUN_VERIFIER', contract });
  });

  it('VERIFIED pass → AWAIT_GATE_B + REQUEST_GATE_B with the frozen rubric', () => {
    const verifying = step(runningAgent(), agentRan('0000000', '0000001'))[0];
    const [next, cmds] = step(verifying, { tag: 'VERIFIED', verdict: passVerdict() });
    expect(next.tag).toBe('AWAIT_GATE_B');
    expect(cmds[0]).toMatchObject({ tag: 'REQUEST_GATE_B', goal: contract.goal });
  });

  it('VERIFIED fail → CONTINUE: back to RUNNING_AGENT with feedback in the prompt', () => {
    const verifying = step(runningAgent(), agentRan('0000000', '0000001'))[0];
    const [next, cmds] = step(verifying, { tag: 'VERIFIED', verdict: failVerdict('build broke') });
    expect(next.tag).toBe('RUNNING_AGENT');
    if (cmds[0]?.tag === 'RUN_AGENT') expect(cmds[0].prompt).toContain('build broke');
  });

  it('throws on an invalid (state, event) pair', () => {
    const [s0] = initial(makeConfig());
    expect(() => step(s0, { tag: 'VERIFIED', verdict: passVerdict() })).toThrow(
      /invalid transition/,
    );
  });

  it('throws when stepped on a terminal state', () => {
    const terminal = { tag: 'DONE', iterations: 1, contractHash: contract.contractHash } as const;
    expect(() => step(terminal, { tag: 'VERIFIED', verdict: passVerdict() })).toThrow(/terminal/);
  });
});

/** Drive the machine to a RUNNING_AGENT state for transition tests. */
function runningAgent() {
  const [s0] = initial(makeConfig());
  const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
  const [s2] = step(s1, { tag: 'GATE_A_DECIDED', decision: { kind: 'approve' } });
  return s2;
}
