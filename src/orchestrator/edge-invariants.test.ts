import { describe, expect, it } from 'vitest';
import type { OrchestratorEvent } from '../domain/events';
import type { OrchestratorState } from './state';
import { makeConfig, makeFakeContract, passVerdict, failVerdict, dh } from '../testing/fakes';
import { initial, step } from './step';

type Edge = { event: OrchestratorEvent; to: OrchestratorState['tag'] };

const contract = makeFakeContract({ setup: 'true' });
const config = makeConfig({ maxIterations: 3 });
const phased = makeConfig({ phased: true, maxIterations: 3 });
const plan = { phases: [{ goal: 'subgoal' }], planHash: 'a'.repeat(64) } as never;
const agentRan: OrchestratorEvent = {
  tag: 'AGENT_RAN',
  run: { output: '', sessionId: 'session' as never, status: 'completed' },
  prevDiffHash: dh('0000000')[0]!,
  diffHash: dh('0000001')[0]!,
  budget: { exceeded: false },
};

function sealed(): OrchestratorState {
  const compiled = step(initial(config)[0], { tag: 'CONTRACT_COMPILED', contract })[0];
  return step(compiled, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } })[0];
}

function running(): OrchestratorState {
  return step(sealed(), { tag: 'WORKSPACE_PREPARED', prepared: { status: 'proceed' }, setupRan: true })[0];
}

function verifying(): OrchestratorState {
  return step(running(), agentRan)[0];
}

function stateFixtures(): Record<OrchestratorState['tag'], OrchestratorState> {
  const planning = initial(phased)[0];
  const planSeal = step(planning, { tag: 'PLAN_COMPILED', plan })[0];
  const compile = initial(config)[0];
  const seal = step(compile, { tag: 'CONTRACT_COMPILED', contract })[0];
  const run = running();
  if (run.tag !== 'RUNNING_AGENT') throw new Error('fixture did not reach RUNNING_AGENT');
  const phase = { baseConfig: phased, plan, index: 0 } as never;
  return {
    PLANNING: planning,
    AWAIT_PLAN_SEAL: planSeal,
    ADVANCING_PHASE: { tag: 'ADVANCING_PHASE', phase, lastIteration: 1 },
    RUNNING_WAVE: { tag: 'RUNNING_WAVE', phase, indices: [0] },
    COMPILING: compile,
    AWAIT_SEAL: seal,
    PREPARING: sealed(),
    RUNNING_AGENT: run,
    VERIFYING: verifying(),
    AWAIT_SIGNOFF: step(verifying(), { tag: 'VERIFIED', verdict: passVerdict() })[0],
    ADJUDICATING: { tag: 'ADJUDICATING', ctx: run.ctx, fallbackReason: 'red' },
    DONE: { tag: 'DONE', iterations: 1, contractHash: contract.contractHash },
    FAILED: { tag: 'FAILED', iterations: 1, contractHash: contract.contractHash, reason: 'red' },
    ABORTED: { tag: 'ABORTED', iterations: 1, contractHash: contract.contractHash, reason: 'red' },
  };
}

