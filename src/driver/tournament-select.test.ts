import { describe, it, expect } from 'vitest';
import { selectWinner, type CandidateResult } from './tournament';
import { DiffHash, SessionId } from '../domain/ids';
import type { HarnessRunResult } from '../domain/events';

const tree = (s: string): DiffHash => DiffHash.parse(s.padStart(7, '0'));

function run(status: HarnessRunResult['status'] = 'completed'): HarnessRunResult {
  return { output: '', sessionId: SessionId.parse('s'), status };
}

function cand(
  index: number,
  pass: boolean,
  tokens: number | undefined,
  status: HarnessRunResult['status'] = 'completed',
): CandidateResult {
  return {
    index,
    pass,
    tree: tree(String(index + 1)),
    budget: { exceeded: false, ...(tokens !== undefined ? { tokensSpent: tokens } : {}) },
    run: run(status),
  };
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
