import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  composeDeps,
  makeLlmProvider,
  buildLadder,
  codexCompletionArgs,
  droidCompletionArgs,
} from './compose';
import { makeConfig, InMemoryLogFs } from '../testing/fakes';
import { asRunId, DiffHash } from '../domain/ids';
import { freezeContract } from '../util/hash';
import { FakeLlm } from '../llm/provider';
import type { Workspace, CommandResult } from '../workspace/workspace';

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

describe('buildLadder — verify timeout threading', () => {
  /** A workspace that records the opts passed to `run`. */
  function spyWorkspace(): {
    workspace: Workspace;
    calls: Array<{ command: string; opts?: { timeoutMs?: number } }>;
  } {
    const calls: Array<{ command: string; opts?: { timeoutMs?: number } }> = [];
    const result: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
    const workspace: Workspace = {
      async diffHash() {
        return DiffHash.parse('0'.repeat(40));
      },
      async diff() {
        return '';
      },
      async run(command, opts) {
        calls.push(opts !== undefined ? { command, opts } : { command });
        return result;
      },
    };
    return { workspace, calls };
  }

  it('passes verifyTimeoutMs down into each deterministic rung', async () => {
    const contract = freezeContract({
      goal: 'g',
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      rubric: 'r',
      generatedFiles: [],
    });
    const ladder = buildLadder(contract, new FakeLlm([]), 45000);
    const { workspace, calls } = spyWorkspace();

    await ladder.verify(workspace, 'g', 'r');

    expect(calls).toEqual([{ command: 'npm test', opts: { timeoutMs: 45000 } }]);
  });

  it('omits the timeout when none is configured', async () => {
    const contract = freezeContract({
      goal: 'g',
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      rubric: 'r',
      generatedFiles: [],
    });
    const ladder = buildLadder(contract, new FakeLlm([]));
    const { workspace, calls } = spyWorkspace();

    await ladder.verify(workspace, 'g', 'r');

    expect(calls).toEqual([{ command: 'npm test' }]);
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
