import { describe, it, expect } from 'vitest';
import { summarizeUsage } from './usage';
import type { OrchestratorEvent } from '../domain/events';
import type { TokenUsage } from '../domain/usage';
import { DiffHash, SessionId } from '../domain/ids';
import { makeFakeContract, passVerdict, approve, veto } from '../testing/fakes';

const u = (tokens: number, calls = 1, unknownCalls = 0): TokenUsage => ({
  tokens,
  calls,
  unknownCalls,
});

const agentRan = (tokensUsed?: number): OrchestratorEvent => ({
  tag: 'AGENT_RAN',
  run: {
    output: 'ran',
    sessionId: SessionId.parse('s-1'),
    status: 'completed',
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
  },
  prevDiffHash: DiffHash.parse('0000000'),
  diffHash: DiffHash.parse('0000001'),
  budget: { exceeded: false },
});

const compiled = (llm?: TokenUsage): OrchestratorEvent => ({
  tag: 'CONTRACT_COMPILED',
  contract: makeFakeContract(),
  ...(llm !== undefined ? { llm } : {}),
});

const verified = (llm?: TokenUsage): OrchestratorEvent => ({
  tag: 'VERIFIED',
  verdict: passVerdict(),
  ...(llm !== undefined ? { llm } : {}),
});

const gateB = (approval = approve(), llm?: TokenUsage): OrchestratorEvent => ({
  tag: 'GATE_B_DECIDED',
  approval,
  ...(llm !== undefined ? { llm } : {}),
});

describe('summarizeUsage', () => {
  it('breaks spend down by layer (harness vs the LLM steps)', () => {
    const events = [
      compiled(u(800)),
      agentRan(12_000),
      verified(u(1_200, 3)),
      gateB(approve(), u(400)),
    ];

    const report = summarizeUsage(events, {});

    expect(report.harness).toEqual(u(12_000));
    expect(report.compiler).toEqual(u(800));
    expect(report.verifier).toEqual(u(1_200, 3));
    expect(report.approver).toEqual(u(400));
    expect(report.llm).toEqual({ tokens: 2_400, calls: 5, unknownCalls: 0 });
    expect(report.total).toEqual({ tokens: 14_400, calls: 6, unknownCalls: 0 });
  });

  it('sums spend across many iterations and compile retries', () => {
    const events = [
      compiled(u(500)),
      compiled(u(300)), // a Gate A revise re-authors the contract
      agentRan(1_000),
      verified(u(100, 3)),
      gateB(veto('nope'), u(50)),
      agentRan(2_000),
      verified(u(120, 3)),
      gateB(approve(), u(60)),
    ];

    const report = summarizeUsage(events, {});

    expect(report.harness.tokens).toBe(3_000);
    expect(report.compiler.tokens).toBe(800);
    expect(report.verifier.tokens).toBe(220);
    expect(report.approver.tokens).toBe(110);
    expect(report.total.tokens).toBe(4_130);
  });

  it('counts a COMPILE_FAILED that already spent tokens', () => {
    const report = summarizeUsage(
      [{ tag: 'COMPILE_FAILED', reason: 'bad json', llm: u(250) }],
      {},
    );
    expect(report.compiler).toEqual(u(250));
    expect(report.llm.tokens).toBe(250);
  });

  it('degrades missing harness token data to unknown, never zero', () => {
    const report = summarizeUsage([agentRan(undefined), agentRan(5_000)], {});
    expect(report.harness).toEqual({ tokens: 5_000, calls: 2, unknownCalls: 1 });
  });

  it('treats a step with no LLM call (existing compile / deterministic verify) as zero, not unknown', () => {
    const report = summarizeUsage([compiled(undefined), verified(undefined)], {});
    expect(report.compiler).toEqual({ tokens: 0, calls: 0, unknownCalls: 0 });
    expect(report.verifier).toEqual({ tokens: 0, calls: 0, unknownCalls: 0 });
  });

  it('reports budget consumed vs the configured --budget-tokens cap', () => {
    const report = summarizeUsage([agentRan(8_000), verified(u(2_000, 3))], { tokens: 10_000 });
    expect(report.budget.tokens).toBe(10_000);
    expect(report.budget.spent).toBe(10_000);
    expect(report.budget.exceeded).toBe(true);
  });

  it('omits the cap and is never exceeded when no budget is set', () => {
    const report = summarizeUsage([agentRan(8_000)], {});
    expect(report.budget.tokens).toBeUndefined();
    expect(report.budget.exceeded).toBe(false);
    expect(report.budget.spent).toBe(8_000);
  });

  it('returns an all-zero report for an empty log', () => {
    const report = summarizeUsage([], {});
    expect(report.total).toEqual({ tokens: 0, calls: 0, unknownCalls: 0 });
  });
});
