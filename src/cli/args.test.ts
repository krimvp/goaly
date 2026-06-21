import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, UsageError } from './args';
import type { InputReaders } from './input-sources';

/** Fake readers so tests never touch the filesystem or the real stdin stream. */
function fakeReaders(opts: { files?: Record<string, string>; stdin?: string }): InputReaders {
  return {
    readFile: async (p) => {
      const f = opts.files?.[p];
      if (f === undefined) throw new Error(`ENOENT: no such file '${p}'`);
      return f;
    },
    readStdin: async () => opts.stdin ?? '',
  };
}

describe('parseArgs', () => {
  it('parses a run with an existing verify command', async () => {
    const a = await parseArgs(['run', '--goal', 'do x', '--verify-cmd', 'npm test']);
    expect(a.command).toBe('run');
    expect(a.config.goal).toBe('do x');
    expect(a.config.verifier).toEqual({ kind: 'existing', ref: 'npm test' });
    expect(a.harness).toBe('claude-code');
  });

  it('supports the --key=value form', async () => {
    const a = await parseArgs(['run', '--goal=do y', '--verify-cmd=true']);
    expect(a.config.goal).toBe('do y');
    expect(a.config.verifier).toEqual({ kind: 'existing', ref: 'true' });
  });

  it('parses generate + intent + autonomous + numeric/harness/workspace flags', async () => {
    const a = await parseArgs([
      'run', '--goal', 'g', '--generate', '--intent', 'write tests',
      '--autonomous', '--max-iterations', '7', '--harness', 'codex', '--workspace', '/tmp/x',
    ]);
    expect(a.config.verifier).toEqual({ kind: 'generate', intent: 'write tests' });
    expect(a.config.autonomous).toBe(true);
    expect(a.config.maxIterations).toBe(7);
    expect(a.harness).toBe('codex');
    expect(a.workspace).toBe('/tmp/x');
  });

  it('parses --max-gate-a-revisions', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--max-gate-a-revisions', '3']);
    expect(a.config.maxGateARevisions).toBe(3);
  });

  it('accepts the droid harness', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--harness', 'droid']);
    expect(a.harness).toBe('droid');
  });

  it('returns help for no args and for the help command', async () => {
    expect((await parseArgs([])).command).toBe('help');
    expect((await parseArgs(['help'])).command).toBe('help');
    expect((await parseArgs(['--help'])).command).toBe('help');
  });

  it('throws UsageError on an unknown command', async () => {
    await expect(parseArgs(['frobnicate'])).rejects.toThrow(UsageError);
  });

  it('throws UsageError on an unknown harness', async () => {
    await expect(
      parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--harness', 'bogus']),
    ).rejects.toThrow(UsageError);
  });

  it('rejects a run without a goal', async () => {
    await expect(parseArgs(['run', '--verify-cmd', 'true'])).rejects.toThrow();
  });

  it('captures --resume runId', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--resume', 'run-123']);
    expect(a.resumeRunId).toBe('run-123');
  });

  describe('model selection', () => {
    it('defaults to no model flags and the claude LLM provider', async () => {
      const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
      expect(a.models).toEqual({});
      expect(a.llmProvider).toBe('claude');
    });

    it('parses the full cascade of model flags and --llm-provider', async () => {
      const a = await parseArgs([
        'run', '--goal', 'g', '--verify-cmd', 'true',
        '--model', 'opus', '--llm-model', 'sonnet', '--judge-model', 'haiku',
        '--approver-model', 'opus', '--compiler-model', 'sonnet', '--llm-provider', 'codex',
      ]);
      expect(a.models).toEqual({
        model: 'opus', llmModel: 'sonnet', judgeModel: 'haiku',
        approverModel: 'opus', compilerModel: 'sonnet',
      });
      expect(a.llmProvider).toBe('codex');
    });

    it('supports the --model=value form', async () => {
      const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--model=opus']);
      expect(a.models.model).toBe('opus');
    });

    it('throws UsageError on an empty model value', async () => {
      await expect(
        parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--model=']),
      ).rejects.toThrow(UsageError);
    });

    it('throws UsageError on an unknown --llm-provider', async () => {
      await expect(
        parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--llm-provider', 'bogus']),
      ).rejects.toThrow(UsageError);
    });
  });

  describe('goal / intent / rubric input sources', () => {
    it('reads the goal from a file and trims the trailing newline', async () => {
      const a = await parseArgs(
        ['run', '--goal-file', 'goal.md', '--verify-cmd', 'true'],
        fakeReaders({ files: { 'goal.md': 'build the parser\n' } }),
      );
      expect(a.config.goal).toBe('build the parser');
    });

    it('reads the goal from stdin via "--goal -"', async () => {
      const a = await parseArgs(
        ['run', '--goal', '-', '--verify-cmd', 'true'],
        fakeReaders({ stdin: 'piped goal\n' }),
      );
      expect(a.config.goal).toBe('piped goal');
    });

    it('reads intent and rubric from files too', async () => {
      const a = await parseArgs(
        ['run', '--goal', 'g', '--generate', '--intent-file', 'i.txt', '--rubric-file', 'r.txt'],
        fakeReaders({ files: { 'i.txt': 'add a test', 'r.txt': 'idiomatic code' } }),
      );
      expect(a.config.verifier).toEqual({ kind: 'generate', intent: 'add a test' });
      expect(a.config.rubric).toBe('idiomatic code');
    });

    it('rejects more than one source for a field', async () => {
      await expect(
        parseArgs(
          ['run', '--goal', 'inline', '--goal-file', 'goal.md', '--verify-cmd', 'true'],
          fakeReaders({ files: { 'goal.md': 'x' } }),
        ),
      ).rejects.toThrow(UsageError);
    });

    it('rejects piping stdin into more than one field', async () => {
      await expect(
        parseArgs(
          ['run', '--goal', '-', '--generate', '--intent', '-'],
          fakeReaders({ stdin: 'x' }),
        ),
      ).rejects.toThrow(UsageError);
    });

    it('turns a file-read failure into a UsageError', async () => {
      await expect(
        parseArgs(
          ['run', '--goal-file', 'missing.md', '--verify-cmd', 'true'],
          fakeReaders({ files: {} }),
        ),
      ).rejects.toThrow(UsageError);
    });

    it('reads a real file via the default readers (end-to-end)', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'goaly-args-'));
      try {
        const file = path.join(dir, 'goal.md');
        await writeFile(file, 'ship the feature\n', 'utf8');
        const a = await parseArgs(['run', '--goal-file', file, '--verify-cmd', 'true']);
        expect(a.config.goal).toBe('ship the feature');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});
