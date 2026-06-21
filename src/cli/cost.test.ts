import { describe, it, expect } from 'vitest';
import { parsePriceTable, computeCost } from './cost';
import type { UsageReport } from '../domain/usage';
import type { ResolvedModels } from './models';

const models: ResolvedModels = {
  harness: 'harness-model',
  compiler: 'llm-model',
  judge: 'llm-model',
  approver: 'llm-model',
};

const report = (overrides: Partial<UsageReport> = {}): UsageReport => ({
  harness: { tokens: 1_000_000, calls: 1, unknownCalls: 0 },
  compiler: { tokens: 500_000, calls: 1, unknownCalls: 0 },
  verifier: { tokens: 500_000, calls: 3, unknownCalls: 0 },
  approver: { tokens: 0, calls: 1, unknownCalls: 0 },
  llm: { tokens: 1_000_000, calls: 5, unknownCalls: 0 },
  total: { tokens: 2_000_000, calls: 6, unknownCalls: 0 },
  budget: { spent: 2_000_000, exceeded: false },
  ...overrides,
});

describe('parsePriceTable', () => {
  it('parses a model → USD-per-1M map', () => {
    expect(parsePriceTable('{"claude-sonnet-4-6": 3, "default": 5}')).toEqual({
      'claude-sonnet-4-6': 3,
      default: 5,
    });
  });

  it('fails closed on invalid JSON', () => {
    expect(() => parsePriceTable('{not json')).toThrow(/not valid JSON/);
  });

  it('fails closed on a negative price', () => {
    expect(() => parsePriceTable('{"m": -1}')).toThrow();
  });
});

describe('computeCost', () => {
  it('prices each layer by its resolved model (USD per 1M tokens)', () => {
    const cost = computeCost(report(), models, { 'harness-model': 2, 'llm-model': 4 });
    // harness 1M @ $2 = 2.00; compiler 0.5M @ $4 = 2.00; verifier 0.5M @ $4 = 2.00; approver 0 = 0.
    expect(cost.harness).toBeCloseTo(2);
    expect(cost.compiler).toBeCloseTo(2);
    expect(cost.verifier).toBeCloseTo(2);
    expect(cost.approver).toBeCloseTo(0);
    expect(cost.llm).toBeCloseTo(4);
    expect(cost.total).toBeCloseTo(6);
    expect(cost.partial).toBe(false);
  });

  it('falls back to the "default" key for unlisted models', () => {
    const cost = computeCost(report(), models, { default: 1 });
    expect(cost.total).toBeCloseTo(2); // 2M tokens @ $1/M
    expect(cost.partial).toBe(false);
  });

  it('marks the report partial when a spending layer is unpriced', () => {
    // Only the harness model is priced; the LLM layers spent tokens but have no price.
    const cost = computeCost(report(), models, { 'harness-model': 2 });
    expect(cost.harness).toBeCloseTo(2);
    expect(cost.compiler).toBeUndefined();
    expect(cost.partial).toBe(true);
  });

  it('does not go partial for an unpriced layer that spent nothing', () => {
    // approver model is unlisted but the approver spent 0 tokens, so it cannot make us partial.
    const r = report({ approver: { tokens: 0, calls: 1, unknownCalls: 0 } });
    const cost = computeCost(r, models, { 'harness-model': 2, 'llm-model': 4 });
    expect(cost.partial).toBe(false);
  });
});
