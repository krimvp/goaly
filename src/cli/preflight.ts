import { readFileSync, writeFileSync } from 'node:fs';
import { runProcess } from '../util/spawn';
import { which } from '../util/which';
import { codecFor, isAgentCli } from '../agent-cli/registry';

/**
 * First-run preflight (fail-fast, before any token is spent). The three most common first-run
 * mistakes used to surface LATE and cryptically:
 *   - harness / LLM-provider CLI not installed → three identical `spawn ENOENT` compile retries,
 *     then a terminal "compile failed: … exited 127";
 *   - not a git repository → a full contract compile + agent turn, then an ABORTED whose reason is
 *     a git plumbing string (`git add -A failed (code 128)…`);
 *   - an unauthenticated CLI → indistinguishable from "not installed".
 * Each check here costs milliseconds, runs BEFORE the run starts, and fails closed with a message
 * that says exactly what to do. Probes are injectable so tests never touch the host.
 */
export type PreflightProbes = {
  /** Is `binary` an executable on PATH? Defaults to the shared {@link which}. */
  which?: (binary: string) => boolean;
  /** Is `dir` inside a git work tree? Defaults to `git rev-parse --is-inside-work-tree`. */
  isGitWorkTree?: (dir: string) => Promise<boolean>;
  /** Run a git subcommand in `dir`. Defaults to the shared {@link runProcess}. */
  git?: (dir: string, args: string[], env?: Record<string, string | undefined>) => Promise<{ code: number; stdout: string; stderr: string }>;
};

async function defaultIsGitWorkTree(dir: string): Promise<boolean> {
  const r = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  return r.code === 0 && r.stdout.trim() === 'true';
}

function defaultGit(dir: string, args: string[], env?: Record<string, string | undefined>) {
  return runProcess('git', args, { cwd: dir, ...(env !== undefined ? { env } : {}) });
}

/**
 * Validate the environment for a `run` command. Returns `null` when everything checks out, or an
 * actionable error message (the caller prints it and exits 2 — nothing has been spent yet).
 *
 * The `fake` harness skips the CLI probes (it exists precisely so tests/demos run with zero
 * external tools); the git check always applies — every harness diffs the working tree through git.
 */
export async function preflightRun(
  opts: { harness: string; llmProvider: string; workspace: string; autoInit?: boolean },
  probes: PreflightProbes = {},
): Promise<string | null> {
  const hasBinary = probes.which ?? which;
  const isGitWorkTree = probes.isGitWorkTree ?? defaultIsGitWorkTree;

  if (!(await isGitWorkTree(opts.workspace))) {
    if (opts.autoInit === true) {
      // `--auto-init` will create the repo after the dry-run gate; preflight passes so the real
      // run can proceed hands-off. The dry-run resolved config already surfaces the flag.
      return null;
    }
    return (
      `${opts.workspace} is not a git repository. goaly diffs the working tree to track ` +
      `progress, detect stalls, and show the approver what changed — it needs git. ` +
      `Run: git init && git add -A && git commit -m "baseline" (then re-run goaly), ` +
      `or pass --auto-init (default ON for autonomous runs) to let goaly create the baseline ` +
      `commit for you. Use --no-auto-init to keep this fail-closed check.`
    );
  }

  if (opts.harness === 'fake') return null;

  if (isAgentCli(opts.harness) && !hasBinary(codecFor(opts.harness).command)) {
    const cmd = codecFor(opts.harness).command;
    return (
      `the '${cmd}' CLI (needed for --harness ${opts.harness}) was not found on PATH. ` +
      `Install it and check it runs by hand (it may also need a login / API key), ` +
      `or pick another harness: --harness claude|codex|droid|pi|goaly-code.`
    );
  }

  if (isAgentCli(opts.llmProvider) && !hasBinary(codecFor(opts.llmProvider).command)) {
    const cmd = codecFor(opts.llmProvider).command;
    return (
      `the '${cmd}' CLI (needed for --llm-provider ${opts.llmProvider} — it backs the ` +
      `compiler/judge/approver steps) was not found on PATH. Install it and check it runs by ` +
      `hand, or use --llm-provider openai with --base-url/--llm-model.`
    );
  }

  return null;
}

/**
 * Auto-initialize a git repository for hands-off operation. Called after the dry-run gate and
 * before the run lock: creates the repo, stages all existing files, drops any pre-existing `.goaly`
 * runtime dir from the baseline, and makes an initial commit so goaly has a stable baseline to
 * diff against. Also ensures `.goaly/` is git-ignored so the run state dir never appears in
 * `git status`.
 *
 * Fail-closed: if any step errors, returns a clear message so the run aborts before any token is
 * spent. The caller must still run the normal preflight afterwards to confirm the workspace is
 * now usable.
 */
export async function maybeAutoInitGitRepo(
  opts: { workspace: string; autoInit: boolean },
  probes: PreflightProbes = {},
): Promise<string | null> {
  if (!opts.autoInit) return null;

  const isGitWorkTree = probes.isGitWorkTree ?? defaultIsGitWorkTree;
  if (await isGitWorkTree(opts.workspace)) return null; // already a repo — nothing to do

  const git = probes.git ?? defaultGit;

  const init = await git(opts.workspace, ['init', '-q']);
  if (init.code !== 0) {
    return `git init failed in ${opts.workspace}: ${init.stderr.trim()}`;
  }

  // Make sure goaly's state dir is ignored from the start, so the first commit and every `git status` stay clean.
  ensureGoalyIgnored(opts.workspace);

  // Use a one-off author identity so the baseline commit works even on machines with no global git user configured.
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: 'goaly',
    GIT_AUTHOR_EMAIL: 'goaly@local',
    GIT_COMMITTER_NAME: 'goaly',
    GIT_COMMITTER_EMAIL: 'goaly@local',
  };

  const add = await git(opts.workspace, ['add', '-A'], env);
  if (add.code !== 0) {
    return `git add failed during --auto-init in ${opts.workspace}: ${add.stderr.trim()}`;
  }

  // Never commit a pre-existing .goaly state dir into the baseline: it is runtime data, not source.
  const reset = await git(opts.workspace, ['reset', '--quiet', '--', '.goaly'], env);
  if (reset.code !== 0) {
    return `git reset failed during --auto-init in ${opts.workspace}: ${reset.stderr.trim()}`;
  }

  const commit = await git(opts.workspace, ['commit', '-q', '--allow-empty', '-m', 'goaly baseline'], env);
  if (commit.code !== 0) {
    return `git commit failed during --auto-init in ${opts.workspace}: ${commit.stderr.trim()}`;
  }

  return null;
}

function ensureGoalyIgnored(dir: string): void {
  const path = `${dir}/.gitignore`;
  let existing = '';
  try {
    existing = readFileSync(path, 'utf8');
  } catch {
    existing = '';
  }
  const marker = '.goaly/';
  if (existing.split('\n').some((line) => line.trim() === marker)) return;
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(path, `${existing}${prefix}${marker}\n`, 'utf8');
}