// Representative guarded edges. Record over every state tag means a new state needs an explicit row.
// This is not a complete graph of all guard values or Driver-only marker events.
const edges = {
  PLANNING: [
    { event: { tag: 'PLAN_COMPILED', plan }, to: 'AWAIT_PLAN_SEAL' },
    { event: { tag: 'PLAN_FAILED', reason: 'bad' }, to: 'PLANNING' },
  ],
  AWAIT_PLAN_SEAL: [
    { event: { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } }, to: 'COMPILING' },
    { event: { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'reject', reason: 'bad' } }, to: 'ABORTED' },
  ],
  ADVANCING_PHASE: [{ event: { tag: 'PHASE_ADVANCED', tree: dh('0000002')[0]! }, to: 'COMPILING' }],
  RUNNING_WAVE: [{ event: { tag: 'WAVE_RAN', outcomes: [{ kind: 'merged', index: 0 }], tree: dh('0000002')[0]! }, to: 'COMPILING' }],
  COMPILING: [
    { event: { tag: 'CONTRACT_COMPILED', contract }, to: 'AWAIT_SEAL' },
    { event: { tag: 'COMPILE_FAILED', reason: 'bad' }, to: 'COMPILING' },
  ],
  AWAIT_SEAL: [
    { event: { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }, to: 'PREPARING' },
    { event: { tag: 'SEAL_DECIDED', decision: { kind: 'reject', reason: 'bad' } }, to: 'ABORTED' },
    { event: { tag: 'SEAL_DECIDED', decision: { kind: 'revise', feedback: 'fix' } }, to: 'COMPILING' },
  ],
  PREPARING: [
    { event: { tag: 'WORKSPACE_PREPARED', prepared: { status: 'proceed' }, setupRan: true }, to: 'RUNNING_AGENT' },
    { event: { tag: 'WORKSPACE_PREPARED', prepared: { status: 'setup-failed', detail: 'bad' }, setupRan: true }, to: 'FAILED' },
  ],
  RUNNING_AGENT: [{ event: agentRan, to: 'VERIFYING' }],
  VERIFYING: [
    { event: { tag: 'VERIFIED', verdict: passVerdict() }, to: 'AWAIT_SIGNOFF' },
    { event: { tag: 'VERIFIED', verdict: failVerdict('red') }, to: 'RUNNING_AGENT' },
  ],
  AWAIT_SIGNOFF: [
    { event: { tag: 'SIGNOFF_DECIDED', approval: { veto: false, reason: '' } }, to: 'DONE' },
    { event: { tag: 'SIGNOFF_DECIDED', approval: { veto: true, reason: 'red' } }, to: 'RUNNING_AGENT' },
  ],
  ADJUDICATING: [{ event: { tag: 'CONTRACT_ADJUDICATED', defective: false, reason: 'sound' }, to: 'ABORTED' }],
  DONE: [],
  FAILED: [],
  ABORTED: [],
} satisfies Record<OrchestratorState['tag'], readonly Edge[]>;

function frozenHash(state: OrchestratorState): string {
  if ('ctx' in state) return state.ctx.contract.contractHash;
  if ('contract' in state) return state.contract.contractHash;
  if ('contractHash' in state) return state.contractHash ?? '';
  throw new Error(`state ${state.tag} carries no contract`);
}

