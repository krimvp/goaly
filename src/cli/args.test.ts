import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, UsageError } from './args';
import type { InputReaders } from './input-sources';
import { loadConfig, type ConfigFileReader, type LoadedConfig } from './config-file';

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

/**
 * A `load` (parseArgs' 3rd arg) backed by an in-memory map of file path → JSON body, routed
 * through the REAL loader so the .goalyrc/--config layering + overlay logic is exercised
 * end-to-end. The implicit `.goalyrc` lives under the workspace dir; an explicit `--config <path>`
 * is looked up by its exact path.
 */
function fakeConfig(
  files: Record<string, string>,
): (dir: string, explicit: string | undefined) => Promise<LoadedConfig> {
  const reader: ConfigFileReader = async (p) => files[p];
  return (dir, explicit) => loadConfig(dir, explicit, reader);
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

  describe('runs subcommand (issue #14)', () => {
    it('parses "runs list" with the default workspace (cwd)', async () => {
      const a = await parseArgs(['runs', 'list']);
      expect(a.command).toBe('runs');
      expect(a.runs).toEqual({ kind: 'list' });
      expect(a.workspace).toBe(process.cwd());
    });

    it('parses "runs list --workspace <dir>"', async () => {
      const a = await parseArgs(['runs', 'list', '--workspace', '/tmp/ws']);
      expect(a.runs).toEqual({ kind: 'list' });
      expect(a.workspace).toBe('/tmp/ws');
    });

    it('parses "runs show <id>" with a positional run id', async () => {
      const a = await parseArgs(['runs', 'show', 'run-1234', '--workspace', '/tmp/ws']);
      expect(a.command).toBe('runs');
      expect(a.runs).toEqual({ kind: 'show', runId: 'run-1234' });
      expect(a.workspace).toBe('/tmp/ws');
    });

    it('throws UsageError when "runs show" is missing the run id', async () => {
      await expect(parseArgs(['runs', 'show'])).rejects.toThrow(UsageError);
      await expect(parseArgs(['runs', 'show', '--workspace', '/x'])).rejects.toThrow(UsageError);
    });

    it('throws UsageError on an unknown runs subcommand', async () => {
      await expect(parseArgs(['runs', 'delete'])).rejects.toThrow(UsageError);
      await expect(parseArgs(['runs'])).rejects.toThrow(UsageError);
    });
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

  describe('diagnostic logging flags', () => {
    it('defaults to info level, no file override, file enabled', async () => {
      const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
      expect(a.logLevel).toBe('info');
      expect(a.logFile).toBeUndefined();
      expect(a.noLogFile).toBe(false);
    });

    it('parses --log-level, --log-file and --no-log-file', async () => {
      const a = await parseArgs([
        'run', '--goal', 'g', '--verify-cmd', 'true',
        '--log-level', 'debug', '--log-file', '/tmp/run.log', '--no-log-file',
      ]);
      expect(a.logLevel).toBe('debug');
      expect(a.logFile).toBe('/tmp/run.log');
      expect(a.noLogFile).toBe(true);
    });

    it('throws UsageError on an unknown --log-level', async () => {
      await expect(
        parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--log-level', 'loud']),
      ).rejects.toThrow(UsageError);
    });
  });

  describe('config file (issue #15)', () => {
    const rc = path.join('/ws', '.goalyrc');

    it('fills harness/autonomous/max-iterations/verify-cmd from .goalyrc when only --goal is given', async () => {
      const a = await parseArgs(
        ['run', '--goal', 'do x', '--workspace', '/ws'],
        fakeReaders({}),
        fakeConfig({
          [rc]: '{ "harness": "fake", "autonomous": true, "max-iterations": 1, "verify-cmd": "touch m; exit 7" }',
        }),
      );
      expect(a.harness).toBe('fake');
      expect(a.config.autonomous).toBe(true);
      expect(a.config.maxIterations).toBe(1);
      expect(a.config.verifier).toEqual({ kind: 'existing', ref: 'touch m; exit 7' });
      expect(a.configSources).toEqual(['.goalyrc']);
    });

    it('reads defaults from an explicit --config <path> file', async () => {
      const a = await parseArgs(
        ['run', '--goal', 'do x', '--workspace', '/ws', '--config', '/ci/goaly.json'],
        fakeReaders({}),
        fakeConfig({ '/ci/goaly.json': '{ "harness": "fake", "autonomous": true, "verify-cmd": "true" }' }),
      );
      expect(a.harness).toBe('fake');
      expect(a.config.verifier).toEqual({ kind: 'existing', ref: 'true' });
      expect(a.configSources).toEqual(['/ci/goaly.json']);
    });

    it('layers --config over .goalyrc (explicit wins on conflicts)', async () => {
      const a = await parseArgs(
        ['run', '--goal', 'do x', '--workspace', '/ws', '--config', '/cfg.json'],
        fakeReaders({}),
        fakeConfig({
          [rc]: '{ "harness": "fake", "max-iterations": 1, "verify-cmd": "true" }',
          '/cfg.json': '{ "harness": "codex" }',
        }),
      );
      expect(a.harness).toBe('codex'); // from --config
      expect(a.config.maxIterations).toBe(1); // from .goalyrc
      expect(a.configSources).toEqual(['.goalyrc', '/cfg.json']);
    });

    it('lets an explicit CLI flag override the config value', async () => {
      const a = await parseArgs(
        ['run', '--goal', 'do x', '--workspace', '/ws', '--harness', 'codex', '--max-iterations', '5'],
        fakeReaders({}),
        fakeConfig({ [rc]: '{ "harness": "fake", "max-iterations": 1, "verify-cmd": "true" }' }),
      );
      expect(a.harness).toBe('codex');
      expect(a.config.maxIterations).toBe(5);
      expect(a.config.verifier).toEqual({ kind: 'existing', ref: 'true' });
    });

    it('reads per-step timeouts from the config file', async () => {
      const a = await parseArgs(
        ['run', '--goal', 'do x', '--workspace', '/ws', '--verify-cmd', 'true'],
        fakeReaders({}),
        fakeConfig({
          [rc]: '{ "harness-timeout-ms": 120000, "llm-timeout-ms": 90000, "verify-timeout-ms": 30000 }',
        }),
      );
      expect(a.timeouts).toEqual({ harnessMs: 120000, llmMs: 90000, verifyMs: 30000 });
    });

    it('drops a config goal when the CLI supplies one from a file (no false double-source)', async () => {
      const a = await parseArgs(
        ['run', '--goal-file', 'goal.md', '--verify-cmd', 'true', '--workspace', '/ws'],
        fakeReaders({ files: { 'goal.md': 'cli goal\n' } }),
        fakeConfig({ [rc]: '{ "goal": "config goal", "harness": "fake" }' }),
      );
      expect(a.config.goal).toBe('cli goal');
      expect(a.harness).toBe('fake');
    });

    it('surfaces an unknown config key as a usage error', async () => {
      await expect(
        parseArgs(
          ['run', '--goal', 'g', '--workspace', '/ws'],
          fakeReaders({}),
          fakeConfig({ [rc]: '{ "bogus": 1 }' }),
        ),
      ).rejects.toThrow(UsageError);
    });

    it('fails closed when an explicit --config path does not exist', async () => {
      await expect(
        parseArgs(
          ['run', '--goal', 'g', '--workspace', '/ws', '--config', '/nope.json'],
          fakeReaders({}),
          fakeConfig({}),
        ),
      ).rejects.toThrow(UsageError);
    });

    it('reports no config file when none is present', async () => {
      const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
      expect(a.configSources).toEqual([]);
    });
  });

  describe('per-step timeouts (issue #15)', () => {
    it('parses the three timeout flags into milliseconds', async () => {
      const a = await parseArgs([
        'run',
        '--goal',
        'g',
        '--verify-cmd',
        'true',
        '--harness-timeout-ms',
        '600000',
        '--llm-timeout-ms',
        '120000',
        '--verify-timeout-ms',
        '45000',
      ]);
      expect(a.timeouts).toEqual({ harnessMs: 600000, llmMs: 120000, verifyMs: 45000 });
    });

    it('defaults to no explicit timeouts (each step keeps its own default)', async () => {
      const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
      expect(a.timeouts).toEqual({});
    });

    it('rejects a non-positive / non-integer timeout (fails closed)', async () => {
      await expect(
        parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--verify-timeout-ms', '0']),
      ).rejects.toThrow(UsageError);
      await expect(
        parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--harness-timeout-ms', 'soon']),
      ).rejects.toThrow(UsageError);
    });
  });
});
