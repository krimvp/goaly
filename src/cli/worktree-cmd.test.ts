import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runWorktree, renderWorktreeTable, type WorktreeCommand } from './worktree-cmd';
import type { WorktreeInfo } from '../workspace/worktree-manager';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('runWorktree — the goaly worktree subcommand', () => {
  let root: string;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-wt-cmd-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test User');
    await writeFile(join(root, 'f.txt'), 'x\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    out = [];
    err = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const run = (cmd: WorktreeCommand): Promise<number> =>
    runWorktree(cmd, root, (s) => out.push(s), (s) => err.push(s));

  it('create → list → remove round-trips with exit 0 and human output', async () => {
    expect(await run({ kind: 'create', name: 'feat', base: undefined })).toBe(0);
    expect(out.join('')).toContain("created worktree 'feat'");
    expect(out.join('')).toContain('--worktree feat');

    out = [];
    expect(await run({ kind: 'list' })).toBe(0);
    expect(out.join('')).toContain('feat');
    expect(out.join('')).toContain('goaly/feat');

    out = [];
    expect(await run({ kind: 'remove', name: 'feat', force: false, deleteBranch: false })).toBe(0);
    expect(out.join('')).toContain("removed worktree 'feat'");
    expect(out.join('')).toContain('git merge goaly/feat'); // branch kept ⇒ merge hint
  });

  it('an empty list says how to create one (exit 0)', async () => {
    expect(await run({ kind: 'list' })).toBe(0);
    expect(out.join('')).toContain('goaly worktree create');
  });

  it('a WorktreeError becomes a clear message + exit 2 (fail-closed, never a throw)', async () => {
    expect(await run({ kind: 'remove', name: 'nope', force: false, deleteBranch: false })).toBe(2);
    expect(err.join('')).toContain('no such worktree');

    err = [];
    await run({ kind: 'create', name: 'dup', base: undefined });
    expect(await run({ kind: 'create', name: 'dup', base: undefined })).toBe(2);
    expect(err.join('')).toContain('already exists');
  });

  it('remove --delete-branch drops the branch and skips the merge hint', async () => {
    await run({ kind: 'create', name: 'gone', base: undefined });
    out = [];
    expect(await run({ kind: 'remove', name: 'gone', force: false, deleteBranch: true })).toBe(0);
    expect(out.join('')).not.toContain('git merge');
    expect(
      spawnSync('git', ['rev-parse', '--verify', 'refs/heads/goaly/gone'], { cwd: root }).status,
    ).not.toBe(0);
  });
});

describe('renderWorktreeTable', () => {
  it('renders one aligned row per worktree, marking prunable entries', () => {
    const items: WorktreeInfo[] = [
      { name: 'a', path: '/w/a', branch: 'goaly/a', head: 'abcd1234', dirty: true, runs: 2, prunable: false },
      { name: 'b', path: '/w/b', branch: 'goaly/b', head: '?', dirty: false, runs: 0, prunable: true },
    ];
    const table = renderWorktreeTable(items);
    const lines = table.split('\n');
    expect(lines[0]).toMatch(/NAME\s+BRANCH\s+HEAD\s+DIRTY\s+RUNS\s+PATH/);
    expect(lines[1]).toContain('yes');
    expect(lines[2]).toContain('PRUNABLE');
  });
});
