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

    it('fires on a period-3 cycle A,B,C,A,B,C', () => {
      expect(
        detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'c', 'a', 'b', 'c') })),
      ).toContain('oscillation');
    });

    it('fires on a period-4 cycle', () => {
      const ctx = makeCtx({ diffHashHistory: dh('a', 'b', 'c', 'd', 'a', 'b', 'c', 'd') });
      expect(detectStuck(ctx)).toContain('oscillation');
    });

    it('reports the smallest period when one cycle nests another', () => {
      // a,b,a,b,a,b is period-2, not period-3 — the minimal cycle is reported.
      expect(detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'a', 'b', 'a', 'b') }))).toContain(
        'period 2',
      );
    });

    it('does not fire on monotonic progress', () => {
      expect(detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'c', 'd') }))).toBeNull();
    });

    it('does not fire on a single incomplete period-3 cycle', () => {
      // a,b,c,a,b is only 1.66 cycles — not yet two full back-to-back blocks.
      expect(detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'c', 'a', 'b') }))).toBeNull();
    });

    it('does not treat a constant tail as oscillation', () => {
      expect(detectStuck(makeCtx({ diffHashHistory: dh('a', 'a', 'a', 'a') }))).toBeNull();
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

    it('fires when failures differ only by volatile tokens once normalized', () => {
      // The same failure carrying a changing timestamp / temp path / PID must still repeat-match.
      const ctx = makeCtx({
        verifierDetailHistory: [
          normalizeDetail('FAIL at 2026-06-22T14:03:11Z in /tmp/run-aaa (pid 1234)'),
          normalizeDetail('FAIL at 2026-06-22T15:09:02Z in /tmp/run-bbb (pid 5678)'),
          normalizeDetail('FAIL at 2026-06-22T16:00:59Z in /tmp/run-ccc (pid 9012)'),
        ],
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

  it('scrubs ISO timestamps so two runs only differing by time compare equal', () => {
    const a = normalizeDetail('error at 2026-06-22T14:03:11.482Z: boom');
    const b = normalizeDetail('error at 2026-01-02T09:00:00Z: boom');
    expect(a).toBe(b);
    expect(a).toContain('<TS>');
  });

  it('scrubs bare wall-clock times', () => {
    expect(normalizeDetail('failed 14:03:11')).toBe(normalizeDetail('failed 23:59:00'));
  });

  it('scrubs hex addresses and long hex ids', () => {
    expect(normalizeDetail('segfault at 0x7ffe1a2b')).toBe(normalizeDetail('segfault at 0xdeadbeef'));
    expect(normalizeDetail('object a1b2c3d4e5 missing')).toBe(
      normalizeDetail('object f0e1d2c3b4 missing'),
    );
  });

  it('scrubs temp paths (unix /tmp, macOS /var/folders, goaly index)', () => {
    expect(normalizeDetail('wrote /tmp/pytest-abc/x')).toBe(normalizeDetail('wrote /tmp/pytest-xyz/y'));
    expect(normalizeDetail('idx goaly-idx-123-4')).toBe(normalizeDetail('idx goaly-idx-999-8'));
  });

  it('scrubs labelled PIDs but keeps meaningful counts as signal', () => {
    expect(normalizeDetail('crashed pid=1234')).toBe(normalizeDetail('crashed pid=5678'));
    // A bare count is NOT scrubbed — "3 of 5 failed" vs "4 of 5 failed" is real signal.
    expect(normalizeDetail('3 of 5 failed')).not.toBe(normalizeDetail('4 of 5 failed'));
  });
});
