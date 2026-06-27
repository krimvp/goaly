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
  return (dir, explicit) => loadConfig(dir, explicit, reader, homeDir);
}

/** A fixed, non-existent home dir so the default `load`/`fakeConfig` never read a real ~/.goalyrc. */
const homeDir = '/home/test-user';

/** Like {@link fakeConfig} but with a custom home dir so the ~/.goalyrc layer can be exercised. */
function fakeConfigWithHome(
  files: Record<string, string>,
  home: string,
): (dir: string, explicit: string | undefined) => Promise<LoadedConfig> {
  const reader: ConfigFileReader = async (p) => files[p];
  return (dir, explicit) => loadConfig(dir, explicit, reader, home);
}

describe('parseArgs', () => {
  it('parses a run with an existing verify command', async () => {
    const a = await parseArgs(['run', '--goal', 'do x', '--verify-cmd', 'npm test']);
    expect(a.command).toBe('run');
    expect(a.config.goal).toBe('do x');
    expect(a.config.verifier).toEqual({ kind: 'existing', ref: 'npm test' });
    expect(a.harness).toBe('claude');
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

  it('parses --max-seal-revisions', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--max-seal-revisions', '3']);
    expect(a.config.maxSealRevisions).toBe(3);
  });

  it('rejects the removed --max-gate-a-revisions spelling (renamed to --max-seal-revisions)', async () => {
    await expect(
      parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--max-gate-a-revisions', '3']),
    ).rejects.toThrow(/renamed to --max-seal-revisions/);
  });

  it('parses --max-compile-retries (issue #51)', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--max-compile-retries', '4']);
    expect(a.config.maxCompileRetries).toBe(4);
  });

  it('defaults maxCompileRetries to 2 when the flag is absent (issue #51)', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
    expect(a.config.maxCompileRetries).toBe(2);
  });

  it('parses --verify-dir (issue #52)', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--verify-dir', 'test']);
    expect(a.verifyDir).toBe('test');
  });

  it('parses the phased flags (issue #48)', async () => {
    const a = await parseArgs([
      'run', '--goal', 'big', '--generate', '--phased',
      '--max-phases', '4', '--max-plan-revisions', '2',
      '--plan-file', 'plan.json', '--planner-model', 'opus',
    ]);
    expect(a.config.phased).toBe(true);
    expect(a.config.maxPhases).toBe(4);
    expect(a.config.maxPlanRevisions).toBe(2);
    expect(a.planFile).toBe('plan.json');
    expect(a.models.plannerModel).toBe('opus');
  });

  it('defaults phased off (classic single-contract run) when --phased is absent', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
    expect(a.config.phased).toBe(false);
    expect(a.config.maxPhases).toBe(10);
    expect(a.planFile).toBeUndefined();
  });

  it('parses --smoke into an artifact-running command (issue #53)', async () => {
    const a = await parseArgs([
      'run', '--goal', 'g', '--verify-cmd', 'npm test', '--smoke', 'node smoke.mjs',
    ]);
    expect(a.config.smoke).toBe('node smoke.mjs');
  });

  it('parses --setup-cmd / --no-setup / --setup-timeout-ms (Fix #1)', async () => {
    const a = await parseArgs([
      'run', '--goal', 'g', '--verify-cmd', 'npm test',
      '--setup-cmd', 'npm ci', '--setup-timeout-ms', '120000',
    ]);
    expect(a.config.setupCmd).toBe('npm ci');
    expect(a.config.noSetup).toBe(false);
    expect(a.timeouts.setupMs).toBe(120000);

    const b = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--no-setup']);
    expect(b.config.noSetup).toBe(true);
  });

  it('defaults installMissingTools to true and parses --install-missing-tools false (fail-closed)', async () => {
    const def = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
    expect(def.config.installMissingTools).toBe(true);

    const off = await parseArgs([
      'run', '--goal', 'g', '--verify-cmd', 'true', '--install-missing-tools', 'false',
    ]);
    expect(off.config.installMissingTools).toBe(false);

    await expect(
      parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--install-missing-tools', 'maybe']),
    ).rejects.toThrow(UsageError);
  });

  it('parses the --stuck-* tuning flags fail-closed (issue #54)', async () => {
    const a = await parseArgs([
      'run', '--goal', 'g', '--verify-cmd', 'true',
      '--stuck-no-diff', 'false',
      '--stuck-repeat-threshold', '5',
      '--stuck-oscillation', 'false',
      '--stuck-crash-threshold', '4',
    ]);
    expect(a.config.stuckPolicy).toEqual({
      noDiff: false,
      repeatFailureThreshold: 5,
      oscillation: false,
      harnessCrashThreshold: 4,
    });
  });

  it('defaults the harness-crash threshold to 2 when the flag is omitted', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
    expect(a.config.stuckPolicy.harnessCrashThreshold).toBe(2);
  });

  it('treats a bare --stuck-no-diff as true and keeps other stuck defaults (issue #54)', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--stuck-no-diff']);
    expect(a.config.stuckPolicy.noDiff).toBe(true);
    expect(a.config.stuckPolicy.repeatFailureThreshold).toBe(3);
  });

  it('rejects a non-boolean --stuck-no-diff value (fail-closed, issue #54)', async () => {
    await expect(
      parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--stuck-no-diff', 'maybe']),
    ).rejects.toThrow(UsageError);
  });

  it('reads new tuning keys from .goalyrc (issues #51/#52/#54)', async () => {
    const a = await parseArgs(
      ['run', '--goal', 'g', '--verify-cmd', 'true', '--workspace', '/ws'],
      undefined,
      fakeConfig({
        '/ws/.goalyrc': JSON.stringify({
          'max-compile-retries': 4,
          'verify-dir': 'tests',
          'stuck-repeat-threshold': 5,
        }),
      }),
    );
    expect(a.config.maxCompileRetries).toBe(4);
    expect(a.verifyDir).toBe('tests');
    expect(a.config.stuckPolicy.repeatFailureThreshold).toBe(5);
  });

  it('accepts the droid harness', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--harness', 'droid']);
    expect(a.harness).toBe('droid');
  });

  it('accepts the pi harness', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--harness', 'pi']);
    expect(a.harness).toBe('pi');
  });

  it('returns help for no args and for the help command', async () => {
    expect((await parseArgs([])).command).toBe('help');
    expect((await parseArgs(['help'])).command).toBe('help');
    expect((await parseArgs(['--help'])).command).toBe('help');
  });

  describe('positional goal + implicit run (easy mode)', () => {
    it('treats a bare positional as the goal and implies run (generate by default)', async () => {
      const a = await parseArgs(['make the build green']);
      expect(a.command).toBe('run');
      expect(a.config.goal).toBe('make the build green');
      // No --verify-cmd ⇒ the verifier defaults to generate (LLM authors it).
      expect(a.config.verifier.kind).toBe('generate');
    });

    it('accepts the positional under an explicit run too', async () => {
      const a = await parseArgs(['run', 'do the thing']);
      expect(a.command).toBe('run');
      expect(a.config.goal).toBe('do the thing');
    });

    it('-d / --defaults is hands-off sugar for --autonomous', async () => {
      const short = await parseArgs(['-d', 'ship it']);
      expect(short.config.goal).toBe('ship it');
      expect(short.config.autonomous).toBe(true);

      const long = await parseArgs(['--defaults', 'ship it']);
      expect(long.config.autonomous).toBe(true);
    });

    it('valueless boolean flags do not swallow the positional goal', async () => {
      const afterGoal = await parseArgs(['ship it', '-d']);
      expect(afterGoal.config.goal).toBe('ship it');
      expect(afterGoal.config.autonomous).toBe(true);

      const beforeGoal = await parseArgs(['--generate', 'ship it']);
      expect(beforeGoal.config.goal).toBe('ship it');
      expect(beforeGoal.config.verifier.kind).toBe('generate');
    });

    it('parses a value-taking flag after the positional goal', async () => {
      const a = await parseArgs(['ship it', '--model', 'opus']);
      expect(a.config.goal).toBe('ship it');
      expect(a.models.model).toBe('opus');
    });

    it('rejects a positional goal alongside --goal (double source)', async () => {
      await expect(parseArgs(['positional', '--goal', 'flag'])).rejects.toThrow(UsageError);
    });

    it('rejects more than one positional', async () => {
      await expect(parseArgs(['goal one', 'goal two'])).rejects.toThrow(UsageError);
    });

    it('rejects an unknown single-dash flag (fail-closed)', async () => {
      await expect(parseArgs(['-x', 'g'])).rejects.toThrow(UsageError);
    });
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

  it('captures --baseline ref (issue #47); defaults to undefined (⇒ HEAD)', async () => {
    const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--baseline', 'main']);
    expect(a.baseline).toBe('main');
    const b = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
    expect(b.baseline).toBeUndefined();
  });

  describe('--sandbox (issue #9)', () => {
    const run = ['run', '--goal', 'g', '--verify-cmd', 'true'];

    it('defaults to mode none with no network (Option 1)', async () => {
      const a = await parseArgs([...run]);
      expect(a.sandbox).toEqual({ mode: 'none', network: 'none' });
    });

    it('parses an explicit mode', async () => {
      expect((await parseArgs([...run, '--sandbox=bwrap'])).sandbox.mode).toBe('bwrap');
      expect((await parseArgs([...run, '--sandbox=firejail'])).sandbox.mode).toBe('firejail');
      expect((await parseArgs([...run, '--sandbox=container'])).sandbox.mode).toBe('container');
    });

    it('bare --sandbox means auto', async () => {
      expect((await parseArgs([...run, '--sandbox'])).sandbox.mode).toBe('auto');
    });

    it('parses the network toggle and container knobs', async () => {
      const a = await parseArgs([
        ...run, '--sandbox=container', '--sandbox-net', 'allow',
        '--sandbox-image', 'node:20', '--sandbox-runtime', 'podman',
      ]);
      expect(a.sandbox).toEqual({
        mode: 'container', network: 'allow', image: 'node:20', runtime: 'podman',
      });
    });

    it('rejects an unknown mode / net / runtime (fail-closed)', async () => {
      await expect(parseArgs([...run, '--sandbox=jail'])).rejects.toThrow(UsageError);
      await expect(parseArgs([...run, '--sandbox-net', 'partial'])).rejects.toThrow(UsageError);
      await expect(parseArgs([...run, '--sandbox-runtime', 'lxc'])).rejects.toThrow(UsageError);
    });

    it('parses an egress allowlist from --sandbox-net allow:<hosts> (issue #39)', async () => {
      const a = await parseArgs([
        ...run, '--sandbox=bwrap', '--sandbox-net', 'allow:api.anthropic.com, *.npmjs.org ,host:443',
      ]);
      // Whitespace around each host is trimmed; empty entries dropped.
      expect(a.sandbox.network).toEqual({
        allowlist: ['api.anthropic.com', '*.npmjs.org', 'host:443'],
      });
    });

    it('rejects an empty or malformed allowlist (fail-closed)', async () => {
      await expect(parseArgs([...run, '--sandbox-net', 'allow:'])).rejects.toThrow(UsageError);
      await expect(parseArgs([...run, '--sandbox-net', 'allow: , '])).rejects.toThrow(UsageError);
      await expect(
        parseArgs([...run, '--sandbox-net', 'allow:has space']),
      ).rejects.toThrow(UsageError);
    });

    it('reads an allowlist from .goalyrc too (issue #39)', async () => {
      const a = await parseArgs(
        [...run, '--workspace', '/ws'],
        undefined,
        fakeConfig({
          '/ws/.goalyrc': JSON.stringify({ sandbox: 'bwrap', 'sandbox-net': 'allow:registry.npmjs.org' }),
        }),
      );
      expect(a.sandbox.network).toEqual({ allowlist: ['registry.npmjs.org'] });
    });

    it('is defaultable from .goalyrc', async () => {
      const a = await parseArgs(
        [...run, '--workspace', '/ws'],
        undefined,
        fakeConfig({ '/ws/.goalyrc': JSON.stringify({ sandbox: 'bwrap', 'sandbox-net': 'allow' }) }),
      );
      expect(a.sandbox.mode).toBe('bwrap');
      expect(a.sandbox.network).toBe('allow');
    });

    it('a CLI --sandbox overrides the .goalyrc default', async () => {
      const a = await parseArgs(
        [...run, '--workspace', '/ws', '--sandbox=container'],
        undefined,
        fakeConfig({ '/ws/.goalyrc': JSON.stringify({ sandbox: 'bwrap' }) }),
      );
      expect(a.sandbox.mode).toBe('container');
    });
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

    it('accepts the pi LLM provider', async () => {
      const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--llm-provider', 'pi']);
      expect(a.llmProvider).toBe('pi');
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
    it('defaults to info level, no file override, file enabled, streaming off', async () => {
      const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true']);
      expect(a.logLevel).toBe('info');
      expect(a.logFile).toBeUndefined();
      expect(a.noLogFile).toBe(false);
      expect(a.stream).toBe(false);
      expect(a.streamTranscript).toBe(false);
      expect(a.streamFile).toBeUndefined();
    });

    it('parses --stream as an opt-in boolean', async () => {
      const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--stream']);
      expect(a.stream).toBe(true);
    });

    it('parses --stream-transcript as an opt-in boolean (issue #28)', async () => {
      const a = await parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--stream-transcript']);
      expect(a.streamTranscript).toBe(true);
      expect(a.streamFile).toBeUndefined();
    });

    it('--stream-file sets the path AND implies --stream-transcript', async () => {
      const a = await parseArgs([
        'run', '--goal', 'g', '--verify-cmd', 'true', '--stream-file', '/tmp/s.jsonl',
      ]);
      expect(a.streamFile).toBe('/tmp/s.jsonl');
      expect(a.streamTranscript).toBe(true);
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

    it('fills defaults from a home-level ~/.goalyrc so just the goal need be typed', async () => {
      const a = await parseArgs(
        ['just do this'],
        fakeReaders({}),
        fakeConfigWithHome(
          { [path.join('/home/u', '.goalyrc')]: '{ "autonomous": true, "harness": "fake" }' },
          '/home/u',
        ),
      );
      expect(a.config.goal).toBe('just do this');
      expect(a.config.autonomous).toBe(true);
      expect(a.harness).toBe('fake');
      expect(a.configSources).toEqual(['~/.goalyrc']);
    });

    it('a workspace .goalyrc overrides the home ~/.goalyrc on conflicts', async () => {
      const a = await parseArgs(
        ['run', '--goal', 'g', '--workspace', '/ws'],
        fakeReaders({}),
        fakeConfigWithHome(
          {
            [path.join('/home/u', '.goalyrc')]: '{ "harness": "fake", "max-iterations": 2 }',
            [path.join('/ws', '.goalyrc')]: '{ "harness": "codex" }',
          },
          '/home/u',
        ),
      );
      expect(a.harness).toBe('codex'); // workspace wins
      expect(a.config.maxIterations).toBe(2); // home supplies what the workspace doesn't
      expect(a.configSources).toEqual(['~/.goalyrc', '.goalyrc']);
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

    it('parses the harness idle/heartbeat timeout (issue #56)', async () => {
      const a = await parseArgs([
        'run',
        '--goal',
        'g',
        '--verify-cmd',
        'true',
        '--harness-idle-timeout-ms',
        '120000',
      ]);
      expect(a.timeouts).toEqual({ harnessIdleMs: 120000 });
    });

    it('rejects a non-positive harness idle timeout (fails closed)', async () => {
      await expect(
        parseArgs(['run', '--goal', 'g', '--verify-cmd', 'true', '--harness-idle-timeout-ms', '0']),
      ).rejects.toThrow(UsageError);
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
