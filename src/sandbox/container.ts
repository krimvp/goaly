import type { SandboxLauncher, WrappedCommand } from './launcher';
import {
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_RUNTIME,
  type SandboxRunOpts,
  type SandboxRuntime,
} from './policy';

/**
 * The portable, cross-platform mechanism (covers macOS via Docker/podman): rewrite a command into
 * a `docker`/`podman run --rm` invocation. PURE string construction — no spawn, no IO — so the
 * exact argv is table-testable.
 *
 * The jail: only the workspace is bind-mounted, READ-WRITE, at the SAME absolute path inside the
 * container (`-v <ws>:<ws>`) and made the cwd (`-w <ws>`) so pinned/relative paths still resolve;
 * the host `$HOME`/credential dirs are simply never mounted; egress is cut with `--network none`
 * when `network:'none'`; the (already-scrubbed, for the verifier) env is passed through with `-e
 * NAME` per var; then the image and `command args`.
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
    }
    // Pass through only the NAMEs (the runtime reads each value from this process's own env), so the
    // already-scrubbed verifier env is mirrored without ever embedding secret values in the argv.
    if (opts.env !== undefined) {
      for (const name of Object.keys(opts.env)) {
        if (opts.env[name] !== undefined) runArgs.push('-e', name);
      }
    }
    runArgs.push(this.#image, command, ...args);
    return { command: this.#runtime, args: runArgs };
  }
}
