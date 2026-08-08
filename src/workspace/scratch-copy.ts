import { lstatSync } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { errorMessage } from '../util/errors';
import { realExec, type ExecFn } from './git-workspace';
import type { CommandResult } from './workspace';

/**
 * The SCRATCH-COPY seam (issue #115) — a throwaway, disposable duplicate of the workspace used by
 * the compile-time positive control ({@link import('../compile/contract-dry-run').ContractDryRunCompiler}).
 *
 * It exists for one reason: the positive control needs to WRITE a reference implementation of the
 * goal and RUN the authored bar against it, and neither may ever touch the real tree. Handing the
 * worker (or the run diff, or the user's git status) a solution would recreate exactly the deadlock
 * `classifyVacuousContract` exists to catch. So the reference implementation only ever reaches a
 * `ScratchCopy`, which is destroyed on every exit path.
 *
 * Deliberately a MINIMAL surface (write + run), not a {@link Workspace}: a scratch copy is never
 * diffed, checkpointed, baselined or verified against — it is a sandbox for one throwaway
 * experiment — and the small surface makes the fake used in tests trivial and total.
 */
export type ScratchCopy = {
  /** Absolute filesystem path of the copy (the cwd every {@link run} uses). */
  readonly root: string;
  /**
   * Write a file at a workspace-RELATIVE path inside the copy, creating parent directories.
   * Path-guarded fail-closed: a path that escapes {@link root} — lexically (absolute, or `../`) OR
   * through a symlink (a linked directory on the way down, or a linked target file) — throws rather
   * than writing outside the scratch. That is the one guarantee that keeps the reference
   * implementation out of the real workspace, so the check resolves REAL paths, not just strings.
   */
  writeFile(relPath: string, content: string): Promise<void>;
  /** Run a shell command in {@link root}, with the same timeout/spawn-failure reporting as a Workspace. */
  run(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult>;
};

/**
 * Lifecycle for {@link ScratchCopy}s. Split create/destroy (rather than a self-destroying handle)
 * mirrors {@link import('./workspace').WorktreeHost}: the caller owns the `finally` that tears the
 * copy down, so every exit path — green, red, or a thrown infrastructure error — destroys it.
 */
export interface ScratchHost {
  /** Duplicate the workspace into a fresh scratch directory. Throws fail-closed on any copy failure. */
  create(): Promise<ScratchCopy>;
  /** Tear down a copy created by {@link create}. Never throws (best-effort cleanup). */
  destroy(copy: ScratchCopy): Promise<void>;
}

/**
 * Path segments never copied into a scratch: git's own database (huge, and the copy is never a repo)
 * and goaly's own run state (the write-ahead log, locks, baselines — copying it would duplicate a
 * live run's bookkeeping into a throwaway tree).
 */
const SKIP_SEGMENTS = new Set(['.git', '.goaly']);

/**
 * Entry budget for one copy. A positive control must never be the reason a run stalls, so a tree
 * too large to duplicate cheaply (a populated `node_modules`, a big data dir) ABORTS the copy — the
 * dry run then fails OPEN and the contract freezes exactly as it does today. Bounding it here keeps
 * the guarantee mechanical instead of hoping a directory walk finishes.
 */
const DEFAULT_MAX_ENTRIES = 20_000;

/** Conventional `command not found` exit code, reported when the spawn itself failed. */
const SPAWN_FAILED_EXIT_CODE = 127;

/** Normalize a relative path for the escape guard: trim and drop a leading `./`. */
function normalizeRel(p: string): string {
  const t = p.trim();
  return t.startsWith('./') ? t.slice(2) : t;
}

/** True when any segment of `rel` is a directory the copy skips. */
function isSkipped(rel: string): boolean {
  return rel.split(sep).some((segment) => SKIP_SEGMENTS.has(segment));
}

/** True when `p` is `root` itself or lives underneath it. Both must already be real paths. */
function isInside(p: string, root: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/** The one fail-closed refusal — a write that would land outside the scratch copy. */
function escape(relPath: string): Error {
  return new Error(`ScratchCopy: refusing to write outside the scratch copy: '${relPath}'`);
}

/**
 * The real path of the deepest EXISTING ancestor of `dir` (`dir` itself when it exists). Resolving
 * that (rather than `dir`, which may not exist yet) is what turns the lexical escape guard into a
 * real one: any symlink on the way down shows up here as a path outside the scratch root.
 */
async function realExistingAncestor(dir: string): Promise<string> {
  let current = dir;
  for (;;) {
    const real = await realpath(current).catch(() => undefined);
    if (real !== undefined) return real;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * True when `src` is a symlink — such an entry is NEVER copied into a scratch. `fs.cp` with
 * `dereference: false` recreates links verbatim-ish (a RELATIVE target is resolved against the
 * SOURCE tree and rewritten as an ABSOLUTE link), so a copied `node_modules -> ../shared/node_modules`
 * would point straight back into the user's real workspace: a scratch `npm ci` would mutate it, and
 * a write "into the copy" would land in the real tree. Fail-closed: an unreadable entry is skipped.
 */
function isSymlink(src: string): boolean {
  try {
    return lstatSync(src).isSymbolicLink();
  } catch {
    return true;
  }
}

class FsScratchCopy implements ScratchCopy {
  readonly root: string;
  readonly #exec: ExecFn;

  constructor(root: string, exec: ExecFn) {
    this.root = root;
    this.#exec = exec;
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    const root = await realpath(resolve(this.root));
    const full = resolve(root, normalizeRel(relPath));
    // Fail-closed escape guard: the scratch copy is the ONLY place a reference implementation may
    // land, so a `../` or absolute path is refused outright rather than silently redirected.
    if (!isInside(full, root)) throw escape(relPath);
    // …and LEXICAL containment is not enough: a symlink inside the copy (a `node_modules` or `src`
    // link, or the file itself) resolves OUTSIDE it while every path string still looks contained.
    // So resolve real paths too — the deepest existing ancestor (the parents that would be walked)
    // and the target itself when it already exists — before a single byte is written.
    const anchor = await realExistingAncestor(dirname(full));
    if (!isInside(anchor, root)) throw escape(relPath);
    const link = await lstat(full).catch(() => undefined);
    if (link?.isSymbolicLink() === true) throw escape(relPath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, 'utf-8');
  }

  async run(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult> {
    try {
      const r = await this.#exec('sh', ['-c', command], {
        cwd: this.root,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return {
        exitCode: r.code,
        stdout: r.stdout,
        stderr: r.stderr,
        ...(r.timedOut === true ? { timedOut: true } : {}),
      };
    } catch (e) {
      // The spawn itself threw — the command never ran. Reported like a Workspace's own spawn
      // failure so the caller classifies it as could-not-evaluate, never as a red.
      return { exitCode: SPAWN_FAILED_EXIT_CODE, stdout: '', stderr: errorMessage(e), spawnFailed: true };
    }
  }
}

/**
 * Filesystem {@link ScratchHost}: duplicates the workspace into an OS temp directory with
 * `fs.cp`, skipping {@link SKIP_SEGMENTS} and bounded by an entry budget. No git, no symlink back
 * into the real tree (a symlinked `node_modules` would let a scratch `npm ci` mutate the user's
 * workspace — the exact leak this seam exists to prevent), and `rm -rf` on destroy.
 */
export class FsScratchHost implements ScratchHost {
  readonly #root: string;
  readonly #exec: ExecFn;
  readonly #maxEntries: number;
  readonly #tmpRoot: string;

  constructor(
    root: string,
    opts?: { exec?: ExecFn; maxEntries?: number; tmpRoot?: string },
  ) {
    this.#root = root;
    this.#exec = opts?.exec ?? realExec;
    this.#maxEntries = opts?.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.#tmpRoot = opts?.tmpRoot ?? tmpdir();
  }

  async create(): Promise<ScratchCopy> {
    const dir = await mkdtemp(join(this.#tmpRoot, 'goaly-dry-run-'));
    const source = resolve(this.#root);
    let entries = 0;
    let overflowed = false;
    try {
      await cp(source, dir, {
        recursive: true,
        force: true,
        dereference: false,
        filter: (src) => {
          const rel = relative(source, src);
          if (rel.length === 0) return true;
          if (isSkipped(rel)) return false;
          // A symlink is never duplicated — see `isSymlink`. Dropping the ENTRY (rather than
          // dereferencing it) also keeps the entry budget honest: a linked `node_modules` is not
          // silently expanded into the copy.
          if (isSymlink(src)) return false;
          entries += 1;
          if (entries > this.#maxEntries) {
            overflowed = true;
            return false;
          }
          return true;
        },
      });
      if (overflowed) {
        throw new Error(
          `ScratchHost: workspace exceeds the ${this.#maxEntries}-entry scratch-copy budget`,
        );
      }
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw e instanceof Error ? e : new Error(errorMessage(e));
    }
    return new FsScratchCopy(dir, this.#exec);
  }

  async destroy(copy: ScratchCopy): Promise<void> {
    await rm(copy.root, { recursive: true, force: true }).catch(() => undefined);
  }
}
