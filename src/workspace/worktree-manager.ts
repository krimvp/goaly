import { readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { realExec, type ExecFn, type ExecResult } from './git-workspace';
import { listRuns } from '../runlog/inspect';
import { runLockActive } from '../runlog/lock';

/**
 * Where goaly-managed worktrees live, relative to the MAIN workspace root. Inside the already
 * git-ignored `.goaly` state dir so they are self-contained, easy to enumerate, and never show in
 * `git status`. NOTE: `git clean -dfx` in the main tree deletes them (git then reports the
 * registration as prunable) — `list()` surfaces such entries instead of hiding them.
 */
export const WORKTREES_DIR = join('.goaly', 'worktrees');

/**
 * A goaly worktree name: a safe path component AND a safe git-branch component. Starts
 * alphanumeric; letters/digits/`.`/`_`/`-` only; max 64 chars; no `..` (invalid in a git ref and a
 * path-traversal vector), no trailing `.`, and not `*.lock` (git refuses such branch names).
 */
export const WorktreeName = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
    'worktree names are 1-64 chars of letters, digits, ".", "_", "-", starting alphanumeric',
  )
  .refine((n) => !n.includes('..') && !n.endsWith('.') && !n.endsWith('.lock'), {
    message: 'worktree names must not contain ".." or end with "." / ".lock"',
  });

/** The branch a goaly worktree lives on — merge-back is plain `git merge goaly/<name>`. */
export function worktreeBranch(name: string): string {
  return `goaly/${name}`;
}

/** One managed worktree, as reported by {@link WorktreeManager.list}. */
export type WorktreeInfo = {
  readonly name: string;
  /** Absolute path of the worktree checkout. */
  readonly path: string;
  /** The branch the worktree is on (`goaly/<name>`), or `(detached)` if the user moved it. */
  readonly branch: string;
  /** Short HEAD SHA of the worktree, or `?` when git reports none (e.g. a prunable entry). */
  readonly head: string;
  /** Uncommitted changes present (the `.goaly` state dir inside the worktree is not counted). */
  readonly dirty: boolean;
  /** Number of goaly runs recorded under `<worktree>/.goaly`. */
  readonly runs: number;
  /** The checkout directory is gone but the registration remains (e.g. after `git clean -dfx`). */
  readonly prunable: boolean;
};

/** Fail-closed worktree failure: a clear operator message, mapped to exit 2 by the CLI. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

/**
 * Light, named, persistent git-worktree management (the sibling of the best-of-N
 * {@link GitWorktreeHost}, which makes tmpdir + detached + ephemeral worktrees). Each managed
 * worktree lives under `.goaly/worktrees/<name>` on branch `goaly/<name>`, so a goaly run can
 * execute on an isolated copy of the repo and merge-back stays plain git. All git calls go through
 * an injectable {@link ExecFn}; every failure is a typed {@link WorktreeError}, never a throw of
 * raw git output paths (invariant #4: fail closed with a clear message).
 */
