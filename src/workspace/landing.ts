import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { realExec, type ExecFn, type ExecResult } from './git-workspace';
import { WorktreeName, WORKTREES_DIR, worktreeBranch } from './worktree-manager';
import { runLockActive, anyRunLockActive } from '../runlog/lock';

/**
 * Post-run **landing**: what you do with a goaly result AFTER it lands on DONE. goaly's mission
 * ends at the frozen success contract (verified + approved); committing, merging, and opening a
 * PR are deliberately OUTSIDE that contract — a proven result still has to be shipped by hand. The
 * {@link WorktreeManager} makes and lists worktrees; this sibling module lands the branch a
 * worktree lives on (`goaly/<name>`).
 *
 * Every git/gh call goes through the injectable {@link ExecFn} (never a shell — the caller's commit
 * message / PR title are argv, so no injection); every failure is a typed {@link LandingError} with
 * an operator message (invariant #4: fail closed). Two writers in one tree is never safe, so every
 * MUTATING op refuses while a live goaly run holds the worktree (or, for a merge, the main tree).
 */

/** The per-file view of what a worktree changed, from `git status --porcelain`. */
export type ChangedFile = {
  /** The two-character porcelain status (e.g. ` M`, `??`, `A `). */
  readonly status: string;
  readonly path: string;
};

/** The read-only `changes(name)` projection — everything the Landing panel needs to render. */
export type WorktreeChanges = {
  readonly branch: string;
  readonly head: string;
  /** Uncommitted changes present (the worktree's own `.goaly` state dir is never counted). */
  readonly dirty: boolean;
  /** Commits on `goaly/<name>` not yet reachable from the main workspace HEAD. */
  readonly ahead: number;
  readonly files: readonly ChangedFile[];
  /** How many of {@link files} are untracked (`??`) — their content is not in {@link diff} yet. */
  readonly untracked: number;
  /** `git diff HEAD` of the tracked changes, capped at {@link MAX_DIFF_CHARS}. */
  readonly diff: string;
  readonly diffTruncated: boolean;
  /** An `origin` remote exists (a PR needs somewhere to push). */
  readonly remote: boolean;
  /** The `gh` CLI is on PATH (a PR is opened with `gh pr create`). */
  readonly ghAvailable: boolean;
  /** `remote && ghAvailable` — the UI enables the "Open PR" action only then. */
  readonly canPr: boolean;
};

/** Options for {@link LandingManager.merge} — an optional commit message for the commit-if-dirty step. */
export type MergeOpts = { commitMessage?: string | undefined };

/** Options for {@link LandingManager.openPr}. `title` is required; the rest are optional. */
export type OpenPrOpts = {
  title: string;
  body?: string | undefined;
  base?: string | undefined;
  commitMessage?: string | undefined;
};

/** Fail-closed landing failure: a clear operator message, mapped to 422/409 by the UI router. */
export class LandingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LandingError';
  }
}

/** Cap on the diff served to the browser (the file list is the complete picture regardless). */
export const MAX_DIFF_CHARS = 100_000;

/**
 * Lands the work a goaly worktree produced. Constructed with the MAIN workspace root (the repo the
 * worktrees hang off); each op resolves the worktree at `.goaly/worktrees/<name>` on branch
 * `goaly/<name>`. Mirrors {@link WorktreeManager}'s shape: injectable `exec` + `isRunActive` seams.
 */
export class LandingManager {
  readonly #root: string;
  readonly #exec: ExecFn;
  readonly #isRunActive: (runDir: string) => Promise<boolean>;

  constructor(opts: {
    /** The MAIN workspace root (the repo the worktrees hang off). */
    root: string;
    /** Injected process runner (tests). Defaults to the shared real spawn helper. */
    exec?: ExecFn;
    /** Injected run-liveness probe (tests). Defaults to the run.lock pid check. */
    isRunActive?: (runDir: string) => Promise<boolean>;
  }) {
    this.#root = opts.root;
    this.#exec = opts.exec ?? realExec;
    this.#isRunActive = opts.isRunActive ?? runLockActive;
  }

