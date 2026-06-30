import { describe, it, expect } from 'vitest';
import { parsePriceTable, computeCost } from './cost';
import type { UsageReport } from '../domain/usage';
import type { ResolvedModels } from './models';

const models: ResolvedModels = {
  harness: 'harness-model',
  compiler: 'llm-model',
  judge: 'llm-model',
  approver: 'llm-model',
  approverModels: undefined,
  planner: 'llm-model',
  explain: 'llm-model',
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

describe('computeCost — per-category rates', () => {
  it('prices each category at its own rate (output 5×, cache-read 0.1×)', () => {
    const r = report({
      harness: {
        tokens: 1_021_000,
        calls: 1,
        unknownCalls: 0,
        breakdown: { input: 1_000, output: 20_000, cacheRead: 1_000_000, cacheWrite: 0 },
      },
      compiler: { tokens: 0, calls: 0, unknownCalls: 0 },
      verifier: { tokens: 0, calls: 0, unknownCalls: 0 },
      approver: { tokens: 0, calls: 0, unknownCalls: 0 },
      llm: { tokens: 0, calls: 0, unknownCalls: 0 },
      total: { tokens: 1_021_000, calls: 1, unknownCalls: 0 },
      budget: { spent: 1_021_000, exceeded: false },
    });
    const cost = computeCost(r, models, {
      'harness-model': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    });
    // input 1k@3 = 0.003; output 20k@15 = 0.300; cacheRead 1M@0.3 = 0.300; cacheWrite 0 = 0.
    expect(cost.harness).toBeCloseTo(0.603);
    expect(cost.partial).toBe(false);
  });

  it('prices flat-total spend (no split) at the category entry’s default rate', () => {
    // The harness reported only a flat total (no breakdown) — the per-category entry’s `default`
    // rate covers it, so it is still priced and not partial.
    const r = report({
      harness: { tokens: 1_000_000, calls: 1, unknownCalls: 0 },
      compiler: { tokens: 0, calls: 0, unknownCalls: 0 },
      verifier: { tokens: 0, calls: 0, unknownCalls: 0 },
      approver: { tokens: 0, calls: 0, unknownCalls: 0 },
      llm: { tokens: 0, calls: 0, unknownCalls: 0 },
      total: { tokens: 1_000_000, calls: 1, unknownCalls: 0 },
      budget: { spent: 1_000_000, exceeded: false },
    });
    const cost = computeCost(r, models, { 'harness-model': { input: 3, default: 2 } });
    expect(cost.harness).toBeCloseTo(2); // 1M @ default $2
    expect(cost.partial).toBe(false);
  });

  it('goes partial when a reported category has no rate and no default', () => {
    const r = report({
      harness: {
        tokens: 1_000_000,
        calls: 1,
        unknownCalls: 0,
        breakdown: { input: 1_000_000, cacheRead: 0 },
      },
      compiler: { tokens: 0, calls: 0, unknownCalls: 0 },
      verifier: { tokens: 0, calls: 0, unknownCalls: 0 },
      approver: { tokens: 0, calls: 0, unknownCalls: 0 },
      llm: { tokens: 0, calls: 0, unknownCalls: 0 },
      total: { tokens: 1_000_000, calls: 1, unknownCalls: 0 },
      budget: { spent: 1_000_000, exceeded: false },
    });
    // Only output is priced; the reported `input` spend has no rate → partial.
    const cost = computeCost(r, models, { 'harness-model': { output: 15 } });
    expect(cost.partial).toBe(true);
  });

  it('parses a per-category price table; rejects an unknown rate key (fail-closed)', () => {
    expect(parsePriceTable('{"m": {"input": 3, "output": 15, "cacheRead": 0.3}}')).toEqual({
      m: { input: 3, output: 15, cacheRead: 0.3 },
    });
    expect(() => parsePriceTable('{"m": {"bogus": 1}}')).toThrow();
  });
});
