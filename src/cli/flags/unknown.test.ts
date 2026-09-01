import { describe, it, expect } from 'vitest';
import { rejectUnknownFlags } from './unknown';
import { UsageError } from './tokens';

describe('rejectUnknownFlags', () => {
  it('accepts documented flags, including the canonicalized alias', () => {
    expect(() =>
      rejectUnknownFlags({ goal: 'g', 'max-iterations': '3', autonomous: true, 'best-of': '2' }),
    ).not.toThrow();
  });

  it('rejects a typo, naming it and pointing at the help', () => {
    expect(() => rejectUnknownFlags({ goal: 'g', 'budget-token': '500000' })).toThrow(UsageError);
    expect(() => rejectUnknownFlags({ goal: 'g', 'budget-token': '500000' })).toThrow(
      /unknown flag: --budget-token/,
    );
  });

  it('names every unknown flag at once', () => {
    expect(() => rejectUnknownFlags({ 'max-iteratons': '3', 'nonsense-flag': 'x' })).toThrow(
      /--max-iteratons, --nonsense-flag/,
    );
  });
});
