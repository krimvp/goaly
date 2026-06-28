import { describe, it, expect } from 'vitest';
import { compactRun } from './compaction';
import type { RunDetail, IterationDetail } from '../runlog/inspect';
import { makeFakeContract } from '../testing/fakes';
import { RunId, SessionId } from '../domain/ids';

const contract = makeFakeContract({
  goal: 'build the parser',
  rubric: 'the parser handles nested input',
  rungs: [
    { kind: 'deterministic', command: 'npm test' },
    { kind: 'judge', rubric: 'reads cleanly', quorum: 3, confidenceFloor: 0.66 },
  ],
});

function iteration(over: Partial<IterationDetail> = {}): IterationDetail {
  return {
    index: 1,
    runStatus: 'completed',
    changed: true,
    tokensSpent: 100,
    sessionId: SessionId.parse('s1'),
    verdict: { pass: true, confidence: 1, detail: 'all green' },
    signoff: { veto: false },
    phase: undefined,
    ...over,
  };
}

function detail(over: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: RunId.parse('run-prior'),
    goal: 'build the parser',
    status: 'DONE',
    stateTag: 'DONE',
    reason: undefined,
    harness: 'claude',
    sessionId: SessionId.parse('sess-prior'),
    startedAt: 1,
    endedAt: 2,
    iterations: 2,
    tokensSpent: 200,
    usage: {
      harness: { tokens: 0, calls: 0, unknownCalls: 0 },
      compiler: { tokens: 0, calls: 0, unknownCalls: 0 },
      verifier: { tokens: 0, calls: 0, unknownCalls: 0 },
      approver: { tokens: 0, calls: 0, unknownCalls: 0 },
      llm: { tokens: 0, calls: 0, unknownCalls: 0 },
      total: { tokens: 0, calls: 0, unknownCalls: 0 },
      budget: { spent: 0, exceeded: false },
    },
    contract,
    contractHash: contract.contractHash,
    plan: null,
    planSeal: [],
    planFailures: [],
    compileFailures: [],
    seal: [{ kind: 'approve' }],
    prepare: undefined,
    iterationsDetail: [iteration()],
    ...over,
  };
}

describe('compactRun', () => {
  it('is a deterministic projection (same detail → same string)', () => {
    expect(compactRun(detail())).toBe(compactRun(detail()));
  });

  it('summarizes the prior goal, outcome, frozen bar, and final two-key result', () => {
    const seed = compactRun(detail());
    expect(seed).toContain('Prior run context (run run-prior)');
    expect(seed).toContain('build the parser');
    expect(seed).toContain('Prior outcome: DONE');
    expect(seed).toContain('2 iterations');
    expect(seed).toContain(contract.contractHash);
    expect(seed).toContain('the parser handles nested input'); // rubric
    expect(seed).toContain('[deterministic] npm test');
    expect(seed).toContain('[judge] quorum 3, floor 0.66');
    expect(seed).toContain('ladder: PASS');
    expect(seed).toContain('sign-off: approved');
  });

  it('instructs the follow-up to author FRESH verification, not reuse the prior contract', () => {
    const seed = compactRun(detail());
    expect(seed).toMatch(/do NOT copy.*weaken the prior frozen contract/is);
    expect(seed).toContain('FRESH');
  });

  it('renders the terminal reason for a non-DONE run', () => {
    const seed = compactRun(
      detail({ status: 'FAILED', reason: 'STUCK_NO_DIFF: no change for a full iteration' }),
    );
    expect(seed).toContain('Prior outcome: FAILED — STUCK_NO_DIFF');
  });

  it('surfaces a final-iteration veto', () => {
    const seed = compactRun(
      detail({
        iterationsDetail: [
          iteration({ verdict: { pass: true, confidence: 1, detail: 'green' }, signoff: { veto: true, reason: 'leaves empty input unhandled' } }),
        ],
      }),
    );
    expect(seed).toContain('sign-off: VETO — leaves empty input unhandled');
  });

  it('degrades gracefully on a compile-time failure (no contract, no iterations)', () => {
    const seed = compactRun(
      detail({ status: 'FAILED', reason: 'compile failed', contract: null, contractHash: null, iterationsDetail: [] }),
    );
    expect(seed).toContain('Prior outcome: FAILED');
    expect(seed).not.toContain('Prior frozen contract');
    expect(seed).not.toContain('Final iteration');
  });
});
