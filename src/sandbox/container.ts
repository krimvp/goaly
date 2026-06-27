import type { SandboxLauncher, WrappedCommand } from './launcher';
import {
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_RUNTIME,
  proxyEnv,
  type SandboxProfile,
  type SandboxRuntime,
} from './policy';

/**
 * The host alias a container reaches the host (and thus the egress proxy) through (issue #39). We
 * map it to the runtime's `host-gateway` magic value with `--add-host`, so it works the same on
 * docker and podman without depending on a runtime-specific built-in name.
 */
export const CONTAINER_HOST_GATEWAY = 'goaly-host-gateway';

/**
 * The portable, cross-platform mechanism (covers macOS via Docker/podman): translate a resolved
 * {@link SandboxProfile} into a `docker`/`podman run --rm` invocation. PURE string construction —
 * no spawn, no IO — so the exact argv is table-testable, and all policy is already decided in the
 * profile.
 *
 * The jail: only the workspace is bind-mounted, READ-WRITE, at the SAME absolute path inside the
 * container (`-v <ws>:<ws>`) and made the cwd (`-w <ws>`) so pinned/relative paths still resolve;
 * the host `$HOME`/credential dirs are simply never mounted (so `profile.denyDirs` is moot here);
 * egress is cut with `--network none` when `isolated`, or — when `proxied` (issue #39) — kept up but
 * pinned to the host egress proxy (reached via a `--add-host` gateway alias + `-e HTTP(S)_PROXY`, the
 * proxy denying non-listed hosts); the (already-scrubbed, for the verifier) env is passed through
 * with `-e NAME` per var; then the image and `command args`.
 */
export class ContainerLauncher implements SandboxLauncher {
  readonly mode = 'container' as const;
  readonly identity = false;
  readonly available = true;
  readonly #runtime: SandboxRuntime;
  readonly #image: string;

  constructor(opts: { runtime?: SandboxRuntime; image?: string } = {}) {
    this.#runtime = opts.runtime ?? DEFAULT_CONTAINER_RUNTIME;
    this.#image = opts.image ?? DEFAULT_CONTAINER_IMAGE;
  }

  wrap(command: string, args: string[], profile: SandboxProfile): WrappedCommand {
    const runArgs: string[] = [
      'run', '--rm',
      '-v', `${profile.workspace}:${profile.workspace}`,
      '-w', profile.workspace,
    ];
    if (profile.network === 'isolated') {
      runArgs.push('--network', 'none');
    } else if (profile.network === 'proxied') {
      // Keep the default bridge network (so the host gateway is reachable) and map a stable host
      // alias to the runtime's host-gateway. The proxy `-e` vars are appended AFTER the env
      // passthrough below, so they win over any host proxy env carried in.
      runArgs.push('--add-host', `${CONTAINER_HOST_GATEWAY}:host-gateway`);
    }
    // Pass through only the NAMEs (the runtime reads each value from this process's own env), so the
    // already-scrubbed verifier env is mirrored without ever embedding secret values in the argv.
    if (profile.env !== undefined) {
      for (const name of Object.keys(profile.env)) {
        if (profile.env[name] !== undefined) runArgs.push('-e', name);
      }
    }
    // Pin the proxy env LAST (issue #39): a later `-e NAME=value` overrides an earlier name-only
    // `-e NAME`, so an inherited host `HTTP_PROXY` can't clobber the route to our egress proxy.
    if (profile.network === 'proxied') {
      proxyEnv(
        (name, value) => runArgs.push('-e', `${name}=${value}`),
        CONTAINER_HOST_GATEWAY,
        profile.proxy,
      );
    }
    runArgs.push(this.#image, command, ...args);
    return { command: this.#runtime, args: runArgs };
  }
}
