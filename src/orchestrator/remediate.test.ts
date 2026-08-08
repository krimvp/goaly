import { describe, it, expect } from 'vitest';
import { decide } from './decide';
import { planRemediation, MAX_STUCK_REMEDIATIONS, REMEDIATION_MARKER } from './remediate';
import { NO_REMEDIATIONS } from './state';
import { makeCtx, makeConfig, failVerdict, passVerdict, veto, dh } from '../testing/fakes';

/**
 * Bounded stuck self-recovery (improvement plan 4.2), reducer-level: each remediable kind is
 * converted into exactly ONE guided CONTINUE, the spend is banked in the ledger, and the second
 * occurrence aborts. CONTRACT_UNEVALUABLE / budget / oscillation are never remediated.
 */

const remediateConfig = (overrides = {}) =>
  makeConfig({ stuckPolicy: { autoRemediate: true }, ...overrides });

describe('planRemediation (pure policy)', () => {
  it('is inert when --auto-remediate-stuck is off', () => {
    const ctx = makeCtx();
    expect(planRemediation(ctx, { kind: 'no-diff', message: 'no-diff' })).toBeNull();
  });

  it('each remediable kind is granted once, then refused', () => {
    const ctx = makeCtx({ config: remediateConfig() });
    for (const kind of ['no-diff', 'repeat', 'crash'] as const) {
      const first = planRemediation(ctx, { kind, message: kind });
      expect(first).not.toBeNull();
      expect(first?.feedback).toContain(REMEDIATION_MARKER);
      const spent = makeCtx({ config: remediateConfig(), remediations: first!.ledger });
      expect(planRemediation(spent, { kind, message: kind })).toBeNull();
    }
  });

  it('never remediates unevaluable / budget / oscillation', () => {
    const ctx = makeCtx({ config: remediateConfig() });
    for (const kind of ['unevaluable', 'budget', 'oscillation'] as const) {
      expect(planRemediation(ctx, { kind, message: kind })).toBeNull();
    }
  });

  it('refuses past the per-run cap even for an unspent kind', () => {
    const ctx = makeCtx({
      config: remediateConfig(),
      remediations: { total: MAX_STUCK_REMEDIATIONS, noDiff: 1, repeat: 1, crash: 1 },
    });
    expect(planRemediation(ctx, { kind: 'no-diff', message: 'no-diff' })).toBeNull();
  });
});

