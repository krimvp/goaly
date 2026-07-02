import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { WorktreeManager, WorktreeError, WorktreeName, worktreeBranch, WORKTREES_DIR } from './worktree-manager';
import { CliInput, cliInputToRunConfig } from '../domain/config';

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

describe('WorktreeName (the fail-closed name seam)', () => {
  it.each(['foo', 'wt-1a2b3c4d', 'A.b_c-d', 'x'.repeat(64)])('accepts %s', (name) => {
    expect(WorktreeName.safeParse(name).success).toBe(true);
  });

  it.each([
    '',
    '.',
    '..',
    '../x',
    'a/b',
    '-x',
    '.hidden',
    'a..b',
    'trailing.',
    'foo.lock',
    'x'.repeat(65),
    'sp ace',
  ])('rejects %j', (name) => {
    expect(WorktreeName.safeParse(name).success).toBe(false);
  });
});

describe('WorktreeManager (integration, real git)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-wtm-'));
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

  const manager = (): WorktreeManager => new WorktreeManager({ root });

  it('create makes a checkout under .goaly/worktrees/<name> on branch goaly/<name>', async () => {
    const info = await manager().create('foo');
    expect(info.path).toBe(join(root, WORKTREES_DIR, 'foo'));
    expect(info.branch).toBe('goaly/foo');
    expect(info.dirty).toBe(false);
    expect(info.runs).toBe(0);
    expect(await readFile(join(info.path, 'file.txt'), 'utf8')).toBe('base\n');
    expect(git(info.path, 'branch', '--show-current')).toBe('goaly/foo');
    // Isolation: edits in the worktree never touch the canonical tree.
    await writeFile(join(info.path, 'file.txt'), 'edited\n');
    expect(await readFile(join(root, 'file.txt'), 'utf8')).toBe('base\n');
  });

  it('create respects --base and fails closed on an unresolvable base', async () => {
    await writeFile(join(root, 'file.txt'), 'v2\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'v2');
    const info = await manager().create('old', 'HEAD~1');
    expect(await readFile(join(info.path, 'file.txt'), 'utf8')).toBe('base\n');
    await expect(manager().create('bad', 'no-such-ref')).rejects.toThrow(WorktreeError);
  });

  it('create fails closed on an unborn HEAD with a clear message', async () => {
    const fresh = await mkdtemp(join(tmpdir(), 'goaly-wtm-unborn-'));
    git(fresh, 'init', '-q');
    try {
      await expect(new WorktreeManager({ root: fresh }).create('foo')).rejects.toThrow(
        /HEAD does not resolve/,
      );
    } finally {
      await rm(fresh, { recursive: true, force: true });
    }
  });

  it('create refuses an existing worktree; ensure reuses it', async () => {
    await manager().create('foo');
    await expect(manager().create('foo')).rejects.toThrow(/already exists/);
    const info = await manager().ensure('foo');
    expect(info.branch).toBe('goaly/foo');
  });

  it('create re-attaches to a kept branch (and rejects --base then)', async () => {
    const m = manager();
    const first = await m.create('foo');
    await writeFile(join(first.path, 'file.txt'), 'work\n');
    git(first.path, 'add', '-A');
    git(first.path, 'commit', '-q', '-m', 'work on foo');
    await m.remove('foo'); // branch kept by default
    expect(git(root, 'rev-parse', '--verify', 'refs/heads/goaly/foo')).not.toBe('');

    await expect(m.create('foo', 'HEAD')).rejects.toThrow(/pins the base/);
    const reattached = await m.create('foo');
    expect(await readFile(join(reattached.path, 'file.txt'), 'utf8')).toBe('work\n');
  });

  it('rejects invalid names fail-closed (WorktreeError, no git call side effects)', async () => {
    await expect(manager().create('../escape')).rejects.toThrow(WorktreeError);
    await expect(manager().remove('a/b')).rejects.toThrow(WorktreeError);
  });

  it('list reports managed worktrees only, with dirty flag and runs count', async () => {
    const m = manager();
    // A non-managed worktree elsewhere must not show up.
    const outside = await mkdtemp(join(tmpdir(), 'goaly-wtm-outside-'));
    await rm(outside, { recursive: true, force: true });
    git(root, 'worktree', 'add', '--detach', outside, 'HEAD');

    const a = await m.create('aaa');
    await m.create('bbb');
    await writeFile(join(a.path, 'file.txt'), 'dirty\n');
    // Fabricate a recorded run under aaa's state dir (header.json makes it a run).
    const runDir = join(a.path, '.goaly', 'run-11111111-1111-1111-1111-111111111111');
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, 'header.json'),
      JSON.stringify({
        runId: 'run-11111111-1111-1111-1111-111111111111',
        startedAt: 1,
        config: minimalConfig(),
      }),
    );

    const listed = await m.list();
    expect(listed.map((w) => w.name)).toEqual(['aaa', 'bbb']);
    expect(listed[0]).toMatchObject({ name: 'aaa', dirty: true, runs: 1, branch: 'goaly/aaa' });
    expect(listed[1]).toMatchObject({ name: 'bbb', dirty: false, runs: 0 });

    await rm(outside, { recursive: true, force: true });
  });

  it('the worktree state dir (.goaly) never counts as dirty', async () => {
    const m = manager();
    const info = await m.create('foo');
    await mkdir(join(info.path, '.goaly', 'run-x'), { recursive: true });
    await writeFile(join(info.path, '.goaly', 'run-x', 'log.jsonl'), '');
    expect((await m.list())[0]?.dirty).toBe(false);
  });

  it('list surfaces a prunable worktree (checkout deleted, registration kept)', async () => {
    const m = manager();
    const info = await m.create('gone');
    await rm(info.path, { recursive: true, force: true });
    const listed = await m.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'gone', prunable: true, dirty: false, runs: 0 });
  });

  it('remove refuses a dirty worktree without force, removes with force, keeps the branch', async () => {
    const m = manager();
    const info = await m.create('foo');
    await writeFile(join(info.path, 'file.txt'), 'dirty\n');
    await expect(m.remove('foo')).rejects.toThrow(/uncommitted changes/);
    await m.remove('foo', { force: true });
    await expect(stat(info.path)).rejects.toThrow();
    // Branch kept by default for merge-back.
    expect(git(root, 'rev-parse', '--verify', 'refs/heads/goaly/foo')).not.toBe('');
  });

  it('remove --delete-branch deletes a merged branch; an unmerged one needs force', async () => {
    const m = manager();
    // Merged case: no commits on the branch ⇒ -d succeeds.
    await m.create('merged');
    await m.remove('merged', { deleteBranch: true });
    expect(
      spawnSync('git', ['rev-parse', '--verify', 'refs/heads/goaly/merged'], { cwd: root }).status,
    ).not.toBe(0);

    // Unmerged case: a commit on the branch ⇒ plain -d refuses, force -D succeeds.
    const info = await m.create('unmerged');
    await writeFile(join(info.path, 'file.txt'), 'work\n');
    git(info.path, 'add', '-A');
    git(info.path, 'commit', '-q', '-m', 'unmerged work');
    await expect(m.remove('unmerged', { deleteBranch: true })).rejects.toThrow(/deleting branch/);
    // The worktree itself is gone even though the branch delete refused (message says how to keep merging).
    await m
      .create('unmerged')
      .then(() => m.remove('unmerged', { deleteBranch: true, force: true }));
    expect(
      spawnSync('git', ['rev-parse', '--verify', 'refs/heads/goaly/unmerged'], { cwd: root }).status,
    ).not.toBe(0);
  });

  it('remove refuses (even with force) while a LIVE goaly run holds a lock inside', async () => {
    const m = new WorktreeManager({ root, isRunActive: async () => true });
    const info = await m.create('busy');
    await mkdir(join(info.path, '.goaly', 'run-live'), { recursive: true });
    await writeFile(join(info.path, '.goaly', 'run-live', 'run.lock'), `${process.pid}\n`);
    await expect(m.remove('busy', { force: true })).rejects.toThrow(/LIVE goaly run/);
  });

  it('remove of an unknown worktree is a clear error', async () => {
    await expect(manager().remove('nope')).rejects.toThrow(/no such worktree/);
  });

  it('mergeHint names the branch and the commit + merge steps', () => {
    const hint = manager().mergeHint('foo');
    expect(hint).toContain(worktreeBranch('foo'));
    expect(hint).toContain('git merge goaly/foo');
    expect(hint).toContain('add -A');
  });
});

/** A real, schema-valid RunConfig for the fabricated run header. */
function minimalConfig(): unknown {
  return cliInputToRunConfig(CliInput.parse({ goal: 'g', verifyCmd: 'true' }));
}
