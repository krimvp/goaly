import { describe, it, expect } from 'vitest';
import { breakdownTotal, addBreakdown, isEmptyBreakdown, TokenBreakdown } from './usage';

describe('breakdownTotal', () => {
  it('sums EVERY category, including cache (the tokens the old input+output math dropped)', () => {
    // A realistic Claude block: tiny uncached input, the bulk in cache, small output.
    expect(breakdownTotal({ input: 3, output: 12, cacheRead: 17_773, cacheWrite: 3_273 })).toBe(
      21_061,
    );
  });

  it('returns undefined when no category was reported (unknown, not a silent zero)', () => {
    expect(breakdownTotal({})).toBeUndefined();
  });

  it('treats a present zero as reported (distinct from absent)', () => {
    expect(breakdownTotal({ input: 0, output: 0 })).toBe(0);
  });
});

describe('addBreakdown', () => {
  it('adds category-by-category, carrying a category present on either side', () => {
    expect(addBreakdown({ input: 10, cacheRead: 5 }, { input: 1, output: 2 })).toEqual({
      input: 11,
      output: 2,
      cacheRead: 5,
    });
  });

  it('is empty for two empty breakdowns', () => {
    expect(isEmptyBreakdown(addBreakdown({}, {}))).toBe(true);
  });
});

describe('TokenBreakdown schema', () => {
  it('rejects a negative category (fail-closed)', () => {
    expect(() => TokenBreakdown.parse({ input: -1 })).toThrow();
  });
});
