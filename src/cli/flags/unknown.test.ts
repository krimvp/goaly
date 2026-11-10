import { describe, it, expect } from 'vitest';
import { closestName, rejectUnknownFlags } from './unknown';
import { UsageError } from './tokens';
import { parseArgs } from '../args';

describe('rejectUnknownFlags', () => {
  it('accepts documented flags, including the canonicalized alias', () => {
    expect(() =>
      rejectUnknownFlags({ goal: 'g', 'max-iterations': '3', autonomous: true, 'best-of': '2' }),
    ).not.toThrow();
  });

  it('rejects a typo, naming it and pointing at the help', () => {
    expect(() => rejectUnknownFlags({ goal: 'g', 'budget-token': '500000' })).toThrow(UsageError);
    expect(() => rejectUnknownFlags({ goal: 'g', 'budget-token': '500000' })).toThrow(
      /unknown flag: --budget-token — did you mean --budget-tokens\?/,
    );
  });

  it('names every unknown flag at once', () => {
    expect(() => rejectUnknownFlags({ 'max-iteratons': '3', 'nonsense-flag': 'x' })).toThrow(
      /--max-iteratons, --nonsense-flag/,
    );
  });

  it('with a scope, lists only the flags that subcommand accepts', () => {
    expect(() =>
      rejectUnknownFlags({ bogus: true }, { command: 'doctor', known: ['base-url', 'workspace'] }),
    ).toThrow('unknown flag: --bogus — goaly doctor accepts --base-url, --workspace');
  });
});

describe('closestName', () => {
  it('finds a near miss, reads camelCase as kebab-case, and rejects a far word', () => {
    expect(closestName('gaol', ['goal', 'rubric'])).toBe('goal');
    expect(closestName('maxIterations', ['max-iterations'])).toBe('max-iterations');
    expect(closestName('refactor', ['run', 'runs', 'doctor', 'init'])).toBeUndefined();
  });
});

describe('subcommands reject flags they do not accept', () => {
  it.each([
    [['doctor', '--bogus']],
    [['init', '--harnes', 'codex', '--yes']],
    [['runs', 'list', '--worksapce', '/x']],
    [['runs', 'show', 'run-1', '--json']],
    [['worktree', 'remove', 'wt', '--delete']],
    [['ui', '--prot', '8080']],
    [['config', 'presets', '--name']],
  ])('%j', async (argv) => {
    await expect(parseArgs(argv)).rejects.toThrow(/unknown flag/);
  });

  it('names the intended init flag', async () => {
    await expect(parseArgs(['init', '--harnes', 'codex'])).rejects.toThrow(/did you mean --harness\?/);
  });
});

describe('a mistyped subcommand is not taken as a goal', () => {
  it.each([['doctr', 'doctor'], ['runz', 'runs'], ['int', 'init'], ['confg', 'config']])(
    'goaly %s → did you mean goaly %s',
    async (typo, sub) => {
      await expect(parseArgs([typo])).rejects.toThrow(`did you mean 'goaly ${sub}'?`);
    },
  );

  it('still accepts a one-word goal that is not near a subcommand, and --goal for any word', async () => {
    expect((await parseArgs(['refactor', '--verify-cmd', 'true'])).config.goal).toBe('refactor');
    expect((await parseArgs(['--goal', 'doctr', '--verify-cmd', 'true'])).config.goal).toBe('doctr');
  });
});
