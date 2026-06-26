import { describe, it, expect } from 'vitest';
import { RunConfig, CliInput, cliInputToRunConfig } from './config';

describe('RunConfig', () => {
  it('applies defaults for the optional fields', () => {
    const c = RunConfig.parse({ goal: 'g', verifier: { kind: 'existing', ref: 'npm test' } });
    expect(c.autonomous).toBe(false);
    expect(c.installMissingTools).toBe(true);
    expect(c.maxIterations).toBe(10);
    expect(c.maxSealRevisions).toBe(10);
    expect(c.stuckPolicy).toEqual({
      noDiff: true,
      repeatFailureThreshold: 3,
      oscillation: true,
      harnessCrashThreshold: 2,
    });
    expect(c.judge).toEqual({ quorum: 3, confidenceFloor: 0.66 });
    expect(c.diffIgnore).toEqual([]);
  });

  it('rejects an empty goal', () => {
    expect(() => RunConfig.parse({ goal: '', verifier: { kind: 'generate' } })).toThrow();
  });

  it('rejects a non-positive maxIterations', () => {
    expect(() =>
      RunConfig.parse({ goal: 'g', verifier: { kind: 'generate' }, maxIterations: 0 }),
    ).toThrow();
  });

  it('accepts maxSealRevisions: 0 (revision disabled) but rejects negatives', () => {
    const c = RunConfig.parse({
      goal: 'g',
      verifier: { kind: 'generate' },
      maxSealRevisions: 0,
    });
    expect(c.maxSealRevisions).toBe(0);
    expect(() =>
      RunConfig.parse({ goal: 'g', verifier: { kind: 'generate' }, maxSealRevisions: -1 }),
    ).toThrow();
  });
});

describe('cliInputToRunConfig', () => {
  it('maps a verify command to an existing verifier', () => {
    const input = CliInput.parse({ goal: 'g', verifyCmd: 'npm test' });
    const c = cliInputToRunConfig(input);
    expect(c.verifier).toEqual({ kind: 'existing', ref: 'npm test' });
  });

  it('uses a generate verifier when --generate is set, carrying the intent', () => {
    const input = CliInput.parse({ goal: 'g', generate: 'true', intent: 'add a vitest' });
    const c = cliInputToRunConfig(input);
    expect(c.verifier).toEqual({ kind: 'generate', intent: 'add a vitest' });
  });

  it('coerces numeric and boolean flags from strings (argv is stringly typed)', () => {
    const input = CliInput.parse({
      goal: 'g',
      verifyCmd: 'true',
      autonomous: 'true',
      maxIterations: '5',
      maxSealRevisions: '3',
      budgetTokens: '1000',
    });
    const c = cliInputToRunConfig(input);
    expect(c.autonomous).toBe(true);
    expect(c.maxIterations).toBe(5);
    expect(c.maxSealRevisions).toBe(3);
    expect(c.budget.tokens).toBe(1000);
  });

  it('defaults to a generate verifier when no command is given', () => {
    const c = cliInputToRunConfig(CliInput.parse({ goal: 'g' }));
    expect(c.verifier.kind).toBe('generate');
  });

  it('splits a comma-separated --diff-ignore into trimmed paths', () => {
    const input = CliInput.parse({ goal: 'g', verifyCmd: 'true', diffIgnore: 'coverage, __pycache__ ,dist' });
    const c = cliInputToRunConfig(input);
    expect(c.diffIgnore).toEqual(['coverage', '__pycache__', 'dist']);
  });

  it('omits diffIgnore (defaults to []) when the flag is absent or blank', () => {
    expect(cliInputToRunConfig(CliInput.parse({ goal: 'g', verifyCmd: 'true' })).diffIgnore).toEqual(
      [],
    );
    expect(
      cliInputToRunConfig(CliInput.parse({ goal: 'g', verifyCmd: 'true', diffIgnore: ' , ' }))
        .diffIgnore,
    ).toEqual([]);
  });
});
