import type { SandboxLauncher, WrappedCommand } from './launcher';
import { DENIED_HOME_SECRETS, type SandboxRunOpts } from './policy';

/** The bubblewrap binary name; the host probe (detect.ts) checks for it on PATH. */
export const BWRAP_COMMAND = 'bwrap';

/**
 * The lightweight Linux mechanism: rewrite a command into a `bwrap` (bubblewrap) invocation. PURE
 * string construction — no spawn, no IO — so the exact argv is table-testable.
 *
 * The jail: the whole filesystem is bound READ-ONLY (`--ro-bind / /`); `/dev`, `/proc`, and a fresh
 * `/tmp` are provided; each `$HOME` credential subdir is masked with an empty `--tmpfs` so even
 * though `/` is bound the agent can't read `~/.ssh`, `~/.aws`, …; THEN the workspace is bound
 * read-write (`--bind <ws> <ws>`) — applied LAST so neither the `/tmp` tmpfs nor a `$HOME` mask can
 * shadow a workspace that lives under them (e.g. a repo created under `/tmp`); egress is cut with
 * `--unshare-net` when `network:'none'`; the cwd is the workspace (`--chdir`); then `-- command args`.
 *
 * Mount ORDER matters: bubblewrap applies these left-to-right, and a later mount over a parent dir
 * hides anything bound under it earlier. So the rw workspace bind must come AFTER `--tmpfs /tmp`.
 */
export class BwrapLauncher implements SandboxLauncher {
  readonly mode = 'bwrap' as const;
  readonly identity = false;
  readonly available = true;
  readonly #home: string | undefined;

  /** `home` defaults to the process `$HOME`; injectable so the argv is deterministic in tests. */
  constructor(home: string | undefined = process.env.HOME) {
    this.#home = home;
  }

  wrap(command: string, args: string[], opts: SandboxRunOpts): WrappedCommand {
    const bwrapArgs: string[] = [
      '--ro-bind', '/', '/',
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp',
    ];
    // Mask each $HOME credential location with an empty tmpfs so it can't be read through `/`.
    if (this.#home !== undefined && this.#home.length > 0) {
      for (const secret of DENIED_HOME_SECRETS) {
        bwrapArgs.push('--tmpfs', `${this.#home}/${secret}`);
      }
    }
    // Bind the rw workspace LAST, so a workspace under /tmp (or a masked $HOME subdir) is not
    // shadowed by the tmpfs mounts above. Then chdir into it and run the command.
    bwrapArgs.push('--bind', opts.workspace, opts.workspace);
    if (opts.network === 'none') {
      bwrapArgs.push('--unshare-net');
    }
    bwrapArgs.push('--chdir', opts.workspace, '--', command, ...args);
    return { command: BWRAP_COMMAND, args: bwrapArgs };
  }
}
