import { describe, it, expect } from 'vitest';
import { formatOutcome } from './main';
import { formatUsage } from './usage-format';
import type { RunOutcome } from '../domain/events';
import type { UsageReport } from '../domain/usage';
import { RunId, ContractHash } from '../domain/ids';
import type { CostView } from './cost';

const usage = (overrides: Partial<UsageReport> = {}): UsageReport => ({
  harness: { tokens: 12_000, calls: 1, unknownCalls: 0 },
  compiler: { tokens: 800, calls: 1, unknownCalls: 0 },
  verifier: { tokens: 1_200, calls: 3, unknownCalls: 0 },
  approver: { tokens: 400, calls: 1, unknownCalls: 0 },
  llm: { tokens: 2_400, calls: 5, unknownCalls: 0 },
  total: { tokens: 14_400, calls: 6, unknownCalls: 0 },
  budget: { tokens: 20_000, spent: 14_400, exceeded: false },
  ...overrides,
});

const outcome = (overrides: Partial<RunOutcome> = {}): RunOutcome => ({
  status: 'DONE',
  iterations: 3,
  contractHash: ContractHash.parse('a'.repeat(64)),
  runId: RunId.parse('run-x'),
  usage: usage(),
  ...overrides,
});

describe('formatUsage', () => {
  it('renders the per-layer token breakdown with thousands separators', () => {
    const lines = formatUsage(usage());
    const text = lines.join('\n');
    expect(text).toContain('harness');
    expect(text).toContain('12,000 tokens');
    expect(text).toContain('llm subtotal');
    expect(text).toContain('2,400 tokens');
    expect(text).toContain('total');
    expect(text).toContain('14,400 tokens');
  });

  it('renders budget consumed vs the cap with a percentage', () => {
    const text = formatUsage(usage()).join('\n');
    expect(text).toContain('budget:');
    expect(text).toContain('14,400 / 20,000 tokens (72%)');
  });

  it('flags an exceeded budget', () => {
    const u = usage({ budget: { tokens: 10_000, spent: 12_000, exceeded: true } });
    expect(formatUsage(u).join('\n')).toContain('budget exceeded');
  });

  it('omits the budget line when no cap is configured', () => {
    const u = usage({ budget: { spent: 14_400, exceeded: false } });
    expect(formatUsage(u).join('\n')).not.toContain('budget:');
  });

  it('surfaces missing token data as "unknown" rather than zero', () => {
    const u = usage({ harness: { tokens: 0, calls: 1, unknownCalls: 1 } });
    expect(formatUsage(u).join('\n')).toContain('unknown (1 call(s) reported no usage)');
  });

  it('marks the estimated portion of a layer (issue #24)', () => {
    const u = usage({ harness: { tokens: 3_000, calls: 1, unknownCalls: 0, estimatedTokens: 3_000 } });
    const text = formatUsage(u).join('\n');
    expect(text).toContain('3,000 tokens (3,000 estimated)');
  });

  it('overlays an approximate USD cost per layer when a cost view is given', () => {
    const cost: CostView = {
      harness: 0.12,
      compiler: 0.01,
      verifier: 0.02,
      approver: 0.01,
      llm: 0.04,
      total: 0.16,
      partial: false,
    };
    const text = formatUsage(usage(), cost).join('\n');
    expect(text).toContain('≈ $0.12');
    expect(text).toContain('≈ $0.16');
  });

  it('marks the total approximate when some models were unpriced', () => {
    const cost: CostView = { harness: 0.12, llm: 0, total: 0.12, partial: true };
    const text = formatUsage(usage(), cost).join('\n');
    expect(text).toContain('some models unpriced');
  });
});

describe('formatOutcome', () => {
  it('appends the spend block when the outcome carries usage', () => {
    const text = formatOutcome(outcome());
    expect(text).toContain('status:      DONE');
    expect(text).toContain('spend:');
    expect(text).toContain('12,000 tokens');
  });

  it('omits the spend block when usage is absent', () => {
    const text = formatOutcome(outcome({ usage: undefined }));
    expect(text).not.toContain('spend:');
  });
});
