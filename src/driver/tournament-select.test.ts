import { describe, it, expect } from 'vitest';
import { selectWinner, type CandidateResult } from './tournament';
import { DiffHash, SessionId } from '../domain/ids';
import type { HarnessRunResult } from '../domain/events';

const tree = (s: string): DiffHash => DiffHash.parse(s.padStart(7, '0'));

function run(status: HarnessRunResult['status'] = 'completed'): HarnessRunResult {
  return { output: '', sessionId: SessionId.parse('s'), status };
}

/**
 * A candidate at a fixed ladder depth (issue #85 graded ranking). `pass` is derived from depth
 * (`rungsPassed === rungsTotal`), so a boolean caller still works: a `true` is maximal depth, a
 * `false` is a shallow (depth-0) red. The graded tests pass `rungsPassed`/`rungsTotal` explicitly.
 */
function cand(
  index: number,
  pass: boolean,
  tokens: number | undefined,
  status: HarnessRunResult['status'] = 'completed',
  depth?: { rungsPassed: number; rungsTotal: number },
): CandidateResult {
  const rungsTotal = depth?.rungsTotal ?? 3;
  const rungsPassed = depth?.rungsPassed ?? (pass ? rungsTotal : 0);
  return {
    index,
    pass: rungsPassed === rungsTotal,
    rungsPassed,
    rungsTotal,
    tree: tree(String(index + 1)),
    budget: { exceeded: false, ...(tokens !== undefined ? { tokensSpent: tokens } : {}) },
    run: run(status),
  };
}

/** Sugar for a graded candidate at an explicit ladder depth (rungsPassed of rungsTotal). */
function graded(
  index: number,
  rungsPassed: number,
  rungsTotal: number,
  tokens: number | undefined,
): CandidateResult {
  return cand(index, rungsPassed === rungsTotal, tokens, 'completed', { rungsPassed, rungsTotal });
}

describe('selectWinner — the pure best-of-N tournament rule (issue #85)', () => {
  it('a passing candidate beats any failing one, regardless of cost or index', () => {
    const winner = selectWinner([
      cand(0, false, 1), // failing but cheap + lowest index
      cand(1, true, 9999), // passing but expensive
      cand(2, false, 1),
    ]);
    expect(winner.index).toBe(1);
    expect(winner.pass).toBe(true);
  });

  it('among passing candidates, lower cost wins', () => {
    const winner = selectWinner([
      cand(0, true, 500),
      cand(1, true, 100),
      cand(2, true, 300),
    ]);
    expect(winner.index).toBe(1);
  });

  it('ties on cost break to the lowest index (stable)', () => {
    const winner = selectWinner([
      cand(0, true, 200),
      cand(1, true, 200),
      cand(2, true, 200),
    ]);
    expect(winner.index).toBe(0);
  });

  it('all fail → the least-cost failing candidate wins (a normal red iteration)', () => {
    const winner = selectWinner([
      cand(0, false, 800),
      cand(1, false, 200),
      cand(2, false, 500),
    ]);
    expect(winner.index).toBe(1);
    expect(winner.pass).toBe(false);
  });

  it('a candidate with unknown cost sorts as most-expensive (loses cost tie-breaks)', () => {
    const winner = selectWinner([
      cand(0, true, undefined), // unknown spend
      cand(1, true, 50),
    ]);
    expect(winner.index).toBe(1);
  });

  it('a crashed/timeout candidate scored as a hard red cannot win on merit', () => {
    const winner = selectWinner([
      cand(0, false, 1, 'crashed'), // cheapest but red
      cand(1, true, 9000, 'completed'),
    ]);
    expect(winner.index).toBe(1);
  });

  it('a single candidate is trivially the winner', () => {
    const winner = selectWinner([cand(0, false, 10)]);
    expect(winner.index).toBe(0);
  });

  it('throws on an empty set (the Driver guards this as an all-red iteration upstream)', () => {
    expect(() => selectWinner([])).toThrow();
  });
});

describe('selectWinner — graded "furthest up the ladder wins" ranking (issue #85 follow-up)', () => {
  it('a candidate that got further up the ladder beats a shallower one EVEN at higher cost', () => {
    const winner = selectWinner([
      graded(0, 1, 4, 100), // cheap but stalled at rung 1
      graded(1, 3, 4, 9999), // expensive but got to rung 3
    ]);
    // Depth is the PRIMARY key — the deeper (but pricier) candidate wins; both still FAIL the ladder.
    expect(winner.index).toBe(1);
    expect(winner.pass).toBe(false);
    expect(winner.rungsPassed).toBe(3);
  });

  it('an all-pass candidate beats any partial, regardless of cost or index', () => {
    const winner = selectWinner([
      graded(0, 3, 4, 1), // furthest partial, cheapest, lowest index — but still a red
      graded(1, 4, 4, 9999), // the only all-pass candidate (depth === total)
      graded(2, 2, 4, 1),
    ]);
    expect(winner.index).toBe(1);
    expect(winner.pass).toBe(true);
  });

  it('two failing candidates are now distinguished by depth (the whole point of grading)', () => {
    // Old boolean rule: these two only differed by cost. Graded: the deeper one wins.
    const winner = selectWinner([
      graded(0, 0, 5, 100), // stalled immediately
      graded(1, 4, 5, 100), // got all the way to the last (failing) rung — same cost
    ]);
    expect(winner.index).toBe(1);
    expect(winner.rungsPassed).toBe(4);
  });

  it('ties on depth fall to lower cost, then lowest index (stable)', () => {
    const sameDepthCheaper = selectWinner([
      graded(0, 2, 4, 500),
      graded(1, 2, 4, 100), // same depth, cheaper → wins
      graded(2, 2, 4, 300),
    ]);
    expect(sameDepthCheaper.index).toBe(1);

    const sameDepthSameCost = selectWinner([
      graded(0, 2, 4, 200),
      graded(1, 2, 4, 200),
      graded(2, 2, 4, 200),
    ]);
    expect(sameDepthSameCost.index).toBe(0); // lowest index breaks the final tie
  });
});
