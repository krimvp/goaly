/**
 * Last-resort process guard (fail-closed at the process boundary). Every seam is built to fail
 * closed — adapters never reject, `drive()` resolves a typed outcome, the run log is write-ahead —
 * but a bug that escapes all of that (an 'error' event on a listener-less socket, a throw inside a
 * callback that outlived its awaiter — e.g. issue #101's EPIPE) would otherwise crash the process
 * with a raw stack AND orphan any live agent CLI, which keeps editing the tree and spending tokens
 * after goaly is gone.
 *
 * The guard converts that crash into a clean, loud, resumable exit: it prints the stack plus the
 * resume hint, reaps live children (the same sweep the force-Ctrl-C path uses), and exits 1. It
 * NEVER swallows-and-continues — after an uncaught error the process state is untrustworthy, and
 * the write-ahead log makes exiting safe (a torn FINAL line is tolerated and repaired on the next
 * append; no completed iteration is repeated).
 *
 * Installed once by the process bootstrap (`bin.ts`); injectable so tests never exit for real.
 */
import { killActiveChildren } from '../util/spawn';

export type CrashGuardDeps = {
  /** Diagnostic channel (defaults to `process.stderr`). */
  err?: (s: string) => void;
  /** Reap live child processes (defaults to the shared spawn sweep). */
  killChildren?: () => void;
  /** End the process (defaults to `process.exit`). */
  exit?: (code: number) => void;
};

const formatCause = (cause: unknown): string =>
  cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);

/**
 * Install the `uncaughtException` / `unhandledRejection` handlers. Returns an uninstall function
 * (symmetric with the interrupt controller's lifecycle). Re-entrant triggers short-circuit: if the
 * cleanup path itself throws, the default crash behavior must not be re-armed into a loop.
 */
export function installCrashGuard(deps: CrashGuardDeps = {}): () => void {
  const err = deps.err ?? ((s: string) => process.stderr.write(s));
  const killChildren = deps.killChildren ?? killActiveChildren;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let triggered = false;

  const onCrash = (kind: string): ((cause: unknown) => void) => {
    return (cause: unknown) => {
      if (triggered) return;
      triggered = true;
      err(
        `\ngoaly: unexpected ${kind} — this is a bug; the run is NOT lost.\n` +
          `${formatCause(cause)}\n` +
          `goaly: resume with: goaly --resume <run-id> (plus your original flags; ` +
          `list runs with: goaly runs)\n`,
      );
      try {
        killChildren();
      } catch (e) {
        // The guard is the last resort — it must never throw itself.
        err(`goaly: child sweep during crash cleanup also failed: ${formatCause(e)}\n`);
      } finally {
        exit(1);
      }
    };
  };

  const onUncaught = onCrash('uncaught exception');
  const onRejection = onCrash('unhandled rejection');
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return () => {
    process.removeListener('uncaughtException', onUncaught);
    process.removeListener('unhandledRejection', onRejection);
  };
}
