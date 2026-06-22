import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DiffHash } from '../domain/ids';
import { errorMessage } from '../util/errors';
import { sha256Hex } from '../util/hash';
import { runProcess } from '../util/spawn';
import { scrubEnv } from './scrub-env';
import type { CommandResult, Workspace } from './workspace';

/** The well-known git empty-tree object — a stable base for diffing a repo with no HEAD. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Low-level process result used by the injectable exec runner. */
export type ExecResult = { stdout: string; stderr: string; code: number };

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
const realExec: ExecFn = async (cmd, args, opts) => {
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
export class GitWorkspace implements Workspace {
  readonly #root: string;
  readonly #exec: ExecFn;
  readonly #excludes: readonly string[];
  readonly #scrubVerifyEnv: boolean;

  /**
   * @param excludes paths kept out of diffHash/diff so the orchestrator's own state dir
   *   (default `.goaly`) never pollutes stuck-detection, regardless of the repo's
   *   .gitignore.
   * @param scrubVerifyEnv when true (default) the verify command (`run`) is spawned with a
   *   credential-scrubbed environment so worker/model-authored verification code
   *   cannot read the parent process's secrets. Git operations (diffHash/diff) keep the full env.
   */
  constructor(
    root: string,
    exec: ExecFn = realExec,
    excludes: readonly string[] = ['.goaly'],
    scrubVerifyEnv = true,
  ) {
    this.#root = root;
    this.#exec = exec;
    this.#excludes = excludes;
    this.#scrubVerifyEnv = scrubVerifyEnv;
  }

  /** Git pathspec that scopes a command to everything except the excluded paths. */
  #pathspec(): string[] {
    if (this.#excludes.length === 0) return [];
    return ['--', '.', ...this.#excludes.map((e) => `:(exclude)${e}`)];
  }

  async diffHash(): Promise<DiffHash> {
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

      return DiffHash.parse(tree.stdout.trim());
    } finally {
      await rm(tmpIndex, { force: true });
    }
  }

  async diff(): Promise<string> {
    const ps = this.#pathspec();
    let tracked = await this.#exec('git', ['-C', this.#root, 'diff', 'HEAD', ...ps], {
      cwd: this.#root,
    });

    // `git diff` exits 0 whether or not there are changes; a non-zero exit means an actual error
    // (commonly an unborn branch with no HEAD). Fall back to diffing against the empty tree so
    // staged/tracked content still appears — and surface a loud marker rather than a silent empty
    // diff if even that fails (a silent empty diff would mislead Gate B and the judge verifier).
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
      sections.push(`\n--- untracked files ---\n${untrackedFiles.join('\n')}\n`);
    }
    return sections.join('');
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

  async run(command: string, opts?: { timeoutMs?: number }): Promise<CommandResult> {
    // Honor the Workspace "never rejects" contract even if the injected exec throws.
    try {
      // The verify command runs worker/model-authored code on the host: deny it the parent's
      // ambient secrets. Git operations above deliberately keep the full env.
      const env = this.#scrubVerifyEnv ? scrubEnv(process.env) : undefined;
      const result = await this.#exec(command, [], {
        cwd: this.#root,
        shell: true,
        ...(env !== undefined ? { env } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
    } catch (e) {
      return { exitCode: 127, stdout: '', stderr: errorMessage(e) };
    }
  }
}