describe('decide with auto-remediation', () => {
  it('a first no-diff CONTINUEs with the canned hint instead of aborting', () => {
    const ctx = makeCtx({ config: remediateConfig(), lastNoDiff: true });
    const decision = decide(ctx, failVerdict(), null);
    expect(decision.kind).toBe('CONTINUE');
    if (decision.kind !== 'CONTINUE') throw new Error('unreachable');
    expect(decision.feedback).toContain(`${REMEDIATION_MARKER} 1/${MAX_STUCK_REMEDIATIONS} (no-diff)`);
    expect(decision.remediation).toEqual({ total: 1, noDiff: 1, repeat: 0, crash: 0 });
  });

  it('a second no-diff aborts, and the reason counts the spent remediation', () => {
    const ctx = makeCtx({
      config: remediateConfig(),
      lastNoDiff: true,
      remediations: { total: 1, noDiff: 1, repeat: 0, crash: 0 },
    });
    const decision = decide(ctx, failVerdict(), null);
    expect(decision.kind).toBe('ABORTED');
    if (decision.kind !== 'ABORTED') throw new Error('unreachable');
    expect(decision.reason).toContain('no-diff');
    expect(decision.reason).toContain('auto-remediation: 1 self-recovery attempt(s) already spent');
  });

  it('the spent no-diff remediation refunds the burned iteration at the cap', () => {
    // iteration == maxIterations would normally FAIL; the noDiff credit buys the retry turn.
    const config = remediateConfig({ maxIterations: 3 });
    const atCap = makeCtx({
      config,
      iteration: 3,
      remediations: { total: 1, noDiff: 1, repeat: 0, crash: 0 },
      diffHashHistory: dh('a', 'b', 'c'),
    });
    const decision = decide(atCap, failVerdict('still red'), null);
    expect(decision.kind).toBe('CONTINUE'); // 3 >= 3 + 1 is false — one extra turn granted
    const pastCredit = makeCtx({
      config,
      iteration: 4,
      remediations: { total: 1, noDiff: 1, repeat: 0, crash: 0 },
      diffHashHistory: dh('a', 'b', 'c', 'd'),
    });
    expect(decide(pastCredit, failVerdict('still red'), null).kind).toBe('FAILED');
  });

  it('a repeat-failure streak gets exactly one extra attempt via the raised threshold', () => {
    const config = remediateConfig();
    const threshold = config.stuckPolicy.repeatFailureThreshold;
    const streak = Array.from({ length: threshold }, () => 'same failure');
    const first = decide(
      makeCtx({ config, verifierDetailHistory: streak, diffHashHistory: dh('a', 'b', 'c') }),
      failVerdict('same failure'),
      null,
    );
    expect(first.kind).toBe('CONTINUE');
    if (first.kind !== 'CONTINUE') throw new Error('unreachable');
    expect(first.feedback).toContain('(repeat-failure)');

    // With the remediation spent, threshold+1 identical failures abort (effective threshold met).
    const second = decide(
      makeCtx({
        config,
        verifierDetailHistory: [...streak, 'same failure'],
        diffHashHistory: dh('a', 'b', 'c', 'd'),
        remediations: first.remediation!,
      }),
      failVerdict('same failure'),
      null,
    );
    expect(second.kind).toBe('ABORTED');
  });

  it('a crash streak gets exactly one extra attempt via the raised threshold', () => {
    const config = remediateConfig();
    const threshold = config.stuckPolicy.harnessCrashThreshold;
    const crashes = Array.from({ length: threshold }, () => 'crashed' as const);
    const first = decide(
      makeCtx({ config, runStatusHistory: crashes, lastRunStatus: 'crashed' }),
      failVerdict('harness crashed'),
      null,
    );
    expect(first.kind).toBe('CONTINUE');
    if (first.kind !== 'CONTINUE') throw new Error('unreachable');
    expect(first.feedback).toContain('(harness-crash)');

    const second = decide(
      makeCtx({
        config,
        runStatusHistory: [...crashes, 'crashed'],
        lastRunStatus: 'crashed',
        remediations: first.remediation!,
      }),
      failVerdict('harness crashed'),
      null,
    );
    expect(second.kind).toBe('ABORTED');
  });

  it('CONTRACT_UNEVALUABLE aborts even with remediation enabled', () => {
    const config = remediateConfig();
    const threshold = config.stuckPolicy.unevaluableThreshold;
    const decision = decide(
      makeCtx({
        config,
        verifierEvaluableHistory: Array.from({ length: threshold }, () => false),
      }),
      { ...failVerdict('verify command could not run'), evaluable: false },
      null,
    );
    expect(decision.kind).toBe('ABORTED');
    if (decision.kind !== 'ABORTED') throw new Error('unreachable');
    expect(decision.reason).toContain('CONTRACT_UNEVALUABLE');
  });

  it('the fresh-veto no-diff excuse still wins over remediation (no ledger spend)', () => {
    const ctx = makeCtx({ config: remediateConfig(), lastNoDiff: true, feedbackSource: 'verifier' });
    const decision = decide(ctx, passVerdict(), veto('needs a test'));
    expect(decision.kind).toBe('CONTINUE');
    if (decision.kind !== 'CONTINUE') throw new Error('unreachable');
    expect(decision.remediation).toBeUndefined();
    expect(decision.source).toBe('veto');
    expect(decision.feedback).toBe('needs a test');
  });

  it('without the flag, behavior is byte-for-byte the historical abort', () => {
    const ctx = makeCtx({ lastNoDiff: true });
    const decision = decide(ctx, failVerdict(), null);
    expect(decision.kind).toBe('ABORTED');
    if (decision.kind !== 'ABORTED') throw new Error('unreachable');
    expect(decision.reason).toBe('no-diff: working tree unchanged after an iteration');
  });
});
