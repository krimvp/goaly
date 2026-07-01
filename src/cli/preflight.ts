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
};

async function defaultIsGitWorkTree(dir: string): Promise<boolean> {
  const r = await runProcess('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir });
  return r.code === 0 && r.stdout.trim() === 'true';
}

/**
 * Validate the environment for a `run` command. Returns `null` when everything checks out, or an
 * actionable error message (the caller prints it and exits 2 — nothing has been spent yet).
 *
 * The `fake` harness skips the CLI probes (it exists precisely so tests/demos run with zero
 * external tools); the git check always applies — every harness diffs the working tree through git.
 */
export async function preflightRun(
  opts: { harness: string; llmProvider: string; workspace: string },
  probes: PreflightProbes = {},
): Promise<string | null> {
  const hasBinary = probes.which ?? which;
  const isGitWorkTree = probes.isGitWorkTree ?? defaultIsGitWorkTree;

  if (!(await isGitWorkTree(opts.workspace))) {
    return (
      `${opts.workspace} is not a git repository. goaly diffs the working tree to track ` +
      `progress, detect stalls, and show the approver what changed — it needs git. ` +
      `Run: git init && git add -A && git commit -m "baseline" (then re-run goaly).`
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
