import type { AgentExecFn } from '../agent-cli/codec';
import type { ExecFn } from '../workspace/git-workspace';
import type { SandboxLauncher } from './launcher';
import { resolveProfile, type SandboxNetwork, type SandboxProxy } from './policy';

/**
 * The two untrusted-code exec seams differ in shape, so each gets its own wrapper. Both are pure
 * higher-order functions: they ask the launcher to rewrite `(command, args)` and forward the
 * rewritten pair to the wrapped exec. With a {@link NoneLauncher} the rewrite is identity, so the
 * wrapped exec is a perfect passthrough — Option 1 default untouched.
 */

/** Per-seam wrap policy: the workspace bound rw, the egress toggle, and the env for THIS seam. */
export type SandboxExecOpts = {
  readonly workspace: string;
  readonly network: SandboxNetwork;
  /**
   * The env to expose inside the jail. Only the container launcher consumes it (it must re-export
   * each NAME with `-e`, since `docker`/`podman run` does NOT inherit the host env); bwrap inherits
   * the env naturally and ignores it. The harness seam supplies the FULL host env so the agent CLI
   * can authenticate (API keys); the verifier seam's env is already scrubbed upstream.
   */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The running egress proxy to route through when `network` is an allowlist (issue #39). Threaded
   * into the launcher so it can pin the jail's proxy env vars at it. Required whenever `network` is
   * an allowlist; absent under an allowlist ⇒ the launcher fails closed.
   */
  readonly proxy?: SandboxProxy;
  /** `$HOME` for resolving the credential-deny dirs (default `process.env.HOME`; injected in tests). */
  readonly home?: string | undefined;
};

/**
 * Wrap the HARNESS exec (the whole agent-CLI invocation is untrusted). The codec builds `args` for
 * a fixed `command` it closed over; to jail it we rewrite BOTH, so we take the agent `command`
 * explicitly. The rewritten launcher binary + argv are flattened into the agent exec's argv-only
 * shape via a synthetic leading binary the inner exec spawns instead.
 *
 * To keep the inner exec binary-agnostic, the caller builds the inner exec over a NEUTRAL spawner
 * (one that spawns `args[0]` with `args.slice(1)`); on `none` the launcher is identity, so the
 * caller wires the plain `defaultAgentExec` and this wrapper is a no-op identity passthrough.
 */
export function withSandboxAgent(
  command: string,
  exec: AgentExecFn,
  launcher: SandboxLauncher,
  opts: SandboxExecOpts,
): AgentExecFn {
  return (args, input, onStdout) => {
    // Identity launcher ONLY: pass the original argv straight through (byte-for-byte the current
    // call). Keyed on the explicit `identity` flag, not on string-comparing the rewritten command,
    // so a real jail (or an UnavailableLauncher, whose `wrap()` throws) can never fail OPEN here.
    if (launcher.identity) return exec(args, input, onStdout);
    const profile = resolveProfile(opts.network, {
      workspace: opts.workspace,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}),
      ...(opts.home !== undefined ? { home: opts.home } : {}),
    });
    const wrapped = launcher.wrap(command, args, profile);
    // A real jail: spawn the launcher binary with its full argv. The inner exec is the neutral
    // spawner, so prepend the binary as argv[0].
    return exec([wrapped.command, ...wrapped.args], input, onStdout);
  };
}

/**
 * Wrap the VERIFIER exec (`GitWorkspace.run`). Applied ONLY inside `run()`, alongside
 * `scrubVerifyEnv` — never around git plumbing (which needs the real `.git` + full env). The verify
 * command arrives as a SHELL STRING with `shell:true` (e.g. `npm test`, `pytest && ruff`), so the
 * jail must run it through an interpreter: we hand the launcher `['sh', '-c', <command>]` instead of
 * the bare string, which would otherwise execve a binary literally named `npm test`. The host shell
 * wrapper is then dropped (the launcher binary is invoked with an explicit argv, and `sh -c` does
 * the word-splitting inside the jail). With a {@link NoneLauncher} this is a byte-for-byte identity
 * passthrough (shell and all) — the unsandboxed default is untouched.
 */
export function withSandboxVerify(
  exec: ExecFn,
  launcher: SandboxLauncher,
  network: SandboxNetwork,
  proxy?: SandboxProxy,
  home?: string,
): ExecFn {
  return (cmd, args, opts) => {
    // Identity launcher (NoneLauncher) ONLY: forward the ORIGINAL call byte-for-byte, shell and all
    // — the `sh -c` rewrite is meaningful only inside a real jail. Keyed on the explicit `identity`
    // flag, not on string-comparing the rewritten command, so a real jail (or an UnavailableLauncher,
    // whose `wrap()` throws) can never fail OPEN here.
    if (launcher.identity) return exec(cmd, args, opts);
    // A shell verify command (`shell:true`, no pre-split argv) must run under `sh -c` inside the
    // jail; a structured argv is passed through as-is.
    const shellString = opts.shell === true && args.length === 0;
    const innerCmd = shellString ? 'sh' : cmd;
    const innerArgs = shellString ? ['-c', cmd] : args;
    const profile = resolveProfile(network, {
      workspace: opts.cwd,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(proxy !== undefined ? { proxy } : {}),
      ...(home !== undefined ? { home } : {}),
    });
    const wrapped = launcher.wrap(innerCmd, innerArgs, profile);
    const { shell: _shell, ...rest } = opts;
    return exec(wrapped.command, wrapped.args, rest);
  };
}
