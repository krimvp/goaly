import { describe, it, expect } from 'vitest';
import { Ladder } from './ladder';
import type { Verifier } from './verifier';
import type { Verdict } from '../domain/verdict';
import { FakeWorkspace } from '../testing/fakes';

const ws = new FakeWorkspace();
const GOAL = 'make the thing work';
const RUBRIC = 'it works';

/** Inline fake rung that returns a fixed verdict and records that it ran. */
function rung(verdict: Verdict): Verifier & { called: boolean } {
  const fake = {
    called: false,
    async verify(): Promise<Verdict> {
      fake.called = true;
      return verdict;
    },
  };
  return fake;
}

/** Inline fake rung that throws when invoked and records that it ran. */
function throwingRung(message: string): Verifier & { called: boolean } {
  const fake = {
    called: false,
    async verify(): Promise<Verdict> {
      fake.called = true;
      throw new Error(message);
    },
  };
  return fake;
}

describe('Ladder', () => {
  it('returns vacuous pass with confidence 1 for an empty rung list', async () => {
    // Arrange
    const ladder = new Ladder([]);

    // Act
    const verdict = await ladder.verify(ws, GOAL, RUBRIC);

    // Assert
    expect(verdict).toEqual({
      pass: true,
      confidence: 1,
      detail: 'all 0 checks passed',
      rungsPassed: 0,
      rungsTotal: 0,
    });
  });

  it('passes when all rungs pass and reports the minimum confidence', async () => {
    // Arrange
    const r1 = rung({ pass: true, confidence: 1, detail: 'det' });
    const r2 = rung({ pass: true, confidence: 0.8, detail: 'judge a' });
    const r3 = rung({ pass: true, confidence: 0.6, detail: 'judge b' });
    const ladder = new Ladder([r1, r2, r3]);

    // Act
    const verdict = await ladder.verify(ws, GOAL, RUBRIC);

    // Assert
    expect(verdict).toEqual({
      pass: true,
      confidence: 0.6,
      detail: 'all 3 checks passed',
      rungsPassed: 3,
      rungsTotal: 3,
    });
    expect(r1.called).toBe(true);
    expect(r2.called).toBe(true);
    expect(r3.called).toBe(true);
  });

  it('short-circuits on the first failing rung and does not run later rungs', async () => {
    // Arrange
    const fail = rung({ pass: false, confidence: 1, detail: 'tests failed' });
    const later = rung({ pass: true, confidence: 0.5, detail: 'judge' });
    const ladder = new Ladder([fail, later]);

    // Act
    const verdict = await ladder.verify(ws, GOAL, RUBRIC);

    // Assert: the exact failing verdict is returned (plus the depth score), no judge call wasted.
    expect(verdict).toEqual({
      pass: false,
      confidence: 1,
      detail: 'tests failed',
      rungsPassed: 0,
      rungsTotal: 2,
    });
    expect(fail.called).toBe(true);
    expect(later.called).toBe(false);
  });

  it('returns the failing verdict verbatim (fuzzy confidence preserved)', async () => {
    // Arrange
    const fail = rung({ pass: false, confidence: 0.33, detail: 'quorum not met' });
    const ladder = new Ladder([fail]);

    // Act
    const verdict = await ladder.verify(ws, GOAL, RUBRIC);

    // Assert
    expect(verdict).toEqual({
      pass: false,
      confidence: 0.33,
      detail: 'quorum not met',
      rungsPassed: 0,
      rungsTotal: 1,
    });
  });

  it('fail-closes when a rung throws and short-circuits later rungs', async () => {
    // Arrange
    const boom = throwingRung('grader exploded');
    const later = rung({ pass: true, confidence: 0.9, detail: 'judge' });
    const ladder = new Ladder([boom, later]);

    // Act
    const verdict = await ladder.verify(ws, GOAL, RUBRIC);

    // Assert
    expect(verdict).toEqual({
      pass: false,
      confidence: 1,
      detail: 'rung error (fail-closed): grader exploded',
      rungsPassed: 0,
      rungsTotal: 2,
    });
    expect(boom.called).toBe(true);
    expect(later.called).toBe(false);
  });

  it('fail-closes on a non-Error throw by stringifying it', async () => {
    // Arrange
    const ladder = new Ladder([
      {
        async verify(): Promise<Verdict> {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'string failure';
        },
      },
    ]);

    // Act
    const verdict = await ladder.verify(ws, GOAL, RUBRIC);

    // Assert
    expect(verdict.pass).toBe(false);
    expect(verdict.confidence).toBe(1);
    expect(verdict.detail).toBe('rung error (fail-closed): string failure');
  });

  it('passes deterministic rungs through with confidence 1 when none are fuzzy', async () => {
    // Arrange
    const r1 = rung({ pass: true, confidence: 1, detail: 'a' });
    const r2 = rung({ pass: true, confidence: 1, detail: 'b' });
    const ladder = new Ladder([r1, r2]);

    // Act
    const verdict = await ladder.verify(ws, GOAL, RUBRIC);

    // Assert
    expect(verdict).toEqual({
      pass: true,
      confidence: 1,
      detail: 'all 2 checks passed',
      rungsPassed: 2,
      rungsTotal: 2,
    });
  });

  describe('graded depth scoring — rungsPassed / rungsTotal (issue #85)', () => {
    it('reports rungsPassed === rungsTotal on an all-pass ladder', async () => {
      const ladder = new Ladder([
        rung({ pass: true, confidence: 1, detail: 'a' }),
        rung({ pass: true, confidence: 1, detail: 'b' }),
        rung({ pass: true, confidence: 1, detail: 'c' }),
      ]);

      const verdict = await ladder.verify(ws, GOAL, RUBRIC);

      expect(verdict.pass).toBe(true);
      expect(verdict.rungsPassed).toBe(3);
      expect(verdict.rungsTotal).toBe(3);
    });

    it('reports rungsPassed = the short-circuit index when a middle rung fails', async () => {
      const r0 = rung({ pass: true, confidence: 1, detail: 'a' });
      const r1 = rung({ pass: true, confidence: 1, detail: 'b' });
      const r2 = rung({ pass: false, confidence: 1, detail: 'c failed' }); // fails at index 2
      const r3 = rung({ pass: true, confidence: 1, detail: 'd' });
      const ladder = new Ladder([r0, r1, r2, r3]);

      const verdict = await ladder.verify(ws, GOAL, RUBRIC);

      // Two rungs (indices 0, 1) passed before the index-2 failure short-circuited; rung 3 never ran.
      expect(verdict.pass).toBe(false);
      expect(verdict.rungsPassed).toBe(2);
      expect(verdict.rungsTotal).toBe(4);
      expect(r3.called).toBe(false);
    });

    it('reports rungsPassed = the index of a THROWING rung (rungs before the throw passed)', async () => {
      const r0 = rung({ pass: true, confidence: 1, detail: 'a' });
      const boom = throwingRung('grader exploded'); // throws at index 1
      const r2 = rung({ pass: true, confidence: 1, detail: 'c' });
      const ladder = new Ladder([r0, boom, r2]);

      const verdict = await ladder.verify(ws, GOAL, RUBRIC);

      expect(verdict.pass).toBe(false);
      expect(verdict.rungsPassed).toBe(1); // only rung 0 passed before the throw
      expect(verdict.rungsTotal).toBe(3);
      expect(r2.called).toBe(false);
    });
  });
});
