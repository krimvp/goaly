import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { renderCompletion, documentedFlags, SUBCOMMANDS, parseCompletionShell } from './completion';
import { parseArgs, USAGE, UsageError } from './args';

/**
 * Shell completion (improvement plan 3.3): the scripts must cover every documented flag and every
 * real subcommand — extracted from `USAGE`, the same contract the drift tests read — and the bash
 * script must actually parse.
 */

describe('documentedFlags', () => {
  it('contains the core run flags and the subcommand flags, deduped and sorted', () => {
    const flags = documentedFlags();
    for (const expected of ['--goal', '--verify-cmd', '--generate', '--harness', '--port', '--yes']) {
      expect(flags).toContain(expected);
    }
    expect(flags).toEqual([...flags].sort());
    expect(new Set(flags).size).toBe(flags.length);
  });

  it("excludes prose tokens that aren't goaly flags", () => {
    const flags = documentedFlags();
    for (const notAFlag of ['--rm', '--json', '--auto', '--stuck-', '--baseline-style']) {
      expect(flags).not.toContain(notAFlag);
    }
  });
});

describe('renderCompletion', () => {
  it.each(['bash', 'zsh', 'fish'] as const)('%s script names every flag and subcommand', (shell) => {
    const script = renderCompletion(shell);
    for (const flag of documentedFlags()) {
      // fish uses `-l flag-name` (no dashes); bash/zsh embed the flag verbatim.
      expect(script).toContain(shell === 'fish' ? `-l ${flag.slice(2)}` : flag);
    }
    for (const sub of SUBCOMMANDS) {
      expect(script).toContain(sub);
    }
  });

  it('every SUBCOMMANDS entry is a real parseArgs command word (none forgotten, none stale)', async () => {
    // Each listed word must be dispatched as a subcommand — i.e. NOT parsed as an implicit
    // run goal. An implicit run with an unparsable tail throws; a real subcommand never
    // treats its first word as a goal.
    for (const sub of SUBCOMMANDS) {
      if (sub === 'run') continue; // `run` IS the implicit command
      const parsed = await parseArgs([sub, ...(sub === 'completion' ? ['bash'] : ['list'])]).catch(
        (e: unknown) => e,
      );
      if (parsed instanceof Error) {
        // A UsageError mentioning the subcommand's own grammar is fine (e.g. `config list`);
        // reaching the run path (a goal/verify error) would mean the word is not a subcommand.
        expect(parsed).toBeInstanceOf(UsageError);
        expect((parsed as UsageError).message).toContain(sub === 'config' ? 'config' : sub);
      } else {
        expect((parsed as { command: string }).command).toBe(sub);
      }
    }
  });

  it('the subcommand synopsis in USAGE names every completable subcommand', () => {
    for (const sub of SUBCOMMANDS) {
      if (sub === 'run') continue;
      expect(USAGE).toContain(`goaly ${sub}`);
    }
  });

  it('the bash script parses under bash -n', () => {
    expect(() =>
      execFileSync('bash', ['-n'], { input: renderCompletion('bash'), encoding: 'utf8' }),
    ).not.toThrow();
  });
});

describe('parseCompletionShell', () => {
  it('accepts exactly bash/zsh/fish and fails closed otherwise', () => {
    expect(parseCompletionShell('bash')).toBe('bash');
    expect(parseCompletionShell('zsh')).toBe('zsh');
    expect(parseCompletionShell('fish')).toBe('fish');
    expect(() => parseCompletionShell('powershell')).toThrow(UsageError);
    expect(() => parseCompletionShell(undefined)).toThrow(UsageError);
  });
});
