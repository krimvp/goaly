import { describe, it, expect } from 'vitest';
import { detectStuck, normalizeDetail } from './stuck';
import { makeCtx, makeConfig, dh } from '../testing/fakes';

describe('detectStuck', () => {
  it('returns null when nothing is wrong', () => {
    expect(detectStuck(makeCtx())).toBeNull();
  });

  describe('no-diff', () => {
    it('fires when the last iteration changed nothing', () => {
      expect(detectStuck(makeCtx({ lastNoDiff: true, iteration: 1 }))).toContain('no-diff');
    });

    it('does not fire before any iteration completes', () => {
      expect(detectStuck(makeCtx({ lastNoDiff: true, iteration: 0 }))).toBeNull();
    });

    it('respects the policy toggle', () => {
      const ctx = makeCtx({
        config: makeConfig({ stuckPolicy: { noDiff: false } }),
        lastNoDiff: true,
        iteration: 1,
      });
      expect(detectStuck(ctx)).toBeNull();
    });
  });

  describe('oscillation', () => {
    it('fires on an A,B,A,B diff-hash cycle', () => {
      expect(detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'a', 'b') }))).toContain(
        'oscillation',
      );
    });

    it('does not fire on monotonic progress', () => {
      expect(detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'c', 'd') }))).toBeNull();
    });

    it('needs at least four data points', () => {
      expect(detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'a') }))).toBeNull();
    });

    it('respects the policy toggle', () => {
      const ctx = makeCtx({
        config: makeConfig({ stuckPolicy: { oscillation: false } }),
        diffHashHistory: dh('a', 'b', 'a', 'b'),
      });
      expect(detectStuck(ctx)).toBeNull();
    });
  });

  describe('repeat-failure', () => {
    it('fires after N identical normalized failures', () => {
      const ctx = makeCtx({ verifierDetailHistory: ['same', 'same', 'same'] });
      expect(detectStuck(ctx)).toContain('repeat-failure');
    });

    it('does not fire below the threshold', () => {
      expect(detectStuck(makeCtx({ verifierDetailHistory: ['same', 'same'] }))).toBeNull();
    });

    it('does not fire when the latest failures differ', () => {
      const ctx = makeCtx({ verifierDetailHistory: ['a', 'b', 'a'] });
      expect(detectStuck(ctx)).toBeNull();
    });

    it('honors a custom threshold', () => {
      const ctx = makeCtx({
        config: makeConfig({ stuckPolicy: { repeatFailureThreshold: 2 } }),
        verifierDetailHistory: ['x', 'x'],
      });
      expect(detectStuck(ctx)).toContain('repeat-failure');
    });
  });

  describe('budget', () => {
    it('fires when the meter reports exceeded, regardless of iteration', () => {
      const ctx = makeCtx({ iteration: 0, lastBudget: { exceeded: true } });
      expect(detectStuck(ctx)).toBe('budget exceeded');
    });

    it('takes priority over other detectors', () => {
      const ctx = makeCtx({
        lastNoDiff: true,
        diffHashHistory: dh('a', 'b', 'a', 'b'),
        verifierDetailHistory: ['same', 'same', 'same'],
        lastBudget: { exceeded: true },
      });
      expect(detectStuck(ctx)).toBe('budget exceeded');
    });
  });
});

describe('normalizeDetail', () => {
  it('collapses whitespace and trims so cosmetic differences compare equal', () => {
    expect(normalizeDetail('  a\n\t  b  ')).toBe('a b');
    expect(normalizeDetail('a b')).toBe(normalizeDetail('a   b'));
  });
});
