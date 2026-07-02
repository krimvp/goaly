import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitWorkspace } from '../workspace/git-workspace';
import { DEFAULT_DIFF_IGNORE, STATE_DIR } from './compose';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('DEFAULT_DIFF_IGNORE — the built-in verifier-artifact excludes', () => {
  it('targets ephemeral caches/bytecode only — never build output or the bare word "coverage"', () => {
    // Build output must stay VISIBLE (a build goal's product can't be masked), and the generic word
    // "coverage" would over-match a real source file (coverage_report.py).
    for (const bad of ['build', 'dist', 'target', 'coverage', 'node_modules']) {
      expect(DEFAULT_DIFF_IGNORE).not.toContain(bad);
      expect(DEFAULT_DIFF_IGNORE).not.toContain(`*${bad}*`);
    }
    expect(DEFAULT_DIFF_IGNORE).toContain('*__pycache__*');
    expect(DEFAULT_DIFF_IGNORE).toContain('*.pyc');
  });

  describe('applied to a real workspace (as compose assembles excludes)', () => {
    let root: string;
    const excludes = [STATE_DIR, ...DEFAULT_DIFF_IGNORE];

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'goaly-di-test-'));
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 'test@example.com');
      git(root, 'config', 'user.name', 'Test User');
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'app.py'), 'print(1)\n');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'initial');
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('ignores nested __pycache__ / .pytest_cache / bytecode a verifier drops', async () => {
      const ws = new GitWorkspace(root, undefined, excludes);
      const before = await ws.diffHash();

      // Artifacts a pytest run leaves behind, at depth (the reason a bare pathspec would miss them).
      await mkdir(join(root, 'src', 'pkg', '__pycache__'), { recursive: true });
      await writeFile(join(root, 'src', 'pkg', '__pycache__', 'm.cpython-312.pyc'), 'x\n');
      await mkdir(join(root, '.pytest_cache', 'v'), { recursive: true });
      await writeFile(join(root, '.pytest_cache', 'v', 'lastfailed'), '{}\n');
      await mkdir(join(root, '.mypy_cache'), { recursive: true });
      await writeFile(join(root, '.mypy_cache', 'cache.json'), '{}\n');

      expect(await ws.diffHash()).toBe(before);
    });

    it('still detects a real source change (defaults do not blind genuine work)', async () => {
      const ws = new GitWorkspace(root, undefined, excludes);
      const before = await ws.diffHash();
      await writeFile(join(root, 'src', 'app.py'), 'print(2)\n');
      expect(await ws.diffHash()).not.toBe(before);
    });

    it('does not over-match a source file merely named like an artifact', async () => {
      const ws = new GitWorkspace(root, undefined, excludes);
      const before = await ws.diffHash();
      // "coverage" appears in the name but this is real source — it MUST move the hash.
      await writeFile(join(root, 'src', 'coverage_report.py'), 'def report(): pass\n');
      expect(await ws.diffHash()).not.toBe(before);
    });

    it('does not exclude build output (a build goal deliverable must stay visible)', async () => {
      const ws = new GitWorkspace(root, undefined, excludes);
      const before = await ws.diffHash();
      await mkdir(join(root, 'dist'), { recursive: true });
      await writeFile(join(root, 'dist', 'bundle.js'), 'console.log(1)\n');
      expect(await ws.diffHash()).not.toBe(before);
    });
  });
});
