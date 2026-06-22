import type { SandboxLauncher, WrappedCommand } from './launcher';
import {
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_RUNTIME,
  PROXY_ENV_VARS,
  PROXY_NO_PROXY,
  isAllowlist,
  proxyUrlFor,
  type SandboxRunOpts,
  type SandboxRuntime,
} from './policy';

/**
 * The host alias a container reaches the host (and thus the egress proxy) through (issue #39). We
 * map it to the runtime's `host-gateway` magic value with `--add-host`, so it works the same on
 * docker and podman without depending on a runtime-specific built-in name.
 */
export const CONTAINER_HOST_GATEWAY = 'goaly-host-gateway';

/**
 * The portable, cross-platform mechanism (covers macOS via Docker/podman): rewrite a command into
 * a `docker`/`podman run --rm` invocation. PURE string construction — no spawn, no IO — so the
 * exact argv is table-testable.
 *
 * The jail: only the workspace is bind-mounted, READ-WRITE, at the SAME absolute path inside the
 * container (`-v <ws>:<ws>`) and made the cwd (`-w <ws>`) so pinned/relative paths still resolve;
 * the host `$HOME`/credential dirs are simply never mounted; egress is cut with `--network none`
 * when `network:'none'`, or — when `network` is an allowlist (issue #39) — kept up but pinned to the
 * host egress proxy (reached via a `--add-host` gateway alias + `-e HTTP(S)_PROXY`, the proxy
 * denying non-listed hosts); the (already-scrubbed, for the verifier) env is passed through with
 * `-e NAME` per var; then the image and `command args`.
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

  wrap(command: string, args: string[], opts: SandboxRunOpts): WrappedCommand {
    const runArgs: string[] = [
      'run', '--rm',
      '-v', `${opts.workspace}:${opts.workspace}`,
      '-w', opts.workspace,
    ];
    if (opts.network === 'none') {
      runArgs.push('--network', 'none');
    } else if (isAllowlist(opts.network)) {
      // Allowlist (issue #39): keep the default bridge network (so the host gateway is reachable)
      // and map a stable host alias to the runtime's host-gateway. The actual proxy `-e` vars are
      // appended AFTER the env passthrough below, so they win over any host proxy env carried in.
      runArgs.push('--add-host', `${CONTAINER_HOST_GATEWAY}:host-gateway`);
    }
    // Pass through only the NAMEs (the runtime reads each value from this process's own env), so the
    // already-scrubbed verifier env is mirrored without ever embedding secret values in the argv.
    if (opts.env !== undefined) {
      for (const name of Object.keys(opts.env)) {
        if (opts.env[name] !== undefined) runArgs.push('-e', name);
      }
    }
    // Pin the proxy env LAST (issue #39): a later `-e NAME=value` overrides an earlier name-only
    // `-e NAME`, so an inherited host `HTTP_PROXY` can't clobber the route to our egress proxy.
    // Fail-closed if the proxy port is missing (`proxyUrlFor` throws).
    if (isAllowlist(opts.network)) {
      const url = proxyUrlFor(CONTAINER_HOST_GATEWAY, opts.proxy);
      for (const name of PROXY_ENV_VARS) {
        runArgs.push('-e', `${name}=${url}`);
      }
      runArgs.push('-e', `NO_PROXY=${PROXY_NO_PROXY}`, '-e', `no_proxy=${PROXY_NO_PROXY}`);
    }
    runArgs.push(this.#image, command, ...args);
    return { command: this.#runtime, args: runArgs };
  }
}
