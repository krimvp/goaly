import { describe, it, expect } from 'vitest';
import { namesFrozenFile, normalizeRel } from './frozen-paths';

/**
 * The dry run's collision drop must answer "would this reference file land on the frozen bar?" over
 * the SAME canonical form `FsScratchCopy.writeFile` resolves. When it compared path STRINGS while
 * the write side compared RESOLVED paths, a reference file spelled `verify/./check.test.mjs` was
 * judged UNFROZEN when written — so it overwrote the frozen bar in the scratch copy, turning a
 * provably unsatisfiable bar into a green.
 *
 * (The output-sanitizing half of the old `rung-output` module is gone: the refusal no longer reads
 * the scratch subprocess's streams at all, so there is nothing left to filter. See
 * `dry-run-refusal.test.ts`.)
 */
describe('namesFrozenFile — the write side and the frozen set canonicalize identically', () => {
  const FROZEN_BAR = ['verify/check.test.mjs'];

  it.each([
    'verify/./check.test.mjs',
    'verify//check.test.mjs',
    './verify/./check.test.mjs',
    'verify/check.test.mjs/.',
    'verify/sub/../check.test.mjs',
    '  verify/./check.test.mjs  ',
  ])('treats %j as the frozen file it resolves onto', (spelling) => {
    expect(namesFrozenFile(spelling, FROZEN_BAR)).toBe(true);
  });

  it('normalizes both sides, so a frozen entry spelled oddly still matches', () => {
    expect(namesFrozenFile('verify/check.test.mjs', ['verify/./check.test.mjs'])).toBe(true);
    expect(normalizeRel('verify/./check.test.mjs')).toBe('verify/check.test.mjs');
    expect(normalizeRel('./a//b/')).toBe('a/b');
  });

  it('matches a path SUFFIX too — the refusal side of an ambiguous name is the safe one', () => {
    // A frozen `check.mjs` and a reference `src/check.mjs`: dropping the reference costs a file the
    // control might have used; writing it would rewrite the assertions under test.
    expect(namesFrozenFile('src/check.mjs', ['check.mjs'])).toBe(true);
  });

  it('still refuses a merely similar path', () => {
    expect(namesFrozenFile('verify/check.test.mjs.bak', FROZEN_BAR)).toBe(false);
    expect(namesFrozenFile('src/other.mjs', FROZEN_BAR)).toBe(false);
    expect(namesFrozenFile('verify/check.test.mjs', [''])).toBe(false);
  });
});
