import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { maybeAutoInitGitRepo, preflightRun } from './preflight';

const gitOk = { isGitWorkTree: async () => true };

describe('preflightRun', () => {
  it('flags a non-git workspace with actionable guidance', async () => {
    const problem = await preflightRun(
      { harness: 'claude', llmProvider: 'claude', workspace: '/some/dir' },
      { isGitWorkTree: async () => false, which: () => true },
    );
    expect(problem).toContain('not a git repository');
    expect(problem).toContain('git init');
    expect(problem).toContain('--auto-init');
  });

  it('flags a missing harness CLI with install guidance, before any spend', async () => {
    const problem = await preflightRun(
      { harness: 'claude', llmProvider: 'openai', workspace: '/w' },
      { ...gitOk, which: () => false },
    );
    expect(problem).toContain("'claude' CLI");
    expect(problem).toContain('--harness claude');
    expect(problem).toContain('not found on PATH');
  });

  it('flags a missing LLM-provider CLI separately from the harness', async () => {
    const problem = await preflightRun(
      { harness: 'goaly-code', llmProvider: 'codex', workspace: '/w' },
      { ...gitOk, which: (bin) => bin !== 'codex' },
    );
    expect(problem).toContain("'codex' CLI");
    expect(problem).toContain('--llm-provider codex');
  });

  it('passes when everything is present', async () => {
    const problem = await preflightRun(
      { harness: 'claude', llmProvider: 'claude', workspace: '/w' },
      { ...gitOk, which: () => true },
    );
    expect(problem).toBeNull();
  });

  it('skips the CLI probes for the fake harness (zero-external-tool test/demo mode)', async () => {
    const problem = await preflightRun(
      { harness: 'fake', llmProvider: 'claude', workspace: '/w' },
      { ...gitOk, which: () => false },
    );
    expect(problem).toBeNull();
  });

  it('skips CLI probes for goaly-code + openai (endpoint-backed, no CLI needed)', async () => {
    const problem = await preflightRun(
      { harness: 'goaly-code', llmProvider: 'openai', workspace: '/w' },
      { ...gitOk, which: () => false },
    );
    expect(problem).toBeNull();
  });

  it('real git probe: true inside a repo, false in a bare temp dir', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goaly-preflight-'));
    try {
      const before = await preflightRun(
        { harness: 'fake', llmProvider: 'claude', workspace: dir },
      );
      expect(before).toContain('not a git repository');

      const r = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
      expect(r.status).toBe(0);
      const after = await preflightRun(
        { harness: 'fake', llmProvider: 'claude', workspace: dir },
      );
      expect(after).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('maybeAutoInitGitRepo', () => {
  it('is a no-op when autoInit is false', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goaly-autoinit-noop-'));
    try {
      const err = await maybeAutoInitGitRepo({ workspace: dir, autoInit: false });
      expect(err).toBeNull();
      const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
      expect(probe.stdout.toString().trim()).not.toBe('true');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the workspace is already a git repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goaly-autoinit-existing-'));
    try {
      const init = spawnSync('git', ['init', '-q'], { cwd: dir });
      expect(init.status).toBe(0);
      const err = await maybeAutoInitGitRepo({ workspace: dir, autoInit: true });
      expect(err).toBeNull();
      // No commit should have been created (empty repo stays empty).
      const log = spawnSync('git', ['log', '--oneline'], { cwd: dir });
      expect(log.stdout.toString().trim()).toBe('');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('initializes a git repo, commits a baseline, and ignores .goaly/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goaly-autoinit-create-'));
    try {
      await writeFile(join(dir, 'README.md'), '# hello', 'utf8');
      const err = await maybeAutoInitGitRepo({ workspace: dir, autoInit: true });
      expect(err).toBeNull();

      const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
      expect(probe.stdout.toString().trim()).toBe('true');

      const log = spawnSync('git', ['log', '--oneline'], { cwd: dir });
      expect(log.stdout.toString().trim()).toContain('goaly baseline');

      const status = spawnSync('git', ['status', '--porcelain'], { cwd: dir });
      expect(status.stdout.toString().trim()).toBe('');

      const ignore = await readFile(join(dir, '.gitignore'), 'utf8');
      expect(ignore).toContain('.goaly/');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('appends .goaly/ to an existing .gitignore if missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'goaly-autoinit-gitignore-'));
    try {
      await writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
      const err = await maybeAutoInitGitRepo({ workspace: dir, autoInit: true });
      expect(err).toBeNull();
      const ignore = await readFile(join(dir, '.gitignore'), 'utf8');
      expect(ignore).toContain('node_modules/');
      expect(ignore).toContain('.goaly/');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
