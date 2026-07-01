import { readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DiffHash } from '../domain/ids';
import { errorMessage } from '../util/errors';
import { sha256Hex } from '../util/hash';
import { runProcess } from '../util/spawn';
import { scrubEnv, augmentToolPath } from './scrub-env';
import type { CommandResult, Workspace } from './workspace';

/** The well-known git empty-tree object — a stable base for diffing a repo with no HEAD. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Low-level process result used by the injectable exec runner. */
export type ExecResult = { stdout: string; stderr: string; code: number; timedOut?: boolean };

/**
 * Injectable process runner. Defaults to a real `node:child_process` spawn helper so
 * tests can substitute a fake and never spawn real processes for unit-level checks.
 */
export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; shell?: boolean; timeoutMs?: number },
) => Promise<ExecResult>;

/** Conventional `timeout(1)` exit code; surfaced when we kill a command for exceeding `timeoutMs`. */
const TIMEOUT_EXIT_CODE = 124;

/** Normalize a repo-relative path for set comparison: trim, drop a leading `./`. */
function normalizeRel(p: string): string {
  const t = p.trim();
  return t.startsWith('./') ? t.slice(2) : t;
}

/**
 * Docs / repo metadata that never count as implementation source for {@link GitWorkspace.isEmptyOfSource}
 * (Fix B1). Deliberately small + conservative: only a from-scratch seed README/LICENSE, any Markdown,
 * and git's own dotfiles (`.gitignore`, `.gitattributes`, …). Anything else — a `*.go`, `package.json`,
 * a `src/` file — is a candidate source file, so the tree is NOT treated as from-scratch.
 */
function isDocOrMeta(relPath: string): boolean {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  return (
    /^README/i.test(base) ||
    /^LICENSE/i.test(base) ||
    /\.md$/i.test(base) ||
    base.startsWith('.git')
  );
}

/** Counter to keep temporary index file names unique within a process. */
let tmpIndexCounter = 0;

/**
 * Real runner — a thin shim over the shared {@link runProcess} (one tested subprocess dance for the
 * whole codebase). A verify command spawns a `sh` wrapper with children, so when a timeout is set we
 * ask `runProcess` to kill the whole process group (`killGroup`) — otherwise SIGKILL'ing just the
 * wrapper would orphan its children and (because they inherit the stdio pipes) leave the run hanging
 * forever. A timeout is surfaced as the conventional `timeout(1)` exit code with a loud marker, so a
 * hung verify command becomes a fail-closed verifier FAIL. Never rejects.
 */
export const realExec: ExecFn = async (cmd, args, opts) => {
  const r = await runProcess(cmd, args, {
    cwd: opts.cwd,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.shell !== undefined ? { shell: opts.shell } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs, killGroup: true } : {}),
  });
  if (r.timedOut) {
    return {
      stdout: r.stdout,
      stderr: `${r.stderr}\n[goaly] command timed out after ${opts.timeoutMs}ms`,
      code: TIMEOUT_EXIT_CODE,
      timedOut: true,
    };
  }
  return { stdout: r.stdout, stderr: r.stderr, code: r.code };
};

/**
 * Git-backed {@link Workspace}. Computes a NON-MUTATING content hash of the full working
 * tree (using a throwaway temporary git index, so the user's real index is never touched),
 * exposes the working-tree diff plus untracked files, and runs shell commands without ever
 * rejecting on a non-zero exit.
 */
/**
 * Wraps the verify exec into a sandboxed one. Applied ONLY inside `run()` (alongside
 * `scrubVerifyEnv`) — never around the git plumbing, which needs the real `.git` + full env. The
 * default is identity (no sandbox). The composition root injects the real sandbox wrapper (issue #9).
 */
export type RunExecWrapper = (exec: ExecFn) => ExecFn;

export class GitWorkspace implements Workspace {
  readonly #root: string;
  readonly #exec: ExecFn;
  readonly #runExec: ExecFn;
  readonly #excludes: readonly string[];
  readonly #scrubVerifyEnv: boolean;
  /** What `diff()` compares the working tree against. Defaults to `HEAD`; advanced by `checkpoint()`
   *  or pointed elsewhere by `setBaseline()` (the `--baseline` flag / `--resume` reconstruction). */
  #baseline = 'HEAD';
  /** Paths `diff()` must always surface even when git-excluded (the authored verification bar). */
  #diffIncludes: readonly string[] = [];

