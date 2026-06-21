import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { composeDeps, makeLlmProvider, codexCompletionArgs, droidCompletionArgs } from './compose';
import { makeConfig, InMemoryLogFs } from '../testing/fakes';
import { asRunId } from '../domain/ids';

describe('LLM provider completion argv (read-only)', () => {
  it('codex runs --sandbox read-only with the model before the prompt positional', () => {
    expect(codexCompletionArgs('judge this', 'gpt-x')).toEqual([
      'exec', '--sandbox', 'read-only', '--model', 'gpt-x', 'judge this', '--json',
    ]);
  });

  it('codex omits --model when none is set', () => {
    expect(codexCompletionArgs('p', undefined)).toEqual([
      'exec', '--sandbox', 'read-only', 'p', '--json',
    ]);
  });

  it('droid never passes --auto (the exec default cannot edit the tree)', () => {
    const args = droidCompletionArgs('p', 'm1');
    expect(args).toEqual(['exec', '--output-format', 'json', '--model', 'm1', 'p']);
    expect(args).not.toContain('--auto');
  });
});

describe('makeLlmProvider', () => {
  it('names the provider after the chosen CLI', () => {
    expect(makeLlmProvider('claude', undefined).name).toBe('cli:claude');
    expect(makeLlmProvider('codex', undefined).name).toBe('codex');
    expect(makeLlmProvider('droid', undefined).name).toBe('droid');
  });
});

describe('composeDeps — diagnostic logger wiring', () => {
  it('defaults the diagnostics file to <stateDir>/<runId>/goaly.log and writes through it', () => {
    const fs = new InMemoryLogFs();
    const runId = asRunId('run-log-1');
    const deps = composeDeps(makeConfig(), {
      harness: 'fake',
      workspaceRoot: '/repo',
      runId,
      noLogConsole: true,
      logFs: fs,
    });
    deps.logger?.info('hello');
    const expected = path.join('/repo', '.goaly', runId, 'goaly.log');
    expect(fs.files.get(expected)).toContain('hello');
    // runId is bound onto every record.
    expect(fs.files.get(expected)).toContain(runId);
  });

  it('writes no diagnostics file when noLogFile is set', () => {
    const fs = new InMemoryLogFs();
    const deps = composeDeps(makeConfig(), {
      harness: 'fake',
      workspaceRoot: '/repo',
      runId: asRunId('run-log-2'),
      noLogConsole: true,
      noLogFile: true,
      logFs: fs,
    });
    deps.logger?.info('hello');
    expect(fs.files.size).toBe(0);
  });
});
