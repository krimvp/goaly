import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { excludeFromGit } from './git-exclude';
import { GitWorkspace } from './git-workspace';
import { GeneratedFilesGuard } from '../verify/generated-guard';
import { sha256Hex } from '../util/hash';
import { runProcess } from '../util/spawn';

describe('excludeFromGit (issue #52)', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  async function makeRepoDir(withInfo = true): Promise<string> {
    const d = await mkdtemp(path.join(tmpdir(), 'goaly-exclude-'));
    if (withInfo) await mkdir(path.join(d, '.git', 'info'), { recursive: true });
    return d;
  }

  it('registers a workspace-relative path, anchored to the repo root', async () => {
    dir = await makeRepoDir();
    const result = await excludeFromGit(dir, 'test/wave.test.js');

    expect(result).toEqual({ ok: true, excluded: true });
    const content = await readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(content.split('\n')).toContain('/test/wave.test.js');
  });

  it('is idempotent (append-once) — a second call does not duplicate the entry', async () => {
    dir = await makeRepoDir();
    await excludeFromGit(dir, 'test/a.test.js');
    const second = await excludeFromGit(dir, 'test/a.test.js');

    expect(second).toEqual({ ok: true, excluded: false });
    const content = await readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    const hits = content.split('\n').filter((l) => l.trim() === '/test/a.test.js');
    expect(hits).toHaveLength(1);
  });

  it('preserves existing exclude content and stays newline-terminated', async () => {
    dir = await makeRepoDir();
    const excludeFile = path.join(dir, '.git', 'info', 'exclude');
    await writeFile(excludeFile, '# existing\n*.log', 'utf8'); // no trailing newline

    await excludeFromGit(dir, 'test/b.test.js');

    const content = await readFile(excludeFile, 'utf8');
    expect(content).toContain('*.log');
    expect(content).toContain('/test/b.test.js');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('creates .git/info/exclude when only .git exists', async () => {
    dir = await makeRepoDir(false);
    await mkdir(path.join(dir, '.git'), { recursive: true });

    const result = await excludeFromGit(dir, 'test/c.test.js');

    expect(result.ok).toBe(true);
    const content = await readFile(path.join(dir, '.git', 'info', 'exclude'), 'utf8');
    expect(content).toContain('/test/c.test.js');
  });

  it('fails closed (never throws) when there is no .git directory', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-nogit-'));
    // A plain file at .git (worktree/submodule style) makes mkdir under it fail.
    await writeFile(path.join(dir, '.git'), 'gitdir: /elsewhere\n', 'utf8');

    const result = await excludeFromGit(dir, 'test/d.test.js');
    expect(result.ok).toBe(false);
  });

  it('keeps an authored file out of `git status` yet the integrity guard still pins it', async () => {
    // A real git repo: write an authored verification file, exclude it, and confirm BOTH (a) it never
    // shows in `git status` and (b) the content-hash integrity guard still detects tampering — proving
    // "excluded ≠ unprotected" (issue #52).
    dir = await mkdtemp(path.join(tmpdir(), 'goaly-guard-'));
    await runProcess('git', ['-C', dir, 'init', '-q']);
    await mkdir(path.join(dir, 'test'), { recursive: true });
    const rel = 'test/wave.test.js';
    const content = 'test("wave", () => {});\n';
    await writeFile(path.join(dir, rel), content, 'utf8');
    await excludeFromGit(dir, rel);

    // (a) absent from git status (the exclude entry hides it).
    const status = await runProcess('git', ['-C', dir, 'status', '--porcelain']);
    expect(status.stdout).not.toContain('wave.test.js');

    // (b) the guard pins it by content hash read from disk — intact passes, tampered fails closed.
    const guard = new GeneratedFilesGuard([{ path: rel, sha256: sha256Hex(content) }]);
    const ws = new GitWorkspace(dir);
    expect((await guard.verify(ws, 'g', '')).pass).toBe(true);

    await writeFile(path.join(dir, rel), content + '// tampered\n', 'utf8');
    expect((await guard.verify(ws, 'g', '')).pass).toBe(false);
  });
});
