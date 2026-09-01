import { killActiveChildren } from '../util/spawn';

/**
 * Last-resort fatal-error handler for the CLI process (`uncaughtException` /
 * `unhandledRejection`). A crash anywhere in the process — e.g. an unhandled `'error'` event on a
 * stream, the class of failure issue #101 was — must not orphan live child process groups: a
 * group-spawned agent CLI does not share the terminal's process group, so without the reap it
 * would outlive goaly and keep editing the tree and spending tokens (the same reasoning as the
 * force-exit sweep in `makeInterruptController`). The write-ahead log already makes the run
 * resumable; this guard only makes the death orderly. Injectable deps keep it unit-testable.
 */
export function makeCrashHandler(
  deps: {
    reap?: () => void;
    write?: (s: string) => void;
    exit?: (code: number) => void;
  } = {},
): (err: unknown) => void {
  const reap = deps.reap ?? killActiveChildren;
  const write = deps.write ?? ((s: string) => process.stderr.write(s));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  return (err: unknown): void => {
    // Reap FIRST: the write can itself fail (a broken stdout/stderr pipe is one way to get here),
    // and the children must be gone regardless.
    try {
      reap();
    } catch {
      // Never let the guard itself throw.
    }
    try {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      write(`goaly: fatal: ${message}\n`);
    } catch {
      // stderr may be gone too — exiting is all that is left.
    }
    exit(1);
  };
}
