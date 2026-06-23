import { describe, it, expect } from 'vitest';
import { decide } from './decide';
import {
  makeCtx,
  makeConfig,
  passVerdict,
  failVerdict,
  veto,
  approve,
  dh,
} from '../testing/fakes';

describe('DECIDE truth table', () => {
  it('ladder pass + no veto → DONE (two keys turned)', () => {
    const d = decide(makeCtx(), passVerdict(), approve());
    expect(d).toEqual({ kind: 'DONE' });
  });

  it('ladder fail → CONTINUE with verifier detail as feedback', () => {
    const d = decide(makeCtx(), failVerdict('tests are red'), null);
    expect(d).toEqual({ kind: 'CONTINUE', feedback: 'tests are red' });
  });

  it('ladder pass + veto → CONTINUE with veto reason as feedback', () => {
    const d = decide(makeCtx(), passVerdict(), veto('the test is empty'));
    expect(d).toEqual({ kind: 'CONTINUE', feedback: 'the test is empty' });
  });

  it('DONE wins over maxIterations (goal met on the last allowed iteration)', () => {
    const ctx = makeCtx({ config: makeConfig({ maxIterations: 2 }), iteration: 2 });
    expect(decide(ctx, passVerdict(), approve())).toEqual({ kind: 'DONE' });
  });

  it('DONE wins over an exceeded budget (success is success)', () => {
    const ctx = makeCtx({ lastBudget: { exceeded: true } });
    expect(decide(ctx, passVerdict(), approve())).toEqual({ kind: 'DONE' });
  });

  it('would-be CONTINUE becomes FAILED at maxIterations', () => {
    const ctx = makeCtx({ config: makeConfig({ maxIterations: 1 }), iteration: 1 });
    const d = decide(ctx, failVerdict('still red'), null);
    expect(d.kind).toBe('FAILED');
  });

  it('the maxIterations backstop also overrides a veto-CONTINUE', () => {
    const ctx = makeCtx({ config: makeConfig({ maxIterations: 1 }), iteration: 1 });
    const d = decide(ctx, passVerdict(), veto('not really done'));
    expect(d.kind).toBe('FAILED');
  });

  it('stuck (no-diff) → ABORTED, preferred over the hard cap for its reason', () => {
    const ctx = makeCtx({
      config: makeConfig({ maxIterations: 1 }),
      iteration: 1,
      lastNoDiff: true,
    });
    const d = decide(ctx, failVerdict(), null);
    expect(d.kind).toBe('ABORTED');
    if (d.kind === 'ABORTED') expect(d.reason).toContain('no-diff');
  });

  it('ladder-green + fresh veto + one no-diff iteration → CONTINUE, not ABORTED (issue #54)', () => {
    // The agent made no edits for one iteration, but the only blocker is a brand-new Sign-off veto it
    // has not yet seen — it must get one real turn to act on the (correct) critique first.
    const ctx = makeCtx({ iteration: 1, lastNoDiff: true, feedback: undefined });
    const d = decide(ctx, passVerdict(), veto('power-ups are inert'));
    expect(d).toEqual({ kind: 'CONTINUE', feedback: 'power-ups are inert' });
  });

  it('a SECOND unproductive no-diff on the same veto → ABORTED (issue #54)', () => {
    // The agent was already told this veto last turn (feedback === reason) and still made no edits.
    const ctx = makeCtx({ iteration: 2, lastNoDiff: true, feedback: 'power-ups are inert' });
    const d = decide(ctx, passVerdict(), veto('power-ups are inert'));
    expect(d.kind).toBe('ABORTED');
    if (d.kind === 'ABORTED') expect(d.reason).toContain('no-diff');
  });

  it('a turn killed by timeout does not immediately trip no-diff (issue #54)', () => {
    const ctx = makeCtx({ iteration: 1, lastNoDiff: true, lastRunStatus: 'timeout' });
    const d = decide(ctx, failVerdict('still red'), null);
    expect(d).toEqual({ kind: 'CONTINUE', feedback: 'still red' });
  });

  it('stuck (oscillation) → ABORTED', () => {
    const ctx = makeCtx({ diffHashHistory: dh('a', 'b', 'a', 'b'), lastNoDiff: false });
    const d = decide(ctx, failVerdict(), null);
    expect(d.kind).toBe('ABORTED');
    if (d.kind === 'ABORTED') expect(d.reason).toContain('oscillation');
  });
});
