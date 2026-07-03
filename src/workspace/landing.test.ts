import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { LandingManager, LandingError, extractPrUrl } from './landing';
import { realExec, type ExecFn } from './git-workspace';
import { WorktreeManager, WORKTREES_DIR } from './worktree-manager';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe('extractPrUrl', () => {
  it('pulls the PR URL out of gh output', () => {
    expect(extractPrUrl('https://github.com/o/r/pull/42\n')).toBe('https://github.com/o/r/pull/42');
    expect(extractPrUrl('Warning: ...\nhttps://github.com/o/r/pull/7\n')).toBe('https://github.com/o/r/pull/7');
    expect(extractPrUrl('no url here')).toBeNull();
  });
});

describe('LandingManager (integration, real git)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-landing-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test User');
    await writeFile(join(root, 'file.txt'), 'base\n');
    await writeFile(join(root, '.gitignore'), '.goaly/\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'initial');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const landing = (exec?: ExecFn, isRunActive?: (d: string) => Promise<boolean>): LandingManager =>
    new LandingManager({ root, ...(exec ? { exec } : {}), ...(isRunActive ? { isRunActive } : {}) });

  /**
   * Make a managed worktree with one uncommitted new file — AND a gitignored `.goaly/` state dir,
   * exactly like a real post-run worktree. The state dir is the regression trap: naming it in a
   * pathspec while it is gitignored+present makes `git add` error, so every commit-if-dirty path
   * (commit / merge / PR) must stage around it.
   */
  async function dirtyWorktree(name = 'feat'): Promise<string> {
    const info = await new WorktreeManager({ root }).create(name);
    await writeFile(join(info.path, 'added.txt'), 'hello\n');
    await mkdir(join(info.path, '.goaly', 'run-1'), { recursive: true });
    await writeFile(join(info.path, '.goaly', 'run-1', 'log.jsonl'), '{"tag":"DONE"}\n');
    return info.path;
  }

  it('changes() reports the dirty file list, no remote, and canPr=false in a bare local repo', async () => {
    const wtPath = await dirtyWorktree();
    const c = await landing().changes('feat');
    expect(c.branch).toBe('goaly/feat');
    expect(c.dirty).toBe(true);
    expect(c.ahead).toBe(0);
    expect(c.files.map((f) => f.path)).toContain('added.txt');
    expect(c.untracked).toBe(1);
    expect(c.remote).toBe(false);
    expect(c.canPr).toBe(false);
    expect(wtPath).toContain(join(WORKTREES_DIR, 'feat'));
  });

  it('commit() stages+commits, advances ahead, then refuses a clean tree', async () => {
    const wtPath = await dirtyWorktree();
    const { head } = await landing().commit('feat', 'add a file');
    expect(head).toMatch(/^[0-9a-f]{8}$/);
    const c = await landing().changes('feat');
    expect(c.dirty).toBe(false);
    expect(c.ahead).toBe(1);
    await expect(landing().commit('feat', 'again')).rejects.toThrow(/clean — nothing to commit/);
    // Regression: the gitignored `.goaly` state dir must NOT be committed (and must not have broken
    // the `git add`). Only the real work landed.
    const tracked = git(wtPath, 'ls-files');
    expect(tracked).toContain('added.txt');
    expect(tracked).not.toContain('.goaly');
  });

  it('commit() refuses while a live run holds the worktree', async () => {
    const wtPath = await dirtyWorktree();
    await mkdir(join(wtPath, '.goaly', 'run-x'), { recursive: true });
    const isRunActive = async (dir: string): Promise<boolean> => dir.endsWith('run-x');
    await expect(landing(undefined, isRunActive).commit('feat', 'x')).rejects.toThrow(/LIVE goaly run/);
  });

  it('merge() commits-if-dirty then merges the branch into main', async () => {
    await dirtyWorktree();
    const { merged, head } = await landing().merge('feat', { commitMessage: 'land it' });
    expect(merged).toBe('goaly/feat');
    expect(head).toMatch(/^[0-9a-f]{8}$/);
    // The worktree's file is now on the main workspace tree.
    expect(await readFile(join(root, 'added.txt'), 'utf8')).toBe('hello\n');
  });

  it('merge() refuses when the main workspace is dirty', async () => {
    await dirtyWorktree();
    await writeFile(join(root, 'file.txt'), 'dirtied\n');
    await expect(landing().merge('feat')).rejects.toThrow(/main workspace has uncommitted changes/);
  });

  it('merge() aborts on conflict and leaves main untouched', async () => {
    // Branch and main both change file.txt differently → a merge conflict.
    const info = await new WorktreeManager({ root }).create('conf');
    await writeFile(join(info.path, 'file.txt'), 'from-branch\n');
    await landing().commit('conf', 'branch edit');
    await writeFile(join(root, 'file.txt'), 'from-main\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'main edit');
    const before = git(root, 'rev-parse', 'HEAD');

    await expect(landing().merge('conf')).rejects.toThrow(/conflicts and was aborted/);
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before); // main is unchanged
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('from-main\n');
    // No merge left in progress (MERGE_HEAD would exist if not aborted).
    expect(spawnSync('git', ['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: root }).status).not.toBe(0);
  });

  it('openPr() fails closed with no origin remote', async () => {
    await dirtyWorktree();
    await expect(landing().openPr('feat', { title: 'x' })).rejects.toThrow(/no 'origin' remote/);
  });

  it('openPr() commits, pushes, and runs gh pr create (network + gh faked)', async () => {
    await dirtyWorktree();
    const seen: string[] = [];
    // Real git for local plumbing; fake the two calls that would leave the machine.
    const exec: ExecFn = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === '--version') {
        return Promise.resolve({ stdout: 'gh version 2.0.0', stderr: '', code: 0 });
      }
      if (cmd === 'gh' && args[0] === 'pr') {
        seen.push(`gh ${args.join(' ')}`);
        return Promise.resolve({ stdout: 'https://github.com/krimvp/goaly/pull/99\n', stderr: '', code: 0 });
      }
      if (cmd === 'git' && args.includes('get-url')) {
        return Promise.resolve({ stdout: 'git@github.com:krimvp/goaly.git', stderr: '', code: 0 });
      }
      if (cmd === 'git' && args.includes('push')) {
        seen.push('push');
        return Promise.resolve({ stdout: '', stderr: '', code: 0 });
      }
      return realExec(cmd, args, opts);
    };
    const { url } = await landing(exec).openPr('feat', { title: 'My PR', body: 'body text', base: 'main' });
    expect(url).toBe('https://github.com/krimvp/goaly/pull/99');
    expect(seen).toContain('push');
    expect(seen.some((s) => s.startsWith('gh pr create') && s.includes('--head goaly/feat'))).toBe(true);
    // The dirty change was committed before the push.
    expect((await landing(exec).changes('feat')).dirty).toBe(false);
  });

  it('operations fail closed on an unknown worktree', async () => {
    await expect(landing().changes('nope')).rejects.toThrow(LandingError);
    await expect(landing().commit('nope', 'm')).rejects.toThrow(/no such worktree/);
  });

  // ---- main-workspace landing (a run made WITHOUT --worktree) ----------------

  it('changesMain() reports the main workspace changes on its current branch', async () => {
    await writeFile(join(root, 'main-work.txt'), 'edit\n');
    const c = await landing().changesMain();
    expect(c.branch).toBe(git(root, 'branch', '--show-current'));
    expect(c.dirty).toBe(true);
    expect(c.files.map((f) => f.path)).toContain('main-work.txt');
  });

  it('commitMain() commits onto the current branch', async () => {
    await writeFile(join(root, 'main-work.txt'), 'edit\n');
    const { head } = await landing().commitMain('land on main');
    expect(head).toMatch(/^[0-9a-f]{8}$/);
    expect((await landing().changesMain()).dirty).toBe(false);
    expect(git(root, 'log', '--oneline', '-1')).toContain('land on main');
  });

  it('openPrFromMain() ejects the changes onto goaly/<name>, opens the PR, and returns to the original branch', async () => {
    const original = git(root, 'branch', '--show-current');
    await writeFile(join(root, 'feature.txt'), 'new feature\n');
    const seen: string[] = [];
    const exec: ExecFn = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === '--version') return Promise.resolve({ stdout: 'gh 2', stderr: '', code: 0 });
      if (cmd === 'gh' && args[0] === 'pr') {
        seen.push(`gh ${args.join(' ')}`);
        return Promise.resolve({ stdout: 'https://github.com/o/r/pull/12\n', stderr: '', code: 0 });
      }
      if (cmd === 'git' && args.includes('get-url')) return Promise.resolve({ stdout: 'git@github.com:o/r.git', stderr: '', code: 0 });
      if (cmd === 'git' && args.includes('push')) {
        seen.push('push');
        return Promise.resolve({ stdout: '', stderr: '', code: 0 });
      }
      return realExec(cmd, args, opts);
    };
    const res = await landing(exec).openPrFromMain({ name: 'myfeat', title: 'My feature' });
    expect(res).toEqual({ url: 'https://github.com/o/r/pull/12', branch: 'goaly/myfeat' });
    // Returned to the original branch with a clean tree.
    expect(git(root, 'branch', '--show-current')).toBe(original);
    expect(git(root, 'status', '--porcelain')).toBe('');
    // The work was committed on the ejected branch, with the original branch as the PR base.
    expect(git(root, 'log', '--oneline', 'goaly/myfeat', '-1')).toContain('goaly: myfeat');
    expect(git(root, 'show', 'goaly/myfeat:feature.txt')).toBe('new feature');
    expect(seen).toContain('push');
    expect(seen.some((s) => s.includes('--head goaly/myfeat') && s.includes(`--base ${original}`))).toBe(true);
  });

  it('openPrFromMain() fails closed on a clean tree, a taken branch name, and returns home on failure', async () => {
    const original = git(root, 'branch', '--show-current');
    // Clean tree → nothing to eject.
    await expect(landing().openPrFromMain({ name: 'x', title: 't' })).rejects.toThrow(/no uncommitted changes/);
    // Taken branch name.
    git(root, 'branch', 'goaly/taken');
    await writeFile(join(root, 'f.txt'), 'x\n');
    await expect(landing().openPrFromMain({ name: 'taken', title: 't' })).rejects.toThrow(/already exists/);
    // A push failure still returns the operator to their original branch (work preserved on the branch).
    const failPush: ExecFn = (cmd, args, opts) => {
      if (cmd === 'gh' && args[0] === '--version') return Promise.resolve({ stdout: 'gh', stderr: '', code: 0 });
      if (cmd === 'git' && args.includes('get-url')) return Promise.resolve({ stdout: 'git@github.com:o/r.git', stderr: '', code: 0 });
      if (cmd === 'git' && args.includes('push')) return Promise.resolve({ stdout: '', stderr: 'denied', code: 1 });
      return realExec(cmd, args, opts);
    };
    await expect(landing(failPush).openPrFromMain({ name: 'pushfail', title: 't' })).rejects.toThrow(/push .* failed/);
    expect(git(root, 'branch', '--show-current')).toBe(original);
  });
});
