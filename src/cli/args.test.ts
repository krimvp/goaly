import { describe, it, expect } from 'vitest';
import { parseArgs, UsageError } from './args';

describe('parseArgs', () => {
  it('parses a run with an existing verify command', () => {
    const a = parseArgs(['run', '--goal', 'do x', '--verify-cmd', 'npm test']);
    expect(a.command).toBe('run');
    expect(a.config.goal).toBe('do x');
    expect(a.config.verifier).toEqual({ kind: 'existing', ref: 'npm test' });
    expect(a.harness).toBe('claude-code');
  });

  it('supports the --key=value form', () => {
    const a = parseArgs(['run', '--goal=do y', '--verify-cmd=true']);
    expect(a.config.goal).toBe('do y');
    expect(a.config.verifier).toEqual({ kind: 'existing', ref: 'true' });
  });

  it('parses generate + intent + autonomous + numeric/harness/workspace flags', () => {
    const a = parseArgs([
      'run', '--goal', 'g', '--generate', '--intent', 'write tests',
      '--autonomous', '--max-iterations', '7', '--harness', 'codex', '--workspace', '/tmp/x',
    ]);
    expect(a.config.verifier).toEqual({ kind: 'generate', intent: 'write tests' });
    expect(a.config.autonomous).toBe(true);
    expect(a.config.maxIterations).toBe(7);
    expect(a.harness).toBe('codex');
    expect(a.workspace).toBe('/tmp/x');
  });

  it('returns help for no args and for the help command', () => {
    expect(parseArgs([]).command).toBe('help');
    expect(parseArgs(['help']).command).toBe('help');
    expect(parseArgs(['--help']).command).toBe('help');
  });

  it('throws UsageError on an unknown command', () => {
    expect(() => parseArgs(['frobnicate'])).toThrow(UsageError);
  });

  it('throws UsageError on an unknown harness', () => {
    expect(() =>
      parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--harness', 'bogus']),
    ).toThrow(UsageError);
  });

  it('rejects a run without a goal', () => {
    expect(() => parseArgs(['run', '--verify-cmd', 'true'])).toThrow();
  });

  it('captures --resume runId', () => {
    const a = parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--resume', 'run-123']);
    expect(a.resumeRunId).toBe('run-123');
  });
});
