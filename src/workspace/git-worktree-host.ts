import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspace, type ExecResult, type ExecFn, type RunExecWrapper } from './git-workspace';
import type { Worktree, WorktreeHost } from './workspace';

/**
 * Git-backed {@link WorktreeHost} (issue #85, best-of-N). Creates linked git worktrees off a baseline
 * tree so K worker attempts run in ISOLATED working directories that never see each other's edits,
 * promotes a winning candidate's tree into the canonical workspace WITHOUT a user-visible commit, and
 * tears worktrees down. Lives on the workspace/effect seam — nothing here touches the pure reducer.
 *
 * Each candidate's harness runs in the worktree `root`; the frozen ladder scores against the worktree
 * `scope` (a {@link GitWorkspace} rooted there, sharing the canonical excludes + run-launcher so a
 * sandboxed verify command is jailed identically per candidate — locked decision #7).
 */
export class GitWorktreeHost implements WorktreeHost {
  readonly #root: string;
  readonly #exec: ExecFn;
  readonly #excludes: readonly string[];
  readonly #scrubVerifyEnv: boolean;
  readonly #runLauncher: RunExecWrapper | undefined;

  constructor(opts: {
    root: string;
    exec: ExecFn;
    excludes: readonly string[];
    scrubVerifyEnv: boolean;
    runLauncher?: RunExecWrapper;
  }) {
    this.#root = opts.root;
    this.#exec = opts.exec;
    this.#excludes = opts.excludes;
    this.#scrubVerifyEnv = opts.scrubVerifyEnv;
    this.#runLauncher = opts.runLauncher;
  }

  /** True when the repo has a resolvable HEAD; fail-safe to false (refuse best-of-N on an unborn tree). */
  async headResolves(): Promise<boolean> {
    try {
      const r = await this.#git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
      return r.code === 0;
    } catch {
      return false;
    }
  }

