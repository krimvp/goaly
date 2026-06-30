import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GitWorktreeHost } from './git-worktree-host';
import { GitWorkspace, realExec } from './git-workspace';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function host(root: string): GitWorktreeHost {
  return new GitWorktreeHost({ root, exec: realExec, excludes: ['.goaly'], scrubVerifyEnv: true });
}

describe('GitWorktreeHost (integration, real git) — best-of-N (issue #85)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-wt-host-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test User');
    await writeFile(join(root, 'file.txt'), 'base\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'initial');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('headResolves is true with a committed HEAD, false on an unborn branch', async () => {
    expect(await host(root).headResolves()).toBe(true);
    const fresh = await mkdtemp(join(tmpdir(), 'goaly-unborn-'));
    git(fresh, 'init', '-q');
    try {
      expect(await host(fresh).headResolves()).toBe(false);
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('addWorktree checks out the baseline tree into an isolated dir; removeWorktree tears it down', async () => {
    const h = host(root);
    const wt = await h.addWorktree('HEAD');
    // The worktree is a real, separate directory with the baseline content.
    expect(await readFile(join(wt.root, 'file.txt'), 'utf8')).toBe('base\n');
    // Edits in the worktree do NOT touch the canonical tree (isolation).
    await writeFile(join(wt.root, 'file.txt'), 'candidate edit\n');
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('base\n');
    // Its scope is a GitWorkspace rooted at the worktree.
    expect(wt.scope).toBeInstanceOf(GitWorkspace);

    await h.removeWorktree(wt);
    await expect(stat(wt.root)).rejects.toThrow();
  });

  it('addWorktree accepts a bare tree SHA (wraps it in a commit) and checks it out', async () => {
    const h = host(root);
    // A tree SHA from the canonical checkpoint machinery (no commit) — git worktree can't take it
    // directly, so the host wraps it. Build one by writing a tree off a modified index.
    await writeFile(join(root, 'extra.txt'), 'extra\n');
    const ws = new GitWorkspace(root);
    const tree = await ws.checkpoint(); // a tree SHA
    // Revert the working tree so only the worktree should carry `extra.txt`.
    await rm(join(root, 'extra.txt'));

    const wt = await h.addWorktree(tree);
    try {
      expect(await readFile(join(wt.root, 'extra.txt'), 'utf8')).toBe('extra\n');
    } finally {
      await h.removeWorktree(wt);
    }
  });

  it('promoteTree makes the canonical tree match the winning tree (no commit, HEAD untouched)', async () => {
    const h = host(root);
    const headBefore = git(root, 'rev-parse', 'HEAD');

    // Produce a winning tree in a worktree: edit a file + add a new one + delete the base file.
    const wt = await h.addWorktree('HEAD');
    await writeFile(join(wt.root, 'file.txt'), 'winner\n');
    await writeFile(join(wt.root, 'new.txt'), 'new file\n');
    const winningTree = await wt.scope.diffHash();
    await h.removeWorktree(wt);

    await h.promoteTree(winningTree);

    // The canonical working tree now matches the winner exactly.
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('winner\n');
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('new file\n');
    // HEAD never moved — promotion writes no user-visible commit.
    expect(git(root, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('promoteTree deletes a tracked file the winning tree dropped', async () => {
    // Add a second tracked file in the canonical tree.
    await writeFile(join(root, 'drop-me.txt'), 'temp\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'add drop-me');

    const h = host(root);
    // A winning tree WITHOUT drop-me.txt: snapshot a worktree after removing it.
    const wt = await h.addWorktree('HEAD');
    await rm(join(wt.root, 'drop-me.txt'));
    const winningTree = await wt.scope.diffHash();
    await h.removeWorktree(wt);

    await h.promoteTree(winningTree);
    await expect(stat(join(root, 'drop-me.txt'))).rejects.toThrow();
  });
});
