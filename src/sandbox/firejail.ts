import type { SandboxLauncher, WrappedCommand } from './launcher';
import {
  DENIED_HOME_SECRETS,
  PROXY_ENV_VARS,
  PROXY_NO_PROXY,
  isAllowlist,
  proxyUrlFor,
  type SandboxRunOpts,
} from './policy';

/** The firejail binary name; the host probe (detect.ts) checks for it on PATH. */
export const FIREJAIL_COMMAND = 'firejail';

/**
 * A tiny shell preamble run INSIDE the jail to land in the workspace. Unlike bwrap (`--chdir`) and
 * the container (`-w`), firejail has no chdir flag and inherits the PARENT process cwd — which for
 * the harness seam is goaly's invocation cwd (the package root under `npm run`), not the workspace
 * (see `compose.ts`: the sandbox exec must set the jail's cwd itself). So we exec the real command
 * through `sh -c 'cd "$0" && exec "$@"' <workspace> <command> <args…>`: `$0` is the workspace, `$@`
 * is the command + its args. The `exec` keeps the original process semantics (no extra shell layer
 * lingering); it is idempotent for the verifier seam, whose exec already runs with cwd = workspace.
 */
export const FIREJAIL_CHDIR_WRAP = 'cd "$0" && exec "$@"';

/**
 * The Linux fallback when bwrap is absent (issue #40): rewrite a command into a `firejail`
 * invocation. PURE string construction — no spawn, no IO — so the exact argv is table-testable.
 *
 * The jail mirrors {@link BwrapLauncher}'s security properties via firejail's flags: `--noprofile`
 * (deterministic — ignore the host's `/etc/firejail` profiles) + `--quiet` (no banner polluting the
 * agent/verifier stdout); the whole filesystem is made read-only (`--read-only=/`) with a fresh
 * `/dev` (`--private-dev`); each `$HOME` credential subdir is denied with `--blacklist` so even
 * though `/` is visible the agent can't read `~/.ssh`, `~/.aws`, …; the workspace is re-enabled
 * read-write (`--read-write=<ws>`); egress is cut with `--net=none` when `network:'none'`, or — when
 * `network` is an allowlist (issue #39) — kept up but pinned to the egress proxy via
 * `--env HTTP(S)_PROXY=…` (the proxy denies non-listed hosts); finally the command is run under the
 * {@link FIREJAIL_CHDIR_WRAP} shell so it lands in the workspace.
 *
 * `/tmp` handling differs from bwrap. firejail applies its filesystem ops in its OWN internal order
 * (not argv order), so bwrap's "bind the workspace LAST" trick has no firejail equivalent: a fresh
 * `--private-tmp` would shadow a workspace that lives under `/tmp` with no way to re-expose it. So we
 * use `--private-tmp` (a fresh, isolated tmpfs — matching bwrap's `--tmpfs /tmp`) ONLY when the
 * workspace is not under `/tmp`; for a workspace under `/tmp` (e.g. a `mktemp -d` throwaway repo) we
 * instead keep the real `/tmp` writable (`--read-write=/tmp`) so the workspace inside it stays
 * reachable. Either way the read-only root would otherwise leave no writable temp, breaking most
 * toolchains, so a writable `/tmp` is always provided.
 */
export class FirejailLauncher implements SandboxLauncher {
  readonly mode = 'firejail' as const;
  readonly identity = false;
  readonly available = true;
  readonly #home: string | undefined;

  /** `home` defaults to the process `$HOME`; injectable so the argv is deterministic in tests. */
  constructor(home: string | undefined = process.env.HOME) {
    this.#home = home;
  }

  wrap(command: string, args: string[], opts: SandboxRunOpts): WrappedCommand {
    const firejailArgs: string[] = ['--quiet', '--noprofile', '--private-dev', '--read-only=/'];
    // Deny each $HOME credential location so it can't be read through the visible `/`.
    if (this.#home !== undefined && this.#home.length > 0) {
      for (const secret of DENIED_HOME_SECRETS) {
        firejailArgs.push(`--blacklist=${this.#home}/${secret}`);
      }
    }
    // Re-enable the workspace read-write (overrides the read-only root for this subtree).
    firejailArgs.push(`--read-write=${opts.workspace}`);
    // A writable /tmp is always needed (the read-only root makes it RO otherwise). Prefer a fresh,
    // isolated tmpfs; fall back to the real /tmp when the workspace lives under it (a private tmpfs
    // would shadow it, and firejail can't re-expose it the way bwrap's "bind last" does).
    if (isUnderTmp(opts.workspace)) {
      firejailArgs.push('--read-write=/tmp');
    } else {
      firejailArgs.push('--private-tmp');
    }
    if (opts.network === 'none') {
      firejailArgs.push('--net=none');
    } else if (isAllowlist(opts.network)) {
      // Allowlist (issue #39): keep the host network so the jail can reach the egress proxy on the
      // shared host loopback, and point the standard proxy env vars at it with `--env` (firejail
      // inherits the host env, so we override explicitly). Enforcement is proxy-side: only the
      // allowlisted hosts get out. Fail-closed if the proxy port is missing (`proxyUrlFor` throws).
      const url = proxyUrlFor('127.0.0.1', opts.proxy);
      for (const name of PROXY_ENV_VARS) {
        firejailArgs.push(`--env=${name}=${url}`);
      }
      firejailArgs.push(`--env=NO_PROXY=${PROXY_NO_PROXY}`, `--env=no_proxy=${PROXY_NO_PROXY}`);
    }
    // firejail has no `--chdir`; run the command under a shell that cd's into the workspace first.
    firejailArgs.push('sh', '-c', FIREJAIL_CHDIR_WRAP, opts.workspace, command, ...args);
    return { command: FIREJAIL_COMMAND, args: firejailArgs };
  }
}

/** Is the absolute path `/tmp` itself or under it? Pure. */
function isUnderTmp(path: string): boolean {
  return path === '/tmp' || path.startsWith('/tmp/');
}
