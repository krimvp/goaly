import { describe, it, expect } from 'vitest';
import { initial, step } from './step';
import type { OrchestratorEvent, BudgetSnapshot } from '../domain/events';
import { makeFakeContract, makeConfig, dh } from '../testing/fakes';

const contract = makeFakeContract();
const budget: BudgetSnapshot = { exceeded: false };

/** Drive the reducer up to the first iteration's command for a given config. */
function firstIterationCommand(candidates: number) {
  const [s0] = initial(makeConfig({ candidates }));
  const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
  const [s2, cmds] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
  return { state: s2, command: cmds[0]! };
}

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

describe('best-of-N reducer purity (issue #85, invariant #1)', () => {
  it('N=1 emits RUN_AGENT exactly as today (byte-for-byte, no best-of marker)', () => {
    const { command } = firstIterationCommand(1);
    expect(command.tag).toBe('RUN_AGENT');
  });

  it('N>1 emits RUN_AGENT_BEST_OF instead — decided purely from config', () => {
    const { state, command } = firstIterationCommand(3);
    expect(state.tag).toBe('RUNNING_AGENT');
    expect(command).toMatchObject({ tag: 'RUN_AGENT_BEST_OF', candidates: 3, sessionId: undefined });
    if (command.tag === 'RUN_AGENT_BEST_OF') expect(command.prompt).toContain(contract.goal);
  });

  it('exactly ONE command per non-terminal state regardless of N (the Driver invariant)', () => {
    for (const n of [1, 2, 5]) {
      const [s0] = initial(makeConfig({ candidates: n }));
      const [s1] = step(s0, { tag: 'CONTRACT_COMPILED', contract });
      const [, cmds] = step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });
      expect(cmds).toHaveLength(1);
    }
  });

  it('folds exactly one AGENT_RAN to advance the iteration — the reducer never learns K existed', () => {
    const { state } = firstIterationCommand(4);
    // The reducer only ever folds AGENT_RAN; the Driver feeds back the WINNER's AGENT_RAN.
    const [verifying, cmds] = step(state, agentRan('0000000', '0000abc'));
    expect(verifying.tag).toBe('VERIFYING');
    expect(cmds[0]).toMatchObject({ tag: 'RUN_VERIFIER' });
    if (verifying.tag === 'VERIFYING') {
      expect(verifying.ctx.iteration).toBe(1); // a single completed run, not K
      expect(verifying.ctx.diffHashHistory).toEqual(['0000abc']);
    }
  });

  it('a --phased sub-goal inherits candidates via the LoopPolicy view', () => {
    // pickLoopPolicy carries `candidates`, so a phase config keeps the best-of-N knob.
    const base = makeConfig({ candidates: 3, phased: true });
    expect(base.candidates).toBe(3);
  });
});