export class WorktreeManager {
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
   * Create the named worktree on branch `goaly/<name>`. When the branch already exists (a
   * previously removed worktree whose branch was kept), RE-ATTACH to it — the branch already pins
   * the base, so an explicit `base` is rejected then. Fail-closed on an unresolvable base, an
   * existing directory, or any git failure (partial dirs are cleaned up).
   */
  async create(name: string, base?: string): Promise<WorktreeInfo> {
    const parsed = this.#parseName(name);
    const path = this.pathFor(parsed);
    if (await exists(path)) {
      throw new WorktreeError(
        `worktree '${parsed}' already exists at ${path} — run in it with --worktree ${parsed}, ` +
          `or remove it first with: goaly worktree remove ${parsed}`,
      );
    }
    const branch = worktreeBranch(parsed);
    if (await this.#branchExists(branch)) {
      if (base !== undefined) {
        throw new WorktreeError(
          `branch ${branch} already exists (a previous worktree kept it) — it pins the base, so ` +
            `--base cannot apply. Re-attach without --base, or delete the branch first: git branch -D ${branch}`,
        );
      }
      await this.#addWorktree(parsed, ['worktree', 'add', path, branch]);
      return this.#info(parsed, path);
    }
    const baseRef = base ?? 'HEAD';
    if (!(await this.#refResolves(baseRef))) {
      throw new WorktreeError(
        base !== undefined
          ? `--base ${base}: not a resolvable git commit in ${this.#root}`
          : `cannot create a worktree: HEAD does not resolve in ${this.#root} — make an initial commit first`,
      );
    }
    await this.#addWorktree(parsed, ['worktree', 'add', '-b', branch, path, baseRef]);
    return this.#info(parsed, path);
  }

  /** Idempotent create for `goaly run --worktree`: reuse the worktree when present, create it when not. */
  async ensure(name: string, base?: string): Promise<WorktreeInfo> {
    const parsed = this.#parseName(name);
    const path = this.pathFor(parsed);
    if (await exists(path)) return this.#info(parsed, path);
    return this.create(parsed, base);
  }

  /** Every goaly-managed worktree (registered under `.goaly/worktrees/`), including prunable ones. */
  async list(): Promise<WorktreeInfo[]> {
    const r = await this.#git(['worktree', 'list', '--porcelain']);
    if (r.code !== 0) {
      throw new WorktreeError(`git worktree list failed (code ${r.code}): ${r.stderr.trim()}`);
    }
    const prefix = resolve(this.#root, WORKTREES_DIR) + '/';
    const out: WorktreeInfo[] = [];
    for (const entry of parseWorktreePorcelain(r.stdout)) {
      if (!entry.path.startsWith(prefix)) continue;
      const name = entry.path.slice(prefix.length);
      if (name.includes('/')) continue; // never a managed worktree (they are direct children)
      out.push(await this.#infoFromEntry(name, entry));
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Remove the named worktree. Safety ladder, all fail-closed:
   *  1. a LIVE goaly run inside it refuses removal even with `force` (an agent is editing the tree);
   *  2. uncommitted changes refuse without `force` (the message names how to keep the work);
   *  3. the branch is KEPT by default (merge-back is branch-based); `deleteBranch` opts in, and an
   *     unmerged branch then needs `force` (plain delete uses git's own `-d` refusal).
   */
  async remove(name: string, opts: { force?: boolean; deleteBranch?: boolean } = {}): Promise<void> {
    const parsed = this.#parseName(name);
    const path = this.pathFor(parsed);
    const registered = (await this.list()).some((w) => w.name === parsed);
    if (!registered && !(await exists(path))) {
      throw new WorktreeError(`no such worktree: ${parsed} (list them with: goaly worktree list)`);
    }

    if (await this.#hasLiveRun(path)) {
      throw new WorktreeError(
        `worktree '${parsed}' has a LIVE goaly run inside it — refusing to remove (even with --force). ` +
          `Stop the run first (Ctrl-C in its terminal), then retry.`,
      );
    }
    if (!opts.force && (await this.#isDirty(path))) {
      throw new WorktreeError(
        `worktree '${parsed}' has uncommitted changes. Keep them first:\n` +
          `  git -C ${path} add -A && git -C ${path} commit -m "goaly: ${parsed}"\n` +
          `then remove; or discard them with: goaly worktree remove ${parsed} --force`,
      );
    }

    const removed = await this.#git(['worktree', 'remove', ...(opts.force ? ['--force'] : []), path]);
    if (removed.code !== 0) {
      // Best-effort fallback (a prunable/broken registration): delete the dir, then prune below.
      await rm(path, { recursive: true, force: true }).catch(() => {});
    }
    await this.#git(['worktree', 'prune']).catch(() => undefined);

    if (opts.deleteBranch) {
      const branch = worktreeBranch(parsed);
      const del = await this.#git(['branch', opts.force ? '-D' : '-d', branch]);
      if (del.code !== 0) {
        throw new WorktreeError(
          `worktree removed, but deleting branch ${branch} failed: ${del.stderr.trim()}\n` +
            `(an unmerged branch needs --force; keep it to merge later with: git merge ${branch})`,
        );
      }
    }
  }

  /** The operator merge-back hint for a worktree (printed after runs and on remove-with-kept-branch). */
  mergeHint(name: string): string {
    const branch = worktreeBranch(name);
    const path = this.pathFor(name);
    return (
      `worktree '${name}' is on branch ${branch}. To merge the work back:\n` +
      `  git -C ${path} add -A && git -C ${path} commit -m "goaly: ${name}"\n` +
      `  git merge ${branch}`
    );
  }

  #parseName(name: string): string {
    const parsed = WorktreeName.safeParse(name);
    if (!parsed.success) {
      throw new WorktreeError(
        `invalid worktree name '${name}': ${parsed.error.issues[0]?.message ?? 'invalid'}`,
      );
    }
    return parsed.data;
  }

  async #addWorktree(name: string, args: string[]): Promise<void> {
    const r = await this.#git(args);
    if (r.code !== 0) {
      await rm(this.pathFor(name), { recursive: true, force: true }).catch(() => {});
      throw new WorktreeError(`git ${args.join(' ')} failed (code ${r.code}): ${r.stderr.trim()}`);
    }
  }

  async #info(name: string, path: string): Promise<WorktreeInfo> {
    return {
      name,
      path,
      branch: await this.#branchOf(path),
      head: await this.#headOf(path),
      dirty: await this.#isDirty(path),
      runs: (await listRuns(join(path, '.goaly'))).length,
      prunable: false,
    };
  }

  async #infoFromEntry(name: string, entry: PorcelainEntry): Promise<WorktreeInfo> {
    const prunable = entry.prunable || !(await exists(entry.path));
    return {
      name,
      path: entry.path,
      branch: entry.branch ?? '(detached)',
      head: entry.head !== undefined ? entry.head.slice(0, 8) : '?',
      dirty: prunable ? false : await this.#isDirty(entry.path),
      runs: prunable ? 0 : (await listRuns(join(entry.path, '.goaly'))).length,
      prunable,
    };
  }

  /** Uncommitted changes in the worktree, ignoring its own `.goaly` state dir. */
  async #isDirty(path: string): Promise<boolean> {
    const r = await this.#exec('git', ['-C', path, 'status', '--porcelain', '--', ':(exclude).goaly'], {
      cwd: path,
    });
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  async #hasLiveRun(path: string): Promise<boolean> {
    const stateDir = join(path, '.goaly');
    let names: string[];
    try {
      names = (await readdir(stateDir, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return false; // no state dir ⇒ no runs
    }
    for (const runDir of names) {
      if (await this.#isRunActive(join(stateDir, runDir))) return true;
    }
    return false;
  }

  async #branchOf(path: string): Promise<string> {
    const r = await this.#exec('git', ['-C', path, 'branch', '--show-current'], { cwd: path });
    const branch = r.stdout.trim();
    return r.code === 0 && branch.length > 0 ? branch : '(detached)';
  }

  async #headOf(path: string): Promise<string> {
    const r = await this.#exec('git', ['-C', path, 'rev-parse', '--short=8', 'HEAD'], { cwd: path });
    return r.code === 0 ? r.stdout.trim() : '?';
  }

  async #branchExists(branch: string): Promise<boolean> {
    const r = await this.#git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    return r.code === 0;
  }

