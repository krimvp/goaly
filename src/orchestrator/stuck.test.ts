import { describe, it, expect } from 'vitest';
import { detectStuck, normalizeDetail } from './stuck';
import { makeCtx, makeConfig, dh } from '../testing/fakes';

// detectStuck is pure over the LoopCtx histories and returns a typed { kind, message } (or null).
// The IN-FLIGHT fresh-veto excuse (green ladder blocked only by an unseen veto) lives in DECIDE, so
// it is exercised in decide.test.ts; here we test the history-driven detectors + the history half of
// the no-diff excuse (timeout/crash).

describe('detectStuck', () => {
  it('returns null when nothing is wrong', () => {
    expect(detectStuck(makeCtx())).toBeNull();
  });

  describe('no-diff', () => {
    it('fires when the last iteration changed nothing', () => {
      const reason = detectStuck(makeCtx({ lastNoDiff: true, iteration: 1 }));
      expect(reason?.kind).toBe('no-diff');
      expect(reason?.message).toContain('no-diff');
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

  describe('no-diff history excuse — timeout / crash / truncated (issue #54 + follow-on F)', () => {
    it('does not trip no-diff when the previous turn was killed by a timeout', () => {
      const ctx = makeCtx({ lastNoDiff: true, iteration: 1, lastRunStatus: 'timeout' });
      // A timed-out turn never had a fair chance to edit; the timeout → maxIterations backstop decides.
      expect(detectStuck(ctx)).toBeNull();
    });

    it('does not trip no-diff when the previous turn was truncated by the turn cap (follow-on F)', () => {
      // glm/kimi-style: the agent hit its per-run turn cap mid-work, so a no-diff on that capped
      // iteration is "ran out of room," not "stuck" — it gets another iteration, bounded by
      // maxIterations / budget rather than a premature no-diff abort.
      const ctx = makeCtx({ lastNoDiff: true, iteration: 1, lastRunStatus: 'truncated' });
      expect(detectStuck(ctx)).toBeNull();
    });

    it('still trips no-diff when a completed turn made no edits (regression)', () => {
      const ctx = makeCtx({ lastNoDiff: true, iteration: 1, lastRunStatus: 'completed' });
      expect(detectStuck(ctx)?.message).toContain('no-diff');
    });
  });

  describe('oscillation', () => {
    it('fires on an A,B,A,B diff-hash cycle', () => {
      expect(detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'a', 'b') }))?.message).toContain(
        'oscillation',
      );
    });

    it('fires on a period-3 cycle A,B,C,A,B,C', () => {
      expect(
        detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'c', 'a', 'b', 'c') }))?.message,
      ).toContain('oscillation');
    });

    it('fires on a period-4 cycle', () => {
      const ctx = makeCtx({ diffHashHistory: dh('a', 'b', 'c', 'd', 'a', 'b', 'c', 'd') });
      expect(detectStuck(ctx)?.message).toContain('oscillation');
    });

    it('reports the smallest period when one cycle nests another', () => {
      // a,b,a,b,a,b is period-2, not period-3 — the minimal cycle is reported.
      expect(
        detectStuck(makeCtx({ diffHashHistory: dh('a', 'b', 'a', 'b', 'a', 'b') }))?.message,
      ).toContain('period 2');
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
      const reason = detectStuck(ctx);
      expect(reason?.kind).toBe('repeat');
      expect(reason?.message).toContain('repeat-failure');
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
      expect(detectStuck(ctx)?.message).toContain('repeat-failure');
    });

    it('fires even when the worker changes files every iteration (Fix #3: diff churn must not mask a repeated failure)', () => {
      // The incident: the worker edited src/ every turn so the diff hash kept moving, yet the verifier
      // produced a byte-identical failure. Repeat-failure is keyed on the verifier signature, NOT the
      // diff hash, so monotonic churn (no no-diff, no oscillation) must NOT hide the repeat.
      const ctx = makeCtx({
        lastNoDiff: false,
        diffHashHistory: dh('a', 'b', 'c'),
        verifierDetailHistory: [
          "TS2339: Property 'not' does not exist on type 'Matchers'",
          "TS2339: Property 'not' does not exist on type 'Matchers'",
          "TS2339: Property 'not' does not exist on type 'Matchers'",
        ],
      });
      const reason = detectStuck(ctx);
      expect(reason?.message).toContain('repeat-failure');
      // The abort is typed and names the repeated signature so it's diagnosable.
      expect(reason?.message).toContain('STUCK_REPEATED_FAILURE');
      expect(reason?.message).toContain('TS2339');
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
      expect(detectStuck(ctx)?.message).toContain('repeat-failure');
    });
  });

  describe('harness-crash streak', () => {
    it('fires after the default threshold (2) of consecutive crashes', () => {
      const ctx = makeCtx({ runStatusHistory: ['crashed', 'crashed'] });
      const reason = detectStuck(ctx);
      expect(reason?.kind).toBe('crash');
      expect(reason?.message).toContain('STUCK_HARNESS_CRASH');
      expect(reason?.message).toContain('exited abnormally');
    });

    it('does not fire on a single crash (which may be transient — one retry is allowed)', () => {
      expect(detectStuck(makeCtx({ runStatusHistory: ['crashed'] }))).toBeNull();
    });

    it('resets when a crash is interrupted by a completed run', () => {
      const ctx = makeCtx({ runStatusHistory: ['crashed', 'completed', 'crashed'] });
      expect(detectStuck(ctx)).toBeNull();
    });

    it('surfaces the harness output verbatim so the real cause is visible, not the downstream red', () => {
      const ctx = makeCtx({
        runStatusHistory: ['crashed', 'crashed'],
        lastRunOutput: 'claude: command not found',
      });
      expect(detectStuck(ctx)?.message).toContain('claude: command not found');
    });

    it('honors a custom threshold', () => {
      const ctx = makeCtx({
        config: makeConfig({ stuckPolicy: { harnessCrashThreshold: 3 } }),
        runStatusHistory: ['crashed', 'crashed'],
      });
      expect(detectStuck(ctx)).toBeNull();
      const tripped = makeCtx({
        config: makeConfig({ stuckPolicy: { harnessCrashThreshold: 3 } }),
        runStatusHistory: ['crashed', 'crashed', 'crashed'],
      });
      expect(detectStuck(tripped)?.message).toContain('STUCK_HARNESS_CRASH');
    });

    it('wins over the downstream verifier red a crashed turn leaves (the misdiagnosis fix)', () => {
      // The real incident: the harness crashed every turn, leaving a stale verifier ImportError that
      // repeated. The crash is the true cause, so it must be reported instead of STUCK_REPEATED_FAILURE.
      const ctx = makeCtx({
        runStatusHistory: ['crashed', 'crashed', 'crashed'],
        lastRunStatus: 'crashed',
        verifierDetailHistory: ['ImportError', 'ImportError', 'ImportError'],
      });
      const reason = detectStuck(ctx);
      expect(reason?.message).toContain('STUCK_HARNESS_CRASH');
      expect(reason?.message).not.toContain('STUCK_REPEATED_FAILURE');
    });

    it('excuses no-diff for a crashed turn so the crash diagnosis wins (not a misleading no-diff)', () => {
      // A crash that left the tree unchanged must not abort as "no-diff" — it never got to edit.
      const ctx = makeCtx({ lastNoDiff: true, iteration: 1, lastRunStatus: 'crashed' });
      expect(detectStuck(ctx)).toBeNull();
    });
  });

  describe('contract-unevaluable streak', () => {
    it('fires after the default threshold (2) of consecutive could-not-evaluate verdicts', () => {
      const ctx = makeCtx({ verifierEvaluableHistory: [false, false] });
      const reason = detectStuck(ctx);
      expect(reason?.kind).toBe('unevaluable');
      expect(reason?.message).toContain('CONTRACT_UNEVALUABLE');
      expect(reason?.message).toContain('UNVERIFIED');
    });

    it('does not fire on a single unevaluable (which may be transient — one retry is allowed)', () => {
      expect(detectStuck(makeCtx({ verifierEvaluableHistory: [false] }))).toBeNull();
    });

    it('resets when a real evaluation (a true) interrupts the streak', () => {
      const ctx = makeCtx({ verifierEvaluableHistory: [false, true, false] });
      expect(detectStuck(ctx)).toBeNull();
    });

    it('does not fire on a streak of GENUINE evaluations (real reds, not could-not-evaluate)', () => {
      const ctx = makeCtx({
        verifierEvaluableHistory: [true, true, true],
        verifierDetailHistory: ['a', 'b', 'c'],
      });
      expect(detectStuck(ctx)).toBeNull();
    });

    it('surfaces the verifier output so the real (environment) cause is visible', () => {
      const ctx = makeCtx({
        verifierEvaluableHistory: [false, false],
        lastVerdict: {
          pass: false,
          confidence: 1,
          detail: 'npm test: the verify command could not run (exit 127)',
          evaluable: false,
        },
      });
      expect(detectStuck(ctx)?.message).toContain('could not run (exit 127)');
    });

    it('honors a custom threshold', () => {
      const below = makeCtx({
        config: makeConfig({ stuckPolicy: { unevaluableThreshold: 3 } }),
        verifierEvaluableHistory: [false, false],
      });
      expect(detectStuck(below)).toBeNull();
      const tripped = makeCtx({
        config: makeConfig({ stuckPolicy: { unevaluableThreshold: 3 } }),
        verifierEvaluableHistory: [false, false, false],
      });
      expect(detectStuck(tripped)?.kind).toBe('unevaluable');
    });

    it('wins over the no-diff a checker-that-cannot-run leaves on an unchanged tree', () => {
      // The exact incident: the verify command could not run, so the tree was left unchanged and the
      // could-not-run verdict repeated. The unevaluable cause must win over the misleading no-diff /
      // repeat-failure that would otherwise blame (and discard) a possibly-correct tree.
      const ctx = makeCtx({
        lastNoDiff: true,
        iteration: 2,
        lastRunStatus: 'completed',
        verifierEvaluableHistory: [false, false],
        verifierDetailHistory: ['cannot run', 'cannot run'],
      });
      const reason = detectStuck(ctx);
      expect(reason?.kind).toBe('unevaluable');
      expect(reason?.message).toContain('CONTRACT_UNEVALUABLE');
      expect(reason?.message).not.toContain('no-diff');
    });

    it('still yields to a harness crash (the more upstream environment failure)', () => {
      const ctx = makeCtx({
        runStatusHistory: ['crashed', 'crashed'],
        verifierEvaluableHistory: [false, false],
      });
      expect(detectStuck(ctx)?.kind).toBe('crash');
    });
  });

  describe('budget', () => {
    it('fires when the meter reports exceeded, regardless of iteration', () => {
      const ctx = makeCtx({ iteration: 0, lastBudget: { exceeded: true } });
      const reason = detectStuck(ctx);
      expect(reason?.kind).toBe('budget');
      expect(reason?.message).toBe('budget exceeded');
    });

    it('takes priority over other detectors', () => {
      const ctx = makeCtx({
        lastNoDiff: true,
        diffHashHistory: dh('a', 'b', 'a', 'b'),
        verifierDetailHistory: ['same', 'same', 'same'],
        runStatusHistory: ['crashed', 'crashed'],
        lastBudget: { exceeded: true },
      });
      expect(detectStuck(ctx)?.message).toBe('budget exceeded');
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
