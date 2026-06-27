import type { SandboxLauncher, WrappedCommand } from './launcher';
import { proxyEnv, type SandboxProfile } from './policy';

/** The bubblewrap binary name; the host probe (detect.ts) checks for it on PATH. */
export const BWRAP_COMMAND = 'bwrap';

/**
 * The lightweight Linux mechanism: translate a resolved {@link SandboxProfile} into a `bwrap`
 * (bubblewrap) invocation. PURE string construction — no spawn, no IO — so the exact argv is
 * table-testable, and all policy is already decided in the profile.
 *
 * The jail: the whole filesystem is bound READ-ONLY (`--ro-bind / /`); `/dev`, `/proc`, and a fresh
 * `/tmp` are provided; each `profile.denyDirs` credential dir is masked with an empty `--tmpfs` so
 * even though `/` is bound the agent can't read `~/.ssh`, `~/.aws`, …; THEN the workspace is bound
 * read-write (`--bind <ws> <ws>`) — applied LAST so neither the `/tmp` tmpfs nor a `$HOME` mask can
 * shadow a workspace that lives under them (e.g. a repo created under `/tmp`); egress is cut with
 * `--unshare-net` when `isolated`, or — when `proxied` (issue #39) — kept up but pinned to the egress
 * proxy via `--setenv HTTP(S)_PROXY` (the proxy denies non-listed hosts); the cwd is the workspace
 * (`--chdir`); then `-- command args`.
 *
 * Mount ORDER matters: bubblewrap applies these left-to-right, and a later mount over a parent dir
 * hides anything bound under it earlier. So the rw workspace bind must come AFTER `--tmpfs /tmp`.
 */
export class BwrapLauncher implements SandboxLauncher {
  readonly mode = 'bwrap' as const;
  readonly identity = false;
  readonly available = true;

  wrap(command: string, args: string[], profile: SandboxProfile): WrappedCommand {
    const bwrapArgs: string[] = [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
    ];
    // Mask each credential location with an empty tmpfs so it can't be read through `/`.
    for (const dir of profile.denyDirs) {
      bwrapArgs.push('--tmpfs', dir);
    }
    // Bind the rw workspace LAST, so a workspace under /tmp (or a masked $HOME subdir) is not
    // shadowed by the tmpfs mounts above. Then chdir into it and run the command.
    bwrapArgs.push('--bind', profile.workspace, profile.workspace);
    if (profile.network === 'isolated') {
      bwrapArgs.push('--unshare-net');
    } else if (profile.network === 'proxied') {
      // Keep the host network so the jail reaches the egress proxy on the shared host loopback, and
      // point the standard proxy env vars at it (bwrap inherits the host env, so override explicitly).
      proxyEnv((name, value) => bwrapArgs.push('--setenv', name, value), '127.0.0.1', profile.proxy);
    }
    bwrapArgs.push('--chdir', profile.workspace, '--', command, ...args);
    return { command: BWRAP_COMMAND, args: bwrapArgs };
  }
}