  /**
   * Create a detached worktree checked out at `treeish` (a ref or git tree SHA). A bare tree SHA is not
   * a commit-ish, so it is wrapped in a dangling commit via `commit-tree` first; a ref/commit is used
   * directly. Throws fail-closed on any git failure (the tournament scores that candidate a hard red).
   */
  async addWorktree(treeish: string): Promise<Worktree> {
    const commitish = await this.#toCommitish(treeish);
    const path = await mkdtemp(join(tmpdir(), 'goaly-wt-'));
    const added = await this.#git(['worktree', 'add', '--detach', path, commitish]);
    if (added.code !== 0) {
      await rm(path, { recursive: true, force: true });
      throw new Error(`git worktree add failed (code ${added.code}): ${added.stderr.trim()}`);
    }
    const scope = new GitWorkspace(path, this.#exec, this.#excludes, this.#scrubVerifyEnv, this.#runLauncher);
    return { root: path, scope };
  }

  /** Tear down a worktree (prune the registration + delete the directory). Never throws. */
  async removeWorktree(worktree: Worktree): Promise<void> {
    try {
      await this.#git(['worktree', 'remove', '--force', worktree.root]);
    } catch {
      /* best-effort: fall through to the directory delete + prune below */
    }
    await rm(worktree.root, { recursive: true, force: true }).catch(() => {});
    await this.#git(['worktree', 'prune']).catch(() => ({ stdout: '', stderr: '', code: 0 }));
  }

  /**
   * Promote a winning tree into the canonical workspace WITHOUT a commit: stage the tree into a
   * throwaway index, check every path out over the working tree (`checkout-index -a -f`), and delete
   * any tracked path that the winning tree dropped, so the canonical tree exactly matches the winner.
   * The user's real index/HEAD/branch are untouched (a fresh `GIT_INDEX_FILE`). Throws fail-closed.
   */
  async promoteTree(treeish: string): Promise<void> {
    const tmpIndex = join(tmpdir(), `goaly-promote-idx-${process.pid}-${Date.now()}`);
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    try {
      const before = await this.#trackedPaths();
      const read = await this.#git(['read-tree', treeish], env);
      if (read.code !== 0) throw new Error(`git read-tree failed (code ${read.code}): ${read.stderr.trim()}`);
      const out = await this.#git(['checkout-index', '-a', '-f'], env);
      if (out.code !== 0) {
        throw new Error(`git checkout-index failed (code ${out.code}): ${out.stderr.trim()}`);
      }
      // Files tracked before but absent from the promoted tree must be removed so the canonical tree
      // matches the winner exactly (checkout-index only writes files present in the index).
      const after = new Set(await this.#trackedPathsFromIndex(env));
      for (const path of before) {
        if (!after.has(path)) await rm(join(this.#root, path), { force: true }).catch(() => {});
      }
    } finally {
      await rm(tmpIndex, { force: true }).catch(() => {});
    }
  }

  /**
   * EXPERIMENTAL (parallel waves) — 3-way merge `ours` and `theirs` against `base` using the modern
   * plumbing `git merge-tree --write-tree --merge-base=<base>` (git ≥ 2.40): a REAL recursive merge
   * that writes only objects, never touching HEAD / index / working tree. Tree SHAs are wrapped in
   * dangling commits first (the plumbing takes commit-ish). Exit 0 ⇒ clean (first stdout line is the
   * merged tree OID); exit 1 ⇒ textual conflict (typed, with the conflicted paths — nothing is
   * applied anywhere); anything else throws fail-closed.
   */
  async mergeTrees(
    base: string,
    ours: string,
    theirs: string,
  ): Promise<{ kind: 'clean'; tree: string } | { kind: 'conflict'; detail: string }> {
    const b = await this.#toCommitish(base);
    const o = await this.#toCommitish(ours);
    const t = await this.#toCommitish(theirs);
    const r = await this.#git(['merge-tree', '--write-tree', `--merge-base=${b}`, o, t]);
    if (r.code === 0) {
      const tree = r.stdout.trim().split('\n')[0] ?? '';
      if (tree.length === 0) throw new Error('git merge-tree returned no tree OID');
      return { kind: 'clean', tree };
    }
    if (r.code === 1) {
      // Conflicted: stdout is <oid>\n<conflicted file sections>. Surface the file names for the log.
      const lines = splitLines(r.stdout).slice(1);
      return {
        kind: 'conflict',
        detail: lines.length > 0 ? lines.slice(0, 10).join(', ') : 'textual merge conflict',
      };
    }
    throw new Error(`git merge-tree failed (code ${r.code}): ${r.stderr.trim()}`);
  }

  /** Resolve `treeish` to a commit-ish: a ref/commit as-is, else wrap a bare tree SHA in a commit. */
  async #toCommitish(treeish: string): Promise<string> {
    const commit = await this.#git(['rev-parse', '--verify', '--quiet', `${treeish}^{commit}`]);
    if (commit.code === 0 && commit.stdout.trim().length > 0) return commit.stdout.trim();
    // Not a commit-ish — treat it as a tree SHA and wrap it in a dangling commit to check out.
    const wrapped = await this.#git(['commit-tree', treeish, '-m', 'goaly best-of-N baseline']);
    if (wrapped.code !== 0) {
      throw new Error(`git commit-tree failed (code ${wrapped.code}): ${wrapped.stderr.trim()}`);
    }
    return wrapped.stdout.trim();
  }

  /** Tracked working-tree paths (from the real index/HEAD), for the promote-time deletion pass. */
  async #trackedPaths(): Promise<string[]> {
    const r = await this.#git(['ls-files']);
    return splitLines(r.stdout);
  }

  /** Paths in the promoted tree's throwaway index (after read-tree), for the deletion diff. */
  async #trackedPathsFromIndex(env: NodeJS.ProcessEnv): Promise<string[]> {
    const r = await this.#git(['ls-files'], env);
    return splitLines(r.stdout);
  }

  #git(args: string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
    return this.#exec('git', ['-C', this.#root, ...args], {
      cwd: this.#root,
      ...(env !== undefined ? { env } : {}),
    });
  }
}

function splitLines(s: string): string[] {
  return s
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}