describe('closed edge inventory and contract invariants', () => {
  it('executes each inventoried edge and keeps post-Seal hashes fixed', () => {
    const fixtures = stateFixtures();
    expect(Object.keys(edges)).toHaveLength(14);
    for (const tag of Object.keys(edges) as OrchestratorState['tag'][]) {
      const state = fixtures[tag];
      expect(state.tag).toBe(tag);
      for (const edge of edges[tag]) {
        const [next] = step(state, edge.event);
        expect(next.tag).toBe(edge.to);
        if (['PREPARING', 'RUNNING_AGENT', 'VERIFYING', 'AWAIT_SIGNOFF', 'ADJUDICATING'].includes(tag)) {
          expect(frozenHash(next)).toBe(frozenHash(state));
        }
      }
    }
    for (const tag of ['DONE', 'FAILED', 'ABORTED'] as const) expect(edges[tag]).toEqual([]);
  });

  it('never enters DONE without a passing ladder and a non-vetoing Sign-off', () => {
    const red = step(verifying(), { tag: 'VERIFIED', verdict: failVerdict('red') });
    expect(red[0].tag).not.toBe('DONE');
    expect(red[1].some((command) => command.tag === 'REQUEST_SIGNOFF')).toBe(false);

    const green = step(verifying(), { tag: 'VERIFIED', verdict: passVerdict() });
    expect(green[0].tag).toBe('AWAIT_SIGNOFF');
    expect(green[1].map((command) => command.tag)).toEqual(['REQUEST_SIGNOFF']);
    for (const veto of [true, false]) {
      const [next] = step(green[0], {
        tag: 'SIGNOFF_DECIDED',
        approval: { veto, reason: veto ? 'not complete' : 'approved' },
      });
      expect(next.tag === 'DONE').toBe(!veto);
    }
  });

  it('requires both keys again in the final acceptance phase', () => {
    const phased = makeConfig({ phased: true, maxIterations: 3 });
    const plan = { phases: [{ goal: 'subgoal' }], planHash: 'a'.repeat(64) } as never;
    const planned = step(initial(phased)[0], { tag: 'PLAN_COMPILED', plan })[0];
    const compiling = step(planned, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } })[0];
    const firstSeal = step(compiling, { tag: 'CONTRACT_COMPILED', contract })[0];
    const firstPrepare = step(firstSeal, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } })[0];
    const firstRun = step(firstPrepare, { tag: 'WORKSPACE_PREPARED', prepared: { status: 'proceed' }, setupRan: true })[0];
    const firstVerify = step(firstRun, agentRan)[0];
    const firstSignoff = step(firstVerify, { tag: 'VERIFIED', verdict: passVerdict() })[0];
    const advancing = step(firstSignoff, {
      tag: 'SIGNOFF_DECIDED', approval: { veto: false, reason: '' },
    })[0];
    expect(advancing.tag).toBe('ADVANCING_PHASE');

    const acceptance = makeFakeContract({ goal: 'original goal', setup: 'true' });
    const finalCompile = step(advancing, { tag: 'PHASE_ADVANCED', tree: dh('0000002')[0]! })[0];
    const finalSeal = step(finalCompile, { tag: 'CONTRACT_COMPILED', contract: acceptance })[0];
    const finalPrepare = step(finalSeal, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } })[0];
    const finalRun = step(finalPrepare, { tag: 'WORKSPACE_PREPARED', prepared: { status: 'proceed' }, setupRan: true })[0];
    const finalVerify = step(finalRun, agentRan)[0];
    const red = step(finalVerify, { tag: 'VERIFIED', verdict: failVerdict('red') })[0];
    expect(red.tag).not.toBe('DONE');
    const finalSignoff = step(finalVerify, { tag: 'VERIFIED', verdict: passVerdict() })[0];
    const vetoed = step(finalSignoff, { tag: 'SIGNOFF_DECIDED', approval: { veto: true, reason: 'red' } })[0];
    const done = step(finalSignoff, { tag: 'SIGNOFF_DECIDED', approval: { veto: false, reason: '' } })[0];
    expect(vetoed.tag).not.toBe('DONE');
    expect(done).toMatchObject({ tag: 'DONE', contractHash: acceptance.contractHash });
  });

  it('keeps the sealed contract hash across representative post-Seal edges', () => {
    const prepare = sealed();
    const run = running();
    const verify = verifying();
    const signoff = step(verify, { tag: 'VERIFIED', verdict: passVerdict() })[0];
    const vetoed = step(signoff, { tag: 'SIGNOFF_DECIDED', approval: { veto: true, reason: 'red' } })[0];
    const done = step(signoff, { tag: 'SIGNOFF_DECIDED', approval: { veto: false, reason: '' } })[0];
    const failedPrepare = step(prepare, {
      tag: 'WORKSPACE_PREPARED', prepared: { status: 'setup-failed', detail: 'failed' }, setupRan: true,
    })[0];
    const aborted = step(step(initial(config)[0], { tag: 'CONTRACT_COMPILED', contract })[0], {
      tag: 'SEAL_DECIDED', decision: { kind: 'reject', reason: 'reject' },
    })[0];

    for (const state of [prepare, run, verify, signoff, vetoed, done, failedPrepare, aborted]) {
      expect(frozenHash(state)).toBe(contract.contractHash);
    }
  });
});