  /** Absolute path a worktree of this name lives at. */
  pathFor(name: string): string {
    return resolve(this.#root, WORKTREES_DIR, name);
  }

  /**
   * The read-only change set of a worktree: file list, tracked diff, ahead-count, and whether a PR
   * is even possible here. Never mutates; usable on a read-only server.
   */
  async changes(name: string): Promise<WorktreeChanges> {
    const { path, branch } = await this.#resolve(name);
    return this.#changesAt(path, branch, await this.#ahead(branch));
  }

  /**
   * The read-only change set of the MAIN workspace itself (a run made WITHOUT `--worktree`): the
   * uncommitted work on the currently checked-out branch. Same shape as {@link changes}; `ahead` is
   * the count of local commits not yet on the branch's upstream. Read-only.
   */
  async changesMain(): Promise<WorktreeChanges> {
    const branch = await this.#currentBranch(this.#root);
    return this.#changesAt(this.#root, branch, await this.#unpushed(this.#root));
  }

  /**
   * Stage every change (except the worktree's own `.goaly`) and commit it on `goaly/<name>`.
   * Fail-closed when a live run holds the worktree or the tree is already clean.
   */
  async commit(name: string, message: string): Promise<{ head: string }> {
    const { path } = await this.#resolve(name);
    await this.#refuseIfLive(path, name);
    return this.#commitAll(path, message);
  }

  /**
   * Merge `goaly/<name>` back into the MAIN workspace. Commits any pending worktree changes first
   * (using `commitMessage`, else `goaly: <name>`), refuses when the main tree is dirty or a live run
   * holds either tree, and — on a conflict — aborts the merge so main is never left half-merged.
   */
  async merge(name: string, opts: MergeOpts = {}): Promise<{ merged: string; head: string }> {
    const { path, branch } = await this.#resolve(name);
    await this.#refuseIfLive(path, name);
    if (await anyRunLockActive(join(this.#root, '.goaly'))) {
      throw new LandingError('a live goaly run is active in the main workspace — wait for it or stop it before merging');
    }
    if ((await this.#status(this.#root)).length > 0) {
      throw new LandingError('the main workspace has uncommitted changes — commit or stash them before merging');
    }
    if (await this.#isDirty(path)) {
      await this.#commitAll(path, opts.commitMessage ?? `goaly: ${name}`);
    }
    if ((await this.#ahead(branch)) === 0) {
      throw new LandingError(`nothing to merge — ${branch} is not ahead of the main workspace`);
    }
    const merged = await this.#git(['merge', '--no-ff', branch, '-m', `Merge ${branch}`]);
    if (merged.code !== 0) {
      const conflicts = await this.#git(['diff', '--name-only', '--diff-filter=U']);
      await this.#git(['merge', '--abort']).catch(() => undefined);
      const files = conflicts.stdout.trim();
      throw new LandingError(
        `merge of ${branch} hit conflicts and was aborted (main is unchanged)` +
          (files.length > 0 ? `:\n${files}` : `: ${merged.stderr.trim()}`),
      );
    }
    return { merged: branch, head: await this.#headOf(this.#root) };
  }

  /**
   * Open a pull request for `goaly/<name>`: commit any pending changes, push the branch to
   * `origin`, then `gh pr create`. Fail-closed with a precise message when there is no remote, `gh`
   * is missing/unauthed, the push is rejected, or `gh` errors. Returns the PR URL `gh` prints.
   */
  async openPr(name: string, opts: OpenPrOpts): Promise<{ url: string }> {
    const { path, branch } = await this.#resolve(name);
    await this.#refuseIfLive(path, name);
    if (!(await this.#hasOrigin(path))) {
      throw new LandingError("no 'origin' remote — add one (git remote add origin <url>) before opening a PR");
    }
    if (!(await this.#hasGh(path))) {
      throw new LandingError('the GitHub CLI (gh) is not installed — install it or open the PR manually from the pushed branch');
    }
    if (await this.#isDirty(path)) {
      await this.#commitAll(path, opts.commitMessage ?? `goaly: ${name}`);
    }
    if ((await this.#ahead(branch)) === 0) {
      throw new LandingError(`nothing to open a PR for — ${branch} has no commits beyond the main workspace`);
    }
    return this.#pushAndOpenPr(path, branch, opts);
  }

  /**
   * Commit the MAIN workspace's uncommitted changes onto the currently checked-out branch.
   * Fail-closed when a live run holds the main tree or it is already clean.
   */
  async commitMain(message: string): Promise<{ head: string }> {
    await this.#refuseIfLive(this.#root, 'the main workspace');
    return this.#commitAll(this.#root, message);
  }

  /**
   * Open a PR for a run that happened in the MAIN workspace. Because you cannot PR the checked-out
   * branch into itself, the uncommitted work is **ejected onto a fresh `goaly/<name>` branch**: a
   * new branch is created carrying the changes, they are committed and pushed, `gh pr create` opens
   * the PR (base = the original branch), and the workspace is then **switched back to the original
   * branch with a clean tree**. Fail-closed at every step; on any failure after the branch switch
   * the workspace is still returned to where it started (the work is preserved on `goaly/<name>`).
   */
  async openPrFromMain(opts: OpenPrOpts & { name: string }): Promise<{ url: string; branch: string }> {
    const parsed = WorktreeName.safeParse(opts.name);
    if (!parsed.success) {
      throw new LandingError(`invalid branch name '${opts.name}': ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    const branch = worktreeBranch(parsed.data);
    await this.#refuseIfLive(this.#root, 'the main workspace');
    if (!(await this.#isDirty(this.#root))) {
      throw new LandingError('nothing to open a PR for — the main workspace has no uncommitted changes');
    }
    const original = await this.#currentBranch(this.#root);
    if (original === '(detached)') {
      throw new LandingError('the main workspace is in a detached HEAD — check out a branch before opening a PR');
    }
    if (await this.#refExists(`refs/heads/${branch}`)) {
      throw new LandingError(`branch ${branch} already exists — pick another name, or delete it: git branch -D ${branch}`);
    }
    if (!(await this.#hasOrigin(this.#root))) {
      throw new LandingError("no 'origin' remote — add one (git remote add origin <url>) before opening a PR");
    }
    if (!(await this.#hasGh(this.#root))) {
      throw new LandingError('the GitHub CLI (gh) is not installed — install it or open the PR manually from a branch');
    }
    // Carry the uncommitted changes onto the new branch (a clean fast-forward — no conflict possible).
    const created = await this.#git(['switch', '-c', branch]);
    if (created.code !== 0) {
      throw new LandingError(`could not create branch ${branch}: ${created.stderr.trim()}`);
    }
    try {
      await this.#commitAll(this.#root, opts.commitMessage ?? `goaly: ${parsed.data}`);
      return { ...(await this.#pushAndOpenPr(this.#root, branch, { ...opts, base: opts.base ?? original })), branch };
    } finally {
      // Always return the operator to where they started — the work is committed on `branch`, so
      // the switch-back is clean whether the PR succeeded or the push/gh step failed.
      await this.#git(['switch', original]).catch(() => undefined);
    }
  }

  // ---- internals ------------------------------------------------------------

  /** The read-only change set at a checkout `path` on `branch` (shared by worktree + main). */
  async #changesAt(path: string, branch: string, ahead: number): Promise<WorktreeChanges> {
    const files = await this.#status(path);
    const rawDiff = await this.#gitAt(path, ['diff', 'HEAD', '--', '.', ':(exclude).goaly']);
    const diff = rawDiff.code === 0 ? rawDiff.stdout : '';
    const diffTruncated = diff.length > MAX_DIFF_CHARS;
    const remote = await this.#hasOrigin(path);
    const ghAvailable = await this.#hasGh(path);
    return {
      branch,
      head: await this.#headOf(path),
      dirty: files.length > 0,
      ahead,
      files,
      untracked: files.filter((f) => f.status.startsWith('??')).length,
      diff: diffTruncated ? diff.slice(0, MAX_DIFF_CHARS) : diff,
      diffTruncated,
      remote,
      ghAvailable,
      canPr: remote && ghAvailable,
    };
  }

  /** Push `branch` to origin then `gh pr create`; fail-closed on push/gh errors. Returns the URL. */
  async #pushAndOpenPr(path: string, branch: string, opts: OpenPrOpts): Promise<{ url: string }> {
    const push = await this.#gitAt(path, ['push', '-u', 'origin', branch]);
    if (push.code !== 0) {
      throw new LandingError(`git push of ${branch} failed: ${push.stderr.trim() || `exit ${push.code}`}`);
    }
    const args = ['pr', 'create', '--head', branch, '--title', opts.title, '--body', opts.body ?? ''];
    if (opts.base !== undefined && opts.base.length > 0) args.push('--base', opts.base);
    const pr = await this.#exec('gh', args, { cwd: path });
    if (pr.code !== 0) {
      throw new LandingError(`gh pr create failed: ${pr.stderr.trim() || pr.stdout.trim() || `exit ${pr.code}`}`);
    }
    const url = extractPrUrl(pr.stdout);
    if (url === null) {
      throw new LandingError(`opened the PR but could not read its URL from gh output: ${pr.stdout.trim()}`);
    }
    return { url };
  }

  /** Parse the name, confirm the worktree exists, and hand back its path + branch. */
  async #resolve(name: string): Promise<{ path: string; branch: string }> {
    const parsed = WorktreeName.safeParse(name);
    if (!parsed.success) {
      throw new LandingError(`invalid worktree name '${name}': ${parsed.error.issues[0]?.message ?? 'invalid'}`);
    }
    const path = this.pathFor(parsed.data);
    if (!(await exists(path))) {
      throw new LandingError(`no such worktree: ${parsed.data} (list them with: goaly worktree list)`);
    }
    return { path, branch: worktreeBranch(parsed.data) };
  }

  /** Stage everything (bar `.goaly`) and commit; fail-closed when nothing is staged. */
  async #commitAll(path: string, message: string): Promise<{ head: string }> {
    // `git add -A` (no pathspec) stages every change; a gitignored `.goaly` is auto-skipped. We do
    // NOT name `.goaly` in a pathspec: when it exists on disk AND is gitignored (the normal case
    // after a run), an explicit `:(exclude).goaly` match makes git error `paths are ignored … Use
    // -f` and stage nothing. Instead stage all, then defensively unstage the state dir — that keeps
    // it out of the commit whether or not the repo happens to gitignore it. Both steps exit 0.
    const add = await this.#gitAt(path, ['add', '-A']);
    if (add.code !== 0) throw new LandingError(`git add failed: ${add.stderr.trim()}`);
    await this.#gitAt(path, ['reset', '-q', '--', '.goaly']);
    // Nothing staged ⇒ a clean tree ⇒ refuse (an empty commit is never what the operator meant).
    if ((await this.#gitAt(path, ['diff', '--cached', '--quiet'])).code === 0) {
      throw new LandingError('worktree is clean — nothing to commit');
    }
    const commit = await this.#gitAt(path, ['commit', '-m', message]);
    if (commit.code !== 0) throw new LandingError(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
    return { head: await this.#headOf(path) };
  }

  async #refuseIfLive(path: string, name: string): Promise<void> {
    if (await this.#hasLiveRun(path)) {
      throw new LandingError(
        `worktree '${name}' has a LIVE goaly run inside it — refusing to touch the tree. Stop the run first, then retry.`,
      );
    }
  }

  /** Parse `git status --porcelain`, excluding the worktree's own `.goaly` state dir. */
  async #status(path: string): Promise<ChangedFile[]> {
    const r = await this.#gitAt(path, ['status', '--porcelain', '--', '.', ':(exclude).goaly']);
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
  }

  async #isDirty(path: string): Promise<boolean> {
    return (await this.#status(path)).length > 0;
  }

  /** Commits on `branch` not reachable from the main workspace HEAD (0 ⇒ nothing to land). */
  async #ahead(branch: string): Promise<number> {
    const r = await this.#git(['rev-list', '--count', `HEAD..${branch}`]);
    const n = Number.parseInt(r.stdout.trim(), 10);
    return r.code === 0 && Number.isFinite(n) ? n : 0;
  }

  /** Local commits on `path`'s branch not yet on its upstream (0 when there is no upstream). */
  async #unpushed(path: string): Promise<number> {
    const r = await this.#gitAt(path, ['rev-list', '--count', '@{upstream}..HEAD']);
    const n = Number.parseInt(r.stdout.trim(), 10);
    return r.code === 0 && Number.isFinite(n) ? n : 0;
  }

  /** The branch checked out at `path`, or `(detached)` when HEAD is not on a branch. */
  async #currentBranch(path: string): Promise<string> {
    const r = await this.#gitAt(path, ['branch', '--show-current']);
    const branch = r.stdout.trim();
    return r.code === 0 && branch.length > 0 ? branch : '(detached)';
  }

  /** Whether a git ref resolves in the main repo (used to refuse an already-existing eject branch). */
  async #refExists(ref: string): Promise<boolean> {
    return (await this.#git(['rev-parse', '--verify', '--quiet', ref])).code === 0;
  }

  async #hasLiveRun(path: string): Promise<boolean> {
    const stateDir = join(path, '.goaly');
    let names: string[];
    try {
      names = (await readdir(stateDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return false;
    }
    for (const runDir of names) {
      if (await this.#isRunActive(join(stateDir, runDir))) return true;
    }
    return false;
  }

  async #hasOrigin(path: string): Promise<boolean> {
    return (await this.#gitAt(path, ['remote', 'get-url', 'origin'])).code === 0;
  }

  async #hasGh(path: string): Promise<boolean> {
    try {
      return (await this.#exec('gh', ['--version'], { cwd: path })).code === 0;
    } catch {
      return false;
    }
  }

  async #headOf(path: string): Promise<string> {
    const r = await this.#gitAt(path, ['rev-parse', '--short=8', 'HEAD']);
    return r.code === 0 ? r.stdout.trim() : '?';
  }

  /** Run git in a specific directory (a worktree). */
  #gitAt(path: string, args: string[]): Promise<ExecResult> {
    return this.#exec('git', ['-C', path, ...args], { cwd: path });
  }

  /** Run git in the MAIN workspace root. */
  #git(args: string[]): Promise<ExecResult> {
    return this.#exec('git', ['-C', this.#root, ...args], { cwd: this.#root });
  }
}

/** Pull the PR URL out of `gh pr create` stdout (it prints the URL on its own line). */
export function extractPrUrl(stdout: string): string | null {
  const match = stdout.match(/https:\/\/[^\s]*\/pull\/\d+/);
  return match !== null ? match[0] : null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
