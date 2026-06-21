import { describe, it, expect } from 'vitest';
import { freezeContract, hashContract } from './hash';
import type { UnhashedContract } from '../domain/contract';

const base: UnhashedContract = {
  goal: 'make it work',
  rungs: [
    { kind: 'deterministic', command: 'npm test' },
    { kind: 'judge', rubric: 'is it clear?', quorum: 3, confidenceFloor: 0.66 },
  ],
  rubric: 'overall rubric',
  generatedFiles: ['b.test.ts', 'a.test.ts'],
};

describe('contract hashing', () => {
  it('is deterministic for identical content', () => {
    expect(hashContract(base)).toBe(hashContract({ ...base }));
  });

  it('is stable regardless of generatedFiles ordering (canonicalized)', () => {
    const reordered: UnhashedContract = { ...base, generatedFiles: ['a.test.ts', 'b.test.ts'] };
    expect(hashContract(reordered)).toBe(hashContract(base));
  });

  it('changes when the bar changes (a rung command is weakened)', () => {
    const weakened: UnhashedContract = {
      ...base,
      rungs: [{ kind: 'deterministic', command: 'true' }],
    };
    expect(hashContract(weakened)).not.toBe(hashContract(base));
  });

  it('freezeContract attaches a valid hash and parses', () => {
    const frozen = freezeContract(base);
    expect(frozen.contractHash).toBe(hashContract(base));
    expect(frozen.rungs).toHaveLength(2);
  });
});