  /**
   * @param excludes paths kept out of diffHash/diff so the orchestrator's own state dir
   *   (default `.goaly`) never pollutes stuck-detection, regardless of the repo's
   *   .gitignore.
   * @param scrubVerifyEnv when true (default) the verify command (`run`) is spawned with a
   *   credential-scrubbed environment so worker/model-authored verification code
   *   cannot read the parent process's secrets. Git operations (diffHash/diff) keep the full env.
   * @param runLauncher OPTIONAL wrapper applied to the exec used by `run()` ONLY (issue #9): it
   *   jails the verify command without ever touching the git plumbing's `#exec`. Default identity.
   */
  constructor(
    root: string,
    exec: ExecFn = realExec,
    excludes: readonly string[] = ['.goaly'],
    scrubVerifyEnv = true,
    runLauncher?: RunExecWrapper,
  ) {
    this.#root = root;
    this.#exec = exec;
    this.#runExec = runLauncher !== undefined ? runLauncher(exec) : exec;
    this.#excludes = excludes;
    this.#scrubVerifyEnv = scrubVerifyEnv;
  }

  /** Git pathspec that scopes a command to everything except the excluded paths. */
  #pathspec(): string[] {
    if (this.#excludes.length === 0) return [];
    return ['--', '.', ...this.#excludes.map((e) => `:(exclude)${e}`)];
  }

  async diffHash(): Promise<DiffHash> {
    return DiffHash.parse(await this.#snapshotTree());
  }

  /**
   * Point {@link diff} at a different baseline (a git ref or tree SHA). Pure in-memory wiring — it
   * never spawns git, so an invalid ref is caught by the caller's fail-closed validation, not here.
   */
  setBaseline(ref: string): void {
    this.#baseline = ref;
  }

  currentBaseline(): string {
    return this.#baseline;
  }

  /**
   * Register the authored verification paths `diff()` must always surface (see {@link Workspace.setDiffIncludes}).
   * Normalized + deduped so the render below is exact and never double-lists a path.
   */
  setDiffIncludes(paths: readonly string[]): void {
    this.#diffIncludes = [...new Set(paths.map(normalizeRel))];
  }

  /**
   * Snapshot the full working tree into a git TREE object (never a commit) and adopt it as the new
   * baseline, so the NEXT `diff()` is computed against current progress. The snapshot reuses the same
   * throwaway-index `write-tree` dance as {@link diffHash}, so the user's real index/staging area,
   * `HEAD`, the current branch and `git log` are all left untouched (issue #47). We do NOT pin the
   * tree behind a `refs/goaly/*` ref: the object is freshly written and only becomes unreachable at
   * run end, and `git gc` collecting a dangling tree later is explicitly fine — so there is zero
   * lasting footprint on the user's repo. Returns the tree SHA as the baseline handle.
   */
  async checkpoint(): Promise<DiffHash> {
    const tree = await this.#snapshotTree();
    this.#baseline = tree;
    return DiffHash.parse(tree);
  }

  /**
   * The non-mutating tree snapshot shared by {@link diffHash} and {@link checkpoint}: stage the whole
   * working tree into a throwaway `GIT_INDEX_FILE` (so the user's index is never clobbered), drop the
   * excluded paths, and `write-tree` the result to a content-addressed tree SHA. Throws (fail-closed)
   * on any git failure — never returns a silently empty/partial tree.
   */
  async #snapshotTree(): Promise<string> {
    const tmpIndex = join(tmpdir(), `goaly-idx-${process.pid}-${tmpIndexCounter++}`);
    // Ensure no stale index file exists at that path.
    await rm(tmpIndex, { force: true });

    const env: NodeJS.ProcessEnv = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    try {
      // `add -A` respects .gitignore, so node_modules etc. are excluded. We deliberately pass NO
      // pathspec here: naming an excluded path that is ALSO gitignored (e.g. `.goaly` when the repo
      // ignores `.goaly/`) makes `git add` emit "the following paths are ignored" and exit non-zero,
      // which would spuriously throw and crash the loop. Instead we stage everything, then unstage
      // the excludes below — which works whether or not they are gitignored.
      const added = await this.#exec('git', ['-C', this.#root, 'add', '-A'], {
        cwd: this.#root,
        env,
      });
      if (added.code !== 0) {
        throw new Error(`git add -A failed (code ${added.code}): ${added.stderr.trim()}`);
      }

      // Keep the orchestrator's own state dir out of the hash, regardless of the repo's .gitignore.
      // `--ignore-unmatch` makes this a no-op when an exclude is absent or already gitignored (so it
      // never throws in the common case); `--cached -r` touches only the throwaway index.
      if (this.#excludes.length > 0) {
        const removed = await this.#exec(
          'git',
          ['-C', this.#root, 'rm', '--cached', '-r', '--quiet', '--ignore-unmatch', '--', ...this.#excludes],
          { cwd: this.#root, env },
        );
        if (removed.code !== 0) {
          throw new Error(`git rm --cached failed (code ${removed.code}): ${removed.stderr.trim()}`);
        }
      }

      const tree = await this.#exec('git', ['-C', this.#root, 'write-tree'], {
        cwd: this.#root,
        env,
      });
      if (tree.code !== 0) {
        throw new Error(`git write-tree failed (code ${tree.code}): ${tree.stderr.trim()}`);
      }

