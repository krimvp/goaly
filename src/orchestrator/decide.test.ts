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
    expect(d).toEqual({ kind: 'CONTINUE', feedback: 'tests are red', source: 'verifier' });
  });

  it('ladder pass + veto → CONTINUE with veto reason as feedback', () => {
    const d = decide(makeCtx(), passVerdict(), veto('the test is empty'));
    expect(d).toEqual({ kind: 'CONTINUE', feedback: 'the test is empty', source: 'veto' });
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
    expect(d).toEqual({ kind: 'CONTINUE', feedback: 'power-ups are inert', source: 'veto' });
  });

  it('a SECOND unproductive no-diff on the same veto → ABORTED (issue #54)', () => {
    // The agent was already told this veto last turn (feedbackSource 'veto') and still made no edits.
    const ctx = makeCtx({
      iteration: 2,
      lastNoDiff: true,
      feedback: 'power-ups are inert',
      feedbackSource: 'veto',
    });
    const d = decide(ctx, passVerdict(), veto('power-ups are inert'));
    expect(d.kind).toBe('ABORTED');
    if (d.kind === 'ABORTED') expect(d.reason).toContain('no-diff');
  });

  it('a REWORDED veto after an unproductive no-diff still ABORTS — the excuse is per source, not per wording', () => {
    // Regression: an LLM approver rewords its veto every round. If freshness were keyed on the
    // reason TEXT, every veto would look fresh and a worker that never edits would burn the whole
    // iteration budget in approver spend. The excuse must not renew just because the words changed.
    const ctx = makeCtx({
      iteration: 2,
      lastNoDiff: true,
      feedback: 'the diff is empty and the goal is vague',
      feedbackSource: 'veto',
    });
    const d = decide(ctx, passVerdict(), veto('no evidence of any actual change was provided'));
    expect(d.kind).toBe('ABORTED');
    if (d.kind === 'ABORTED') expect(d.reason).toContain('no-diff');
  });

  it('a no-diff on a veto AFTER verifier-red feedback is excused — the just-run turn was not answering a veto', () => {
    // The turn that produced no diff was chewing on a red-ladder detail; the veto is genuinely new.
    const ctx = makeCtx({
      iteration: 2,
      lastNoDiff: true,
      feedback: 'tests are red',
      feedbackSource: 'verifier',
    });
    const d = decide(ctx, passVerdict(), veto('power-ups are inert'));
    expect(d).toEqual({ kind: 'CONTINUE', feedback: 'power-ups are inert', source: 'veto' });
  });

  it('a turn killed by timeout does not immediately trip no-diff (issue #54)', () => {
    const ctx = makeCtx({ iteration: 1, lastNoDiff: true, lastRunStatus: 'timeout' });
    const d = decide(ctx, failVerdict('still red'), null);
    expect(d).toEqual({ kind: 'CONTINUE', feedback: 'still red', source: 'verifier' });
  });

  it('stuck (oscillation) → ABORTED', () => {
    const ctx = makeCtx({ diffHashHistory: dh('a', 'b', 'a', 'b'), lastNoDiff: false });
    const d = decide(ctx, failVerdict(), null);
    expect(d.kind).toBe('ABORTED');
    if (d.kind === 'ABORTED') expect(d.reason).toContain('oscillation');
  });
});
