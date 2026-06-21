import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitWorkspace } from './git-workspace';

/** Run a git command synchronously in `cwd`, throwing on failure (setup only). */
function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
}

describe('GitWorkspace (integration, real git)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-gw-test-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test User');
    await writeFile(join(root, 'file.txt'), 'hello\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'initial');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('diffHash is stable across two calls with no change', async () => {
    const ws = new GitWorkspace(root);
    const a = await ws.diffHash();
    const b = await ws.diffHash();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
  });

  it('diffHash changes after modifying a file', async () => {
    const ws = new GitWorkspace(root);
    const before = await ws.diffHash();
    await writeFile(join(root, 'file.txt'), 'goodbye\n');
    const after = await ws.diffHash();
    expect(after).not.toBe(before);
  });

  it('diffHash does not mutate the real git index', async () => {
    const ws = new GitWorkspace(root);
    // Introduce an unstaged change.
    await writeFile(join(root, 'file.txt'), 'changed\n');
    await ws.diffHash();
    // The real index must still be clean (the change remains unstaged).
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
    expect(status.stdout).toContain(' M file.txt');
  });

  it('diff includes untracked files', async () => {
    const ws = new GitWorkspace(root);
    await writeFile(join(root, 'new-untracked.txt'), 'fresh\n');
    const text = await ws.diff();
    expect(text).toContain('new-untracked.txt');
  });

  it('diff includes tracked modifications', async () => {
    const ws = new GitWorkspace(root);
    await writeFile(join(root, 'file.txt'), 'modified\n');
    const text = await ws.diff();
    expect(text).toContain('file.txt');
    expect(text).toContain('modified');
  });

  it("run('exit 3') yields exitCode 3 and never rejects", async () => {
    const ws = new GitWorkspace(root);
    const result = await ws.run('exit 3');
    expect(result.exitCode).toBe(3);
  });

  it('run captures stdout', async () => {
    const ws = new GitWorkspace(root);
    const result = await ws.run('printf hello-world');
    expect(result.stdout).toContain('hello-world');
    expect(result.exitCode).toBe(0);
  });

  it('run captures stderr', async () => {
    const ws = new GitWorkspace(root);
    const result = await ws.run('printf oops 1>&2');
    expect(result.stderr).toContain('oops');
  });

  it('exec runner is injectable (no real process spawned)', async () => {
    const calls: string[][] = [];
    const ws = new GitWorkspace(root, async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args.includes('write-tree')) {
        return { stdout: 'a'.repeat(40) + '\n', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    });
    const hash = await ws.diffHash();
    expect(hash).toBe('a'.repeat(40));
    expect(calls.some((c) => c.includes('add'))).toBe(true);
    expect(calls.some((c) => c.includes('write-tree'))).toBe(true);
  });
});
