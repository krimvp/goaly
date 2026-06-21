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
    expect(verdict).toEqual({ pass: true, confidence: 1, detail: 'all 0 checks passed' });
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
    expect(verdict).toEqual({ pass: true, confidence: 0.6, detail: 'all 3 checks passed' });
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

    // Assert: the exact failing verdict is returned, no judge call wasted.
    expect(verdict).toEqual({ pass: false, confidence: 1, detail: 'tests failed' });
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
    expect(verdict).toEqual({ pass: false, confidence: 0.33, detail: 'quorum not met' });
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
    expect(verdict).toEqual({ pass: true, confidence: 1, detail: 'all 2 checks passed' });
  });
});
