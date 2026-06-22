import type { LauncherMode, SandboxRunOpts } from './policy';

/** The result of rewriting a command into its jailed form: a new argv front, same semantics. */
export type WrappedCommand = { command: string; args: string[] };

/**
 * The sandbox seam (issue #9). A launcher rewrites a `(command, args)` pair into its jailed form —
 * PURE string construction only: no spawn, no IO. That keeps every mechanism fully table-testable
 * and keeps the effect (actually spawning the rewritten command) in the Driver, where the real exec
 * already lives.
 */
export interface SandboxLauncher {
  /** Rewrite a command into its jailed form. PURE — no spawn, no IO. */
  wrap(command: string, args: string[], opts: SandboxRunOpts): WrappedCommand;
  /** The concrete mechanism this launcher implements (`none` | `bwrap` | `container`). */
  readonly mode: LauncherMode;
  /**
   * `true` ONLY for the {@link NoneLauncher} identity passthrough. The exec wrappers key the
   * "forward the original call unchanged" decision on THIS flag — never on string-comparing the
   * rewritten command — so the only fail-OPEN (unsandboxed) path is the explicit NoneLauncher.
   * A real jail (`bwrap`/`container`) or an {@link UnavailableLauncher} is never identity, so its
   * `wrap()` is always invoked: a real launcher rewrites; an unavailable one THROWS (fail-closed,
   * invariant #4) even if the upstream `refuseIfUnavailable` guard were ever bypassed.
   */
  readonly identity: boolean;
  /**
   * When `false`, composing a run with this launcher must REFUSE TO START (fail-closed, invariant
   * #4). Only {@link UnavailableLauncher} is unavailable; every real launcher is available.
   */
  readonly available: boolean;
  /** A human-readable reason the run cannot start, present only when `available === false`. */
  readonly unavailableReason?: string;
}

/**
 * The default launcher: a perfect identity passthrough. With `--sandbox=none` (or no flag) the
 * harness and verifier execs are byte-for-byte the current calls — Option 1 preserved exactly.
 */
export class NoneLauncher implements SandboxLauncher {
  readonly mode = 'none' as const;
  readonly identity = true;
  readonly available = true;
  wrap(command: string, args: string[]): WrappedCommand {
    return { command, args };
  }
}

/**
 * Returned by {@link makeLauncher} when a mechanism was REQUESTED but {@link detectMechanism} found
 * it absent. Its presence makes the run refuse to start — `wrap` throws and `available` is `false`,
 * so the composition root never spawns anything unsandboxed (fail-closed, invariant #4). It never
 * silently downgrades to {@link NoneLauncher}.
 */
export class UnavailableLauncher implements SandboxLauncher {
  readonly mode = 'none' as const;
  readonly identity = false;
  readonly available = false;
  readonly unavailableReason: string;
  constructor(reason: string) {
    this.unavailableReason = reason;
  }
  wrap(): WrappedCommand {
    throw new SandboxUnavailableError(this.unavailableReason);
  }
}

/** Thrown when an unavailable sandbox would otherwise run code unsandboxed (fail-closed). */
export class SandboxUnavailableError extends Error {}
