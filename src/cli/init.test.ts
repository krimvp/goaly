import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runInit, type InitCommand, type InitIo } from './init';
import type { DoctorProbes } from './doctor';

/**
 * `goaly init` against a real temp workspace: the written `.goalyrc` must round-trip through the
 * run path's schema, existing configs must survive without --force, and the interactive path must
 * honour answers while the headless path honours flags/defaults.
 */

const quietProbes: DoctorProbes = {
  which: () => true,
  isGitWorkTree: async () => true,
  nodeVersion: 'v22.1.0',
  readConfigFile: async () => undefined,
  homeDir: '/fake-home',
};

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'goaly-init-test-'));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function cmd(overrides: Partial<InitCommand> = {}): InitCommand {
  return {
    harness: undefined,
    autonomous: false,
    model: undefined,
    verifyCmd: undefined,
    force: false,
    yes: false,
    ...overrides,
  };
}

type Capture = { out: string; err: string };

function io(capture: Capture, extra: Partial<InitIo> = {}): InitIo {
  return {
    out: (s) => (capture.out += s),
    err: (s) => (capture.err += s),
    interactive: false,
    probes: quietProbes,
    ...extra,
  };
}

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(workspace, '.goalyrc'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('goaly init', () => {
  it('writes a minimal .goalyrc from flags, headless', async () => {
    const capture: Capture = { out: '', err: '' };
    const code = await runInit(
      cmd({ harness: 'codex', autonomous: true, model: 'gpt-5', verifyCmd: 'npm test' }),
      workspace,
      io(capture),
    );
    expect(code).toBe(0);
    expect(await readConfig()).toEqual({
      harness: 'codex',
      autonomous: true,
      model: 'gpt-5',
      'verify-cmd': 'npm test',
    });
    expect(capture.out).toContain('goaly doctor'); // doctor ran first
    expect(capture.out).toContain('wrote ');
  });

  it('defaults to a claude-only config when no flags and not interactive', async () => {
    const capture: Capture = { out: '', err: '' };
    const code = await runInit(cmd(), workspace, io(capture));
    expect(code).toBe(0);
    expect(await readConfig()).toEqual({ harness: 'claude' });
  });

  it('refuses to overwrite an existing .goalyrc without --force', async () => {
    await writeFile(path.join(workspace, '.goalyrc'), '{ "harness": "pi" }\n');
    const capture: Capture = { out: '', err: '' };
    const code = await runInit(cmd({ harness: 'codex' }), workspace, io(capture));
    expect(code).toBe(2);
    expect(capture.err).toContain('--force');
    expect(await readConfig()).toEqual({ harness: 'pi' }); // untouched
  });

  it('overwrites with --force', async () => {
    await writeFile(path.join(workspace, '.goalyrc'), '{ "harness": "pi" }\n');
    const code = await runInit(
      cmd({ harness: 'codex', force: true }),
      workspace,
      io({ out: '', err: '' }),
    );
    expect(code).toBe(0);
    expect(await readConfig()).toEqual({ harness: 'codex' });
  });

  it('rejects an unknown harness with the public choices, writing nothing', async () => {
    const capture: Capture = { out: '', err: '' };
    const code = await runInit(cmd({ harness: 'bogus' }), workspace, io(capture));
    expect(code).toBe(2);
    expect(capture.err).toContain("unknown harness 'bogus'");
    expect(capture.err).toContain('claude | codex | droid | pi | goaly-code');
    await expect(readFile(path.join(workspace, '.goalyrc'), 'utf8')).rejects.toThrow();
  });

  it('asks interactively and honours the answers', async () => {
    const questions: string[] = [];
    const answers = ['droid', 'y', 'sonnet', 'make check'];
    const capture: Capture = { out: '', err: '' };
    const code = await runInit(
      cmd(),
      workspace,
      io(capture, {
        interactive: true,
        ask: async (q) => {
          questions.push(q);
          return answers[questions.length - 1] ?? '';
        },
      }),
    );
    expect(code).toBe(0);
    expect(await readConfig()).toEqual({
      harness: 'droid',
      autonomous: true,
      model: 'sonnet',
      'verify-cmd': 'make check',
    });
    expect(questions[0]).toContain('harness');
    expect(questions[1]).toContain('autonomous');
  });

  it('empty interactive answers accept the defaults', async () => {
    const capture: Capture = { out: '', err: '' };
    const code = await runInit(
      cmd(),
      workspace,
      io(capture, { interactive: true, ask: async () => '' }),
    );
    expect(code).toBe(0);
    expect(await readConfig()).toEqual({ harness: 'claude' });
  });

  it('--yes skips prompts even when interactive', async () => {
    let asked = 0;
    const code = await runInit(
      cmd({ yes: true, harness: 'pi' }),
      workspace,
      io(
        { out: '', err: '' },
        {
          interactive: true,
          ask: async () => {
            asked += 1;
            return 'never';
          },
        },
      ),
    );
    expect(code).toBe(0);
    expect(asked).toBe(0);
    expect(await readConfig()).toEqual({ harness: 'pi' });
  });
});