      return tree.stdout.trim();
    } finally {
      await rm(tmpIndex, { force: true });
    }
  }

  async diff(baseline?: string): Promise<string> {
    const ps = this.#pathspec();
    // Default to the active baseline; an explicit `baseline` (delta-verify's cumulative guard, #49)
    // pins this diff to the run-start baseline regardless of how far checkpoints have advanced.
    const base = baseline ?? this.#baseline;
    let tracked = await this.#exec('git', ['-C', this.#root, 'diff', base, ...ps], {
      cwd: this.#root,
    });

    // `git diff` exits 0 whether or not there are changes; a non-zero exit means an actual error
    // (commonly an unborn branch with no HEAD, or a baseline ref that no longer resolves). Fall back
    // to diffing against the empty tree so staged/tracked content still appears — and surface a loud
    // marker rather than a silent empty diff if even that fails (a silent empty diff would mislead
    // Sign-off and the judge verifier).
    if (tracked.code !== 0) {
      const fallback = await this.#exec('git', ['-C', this.#root, 'diff', EMPTY_TREE, ...ps], {
        cwd: this.#root,
      });
      if (fallback.code === 0) {
        tracked = fallback;
      } else {
        return `--- DIFF ERROR (git diff exit ${tracked.code}): ${tracked.stderr.trim()} ---\n`;
      }
    }

    const untracked = await this.#exec(
      'git',
      ['-C', this.#root, 'ls-files', '--others', '--exclude-standard', ...ps],
      { cwd: this.#root },
    );

    const untrackedFiles = untracked.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const sections: string[] = [tracked.stdout];
    if (untrackedFiles.length > 0) {
      sections.push(`\n--- untracked files ---\n`);
      for (const file of untrackedFiles) {
        sections.push(await this.#untrackedDiff(file));
      }
    }

    // Force-include the authored verification bar (`generatedFiles`). It is git-excluded (issue #52)
    // so `ls-files --exclude-standard` above never lists it, which would hide the very files the
    // judge/approver rubric is about — a false "no tests written" veto the worker cannot fix without
    // tripping the integrity guard. Render only paths that (a) exist on disk (a not-yet-authored file
    // is skipped, never a phantom) and (b) weren't already surfaced as a normal untracked file.
    const alreadyShown = new Set(untrackedFiles.map(normalizeRel));
    const forced: string[] = [];
    for (const rel of this.#diffIncludes) {
      if (alreadyShown.has(rel)) continue;
      if (!(await this.#fileExists(rel))) continue;
      forced.push(rel);
    }
    if (forced.length > 0) {
      sections.push(`\n--- authored verification files (frozen bar) ---\n`);
      for (const file of forced) {
        sections.push(await this.#untrackedDiff(file));
      }
    }
    return sections.join('');
  }

  /** True when `rel` resolves under the root and exists on disk (used to skip not-yet-authored includes). */
  async #fileExists(rel: string): Promise<boolean> {
    const rootResolved = resolve(this.#root);
    const resolved = resolve(rootResolved, rel);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) return false;
    try {
      await stat(resolved);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Render a single untracked (agent-created) file as an added-file diff, so the two LLM keys
   * (judge + Sign-off approver) see its CONTENT — not just its name. `git diff HEAD` omits untracked
   * files entirely, so a from-scratch build (every file untracked) would otherwise reach both keys
   * as a bare filename list, leaving them unable to inspect what the worker actually wrote — the very
   * thing the "two keys ingest the diff" guarantee depends on. `--no-index` against `/dev/null` is
   * NON-MUTATING (it never touches the index, preserving diffHash's purity) and exits 1 when the
   * content differs from the empty file — i.e. always — which is expected, not an error. Binary files
   * are summarised by git ("Binary files … differ"). Fail-soft: if rendering fails for any other
   * reason we still surface the filename, never silently dropping a worker-authored file.
   */
  async #untrackedDiff(file: string): Promise<string> {
    const added = await this.#exec(
      'git',
      ['-C', this.#root, 'diff', '--no-index', '--', '/dev/null', file],
      { cwd: this.#root },
    );
    // `git diff --no-index` exits 0 (identical — unreachable here) or 1 (differs); anything else is a
    // real failure, so fall back to the name so the file is never invisible to the keys.
    if (added.code === 0 || added.code === 1) {
      return added.stdout;
    }
    return `${file}\n`;
  }

  async fileHash(relPath: string): Promise<string | null> {
    // Resolve under the root and refuse anything that escapes it — a pinned path is compiler-
    // authored but we treat it as untrusted (a traversal becomes a fail-closed "missing" → FAIL).
    const rootResolved = resolve(this.#root);
    const resolved = resolve(rootResolved, relPath);
    if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
      return null;
    }
    try {
      const content = await readFile(resolved, 'utf8');
      return sha256Hex(content);
    } catch {
      // Missing/unreadable file is fail-closed: the guard reports it as a moved/deleted bar.
      return null;
    }
  }

  /**
   * From-scratch detector (Fix B1). List every candidate file via `git ls-files --cached --others
   * --exclude-standard` (tracked + untracked-not-ignored, respecting the existing `#pathspec()`
   * excludes, e.g. `.goaly`), then subtract the compiler's authored verification (`generatedFiles`)
   * and a small doc/meta allowlist. If NOTHING remains, the tree carries no implementation source yet
   * → from-scratch. Conservative + fail-safe: a non-zero git exit or a throw yields `false` (treated
   * as "not from-scratch"), so a glitch never wrongly skips the soundness pre-flight.
   */
  async isEmptyOfSource(generatedFiles: readonly string[]): Promise<boolean> {
    try {
      const listed = await this.#exec(
        'git',
        ['-C', this.#root, 'ls-files', '--cached', '--others', '--exclude-standard', ...this.#pathspec()],
        { cwd: this.#root },
      );
      if (listed.code !== 0) return false; // can't enumerate ⇒ conservatively not from-scratch
      const authored = new Set(generatedFiles.map(normalizeRel));
      const candidates = listed.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
        .map(normalizeRel)
        .filter((f) => !authored.has(f))
        .filter((f) => !isDocOrMeta(f));
      return candidates.length === 0;
    } catch {
      return false;
    }
  }

  async run(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult> {
    // Honor the Workspace "never rejects" contract even if the injected exec throws.
    try {
      // The verify command runs worker/model-authored code on the host: deny it the parent's
      // ambient secrets. Git operations above deliberately keep the full env. Either way, extend PATH
      // with the standard per-user tool bin dirs so a toolchain the agent installs mid-run (the default
      // --install-missing-tools path) is discoverable here even though our process.env was fixed at
      // startup.
      const env = augmentToolPath(this.#scrubVerifyEnv ? scrubEnv(process.env) : process.env);
      const result = await this.#runExec(command, [], {
        cwd: this.#root,
        shell: true,
        env,
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        // Propagate the one fact only goaly knows: whether IT killed the command for timing out.
        ...(result.timedOut === true ? { timedOut: true } : {}),
      };
    } catch (e) {
      // The spawn itself threw — goaly could not even start the command (it never ran).
      return { exitCode: 127, stdout: '', stderr: errorMessage(e), spawnFailed: true };
    }
  }
}

/**
 * True when `ref` resolves to a real object in the git repo at `root` (`git rev-parse --verify`).
 * Used to validate a `--baseline <ref>` fail-closed BEFORE the run starts (invariant #6: parse at the
 * seam) so an unknown ref refuses to start rather than silently degrading the diff. The exec is
 * injectable so the check is unit-testable without spawning git.
 */
export async function refResolves(root: string, ref: string, exec: ExecFn = realExec): Promise<boolean> {
  // `^{object}` peels the ref to the object it names; `--verify --quiet` exits non-zero (and prints
  // nothing) when it does not resolve.
  const r = await exec('git', ['-C', root, 'rev-parse', '--verify', '--quiet', `${ref}^{object}`], {
    cwd: root,
  });
  return r.code === 0;
}