  async #refResolves(ref: string): Promise<boolean> {
    const r = await this.#git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  #git(args: string[]): Promise<ExecResult> {
    return this.#exec('git', ['-C', this.#root, ...args], { cwd: this.#root });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

type PorcelainEntry = {
  path: string;
  head: string | undefined;
  branch: string | undefined;
  prunable: boolean;
};

/**
 * Parse `git worktree list --porcelain`: blank-line-separated stanzas of
 * `worktree <path>` / `HEAD <sha>` / `branch refs/heads/<name>` (or `detached`), with an optional
 * `prunable <reason>` annotation when the checkout directory is gone.
 */
function parseWorktreePorcelain(stdout: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  let cur: PorcelainEntry | undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      if (cur !== undefined) entries.push(cur);
      cur = undefined;
      continue;
    }
    if (trimmed.startsWith('worktree ')) {
      if (cur !== undefined) entries.push(cur);
      cur = { path: trimmed.slice('worktree '.length), head: undefined, branch: undefined, prunable: false };
      continue;
    }
    if (cur === undefined) continue;
    if (trimmed.startsWith('HEAD ')) cur.head = trimmed.slice('HEAD '.length);
    else if (trimmed.startsWith('branch refs/heads/')) cur.branch = trimmed.slice('branch refs/heads/'.length);
    else if (trimmed.startsWith('prunable')) cur.prunable = true;
  }
  if (cur !== undefined) entries.push(cur);
  return entries;
}
