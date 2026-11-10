import { readFileSync } from 'node:fs';
import { killActiveChildren } from '../util/spawn';

/**
 * Graceful-interrupt wiring (Ctrl-C / SIGTERM). The FIRST signal requests a cooperative stop: the
 * Driver finishes the in-flight step (its event lands write-ahead) and resolves to a typed ABORTED
 * with the resume command — nothing is lost and the user is told exactly how to continue. A SECOND
 * signal force-exits (130) after reaping any live child process groups (a group-spawned agent CLI
 * does not share the terminal's process group, so without the sweep it would outlive goaly and
 * keep editing/spending). Exposed for tests; `executeRun` installs/removes it around `drive()`.
 */
export function makeInterruptController(
  runId: string,
  warn: (s: string) => void,
  forceExit: () => void = () => {
    killActiveChildren();
    process.exit(130);
  },
): { onSignal: () => void; interrupted: () => boolean } {
  let signals = 0;
  return {
    onSignal: (): void => {
      signals += 1;
      if (signals === 1) {
        warn(
          `\ngoaly: interrupt received — finishing the current step, then stopping cleanly ` +
            `(press Ctrl-C again to exit immediately).\n` +
            `goaly: resume later with: goaly --resume ${runId}\n`,
        );
        return;
      }
      warn(`\ngoaly: exiting immediately — resume with: goaly --resume ${runId}\n`);
      forceExit();
    },
    interrupted: (): boolean => signals > 0,
  };
}

/**
 * Install `onSignal` for every signal that means "stop this run". SIGHUP is the terminal going
 * away (an ssh drop, a closed window): by default it kills goaly at once, which orphans the
 * group-spawned agent and loses its in-flight turn. Under `nohup` SIGHUP is ignored on purpose, and
 * a handler would cancel that, so it is left alone there. Returns the uninstaller.
 */
export function installInterruptHandlers(
  onSignal: () => void,
  proc: Pick<NodeJS.EventEmitter, 'on' | 'removeListener'> = process,
  hupIgnored: boolean = sighupIgnored(),
): () => void {
  const signals = ['SIGINT', 'SIGTERM', ...(hupIgnored ? [] : ['SIGHUP'])];
  for (const s of signals) proc.on(s, onSignal);
  return () => {
    for (const s of signals) proc.removeListener(s, onSignal);
  };
}

/** Bit 0 of the `SigIgn` mask in `/proc/self/status` is SIGHUP; false where it cannot be read. */
function sighupIgnored(): boolean {
  try {
    const mask = /^SigIgn:\s*([0-9a-f]+)/m.exec(readFileSync('/proc/self/status', 'utf8'))?.[1];
    return mask !== undefined && (BigInt(`0x${mask}`) & 1n) === 1n;
  } catch {
    return false;
  }
}

const CLOSED_CONSOLE_CODES: ReadonlySet<unknown> = new Set(['EPIPE', 'EIO', 'ERR_STREAM_DESTROYED']);

/**
 * A closed stdout/stderr (`goaly … | head`, a dead `tee`, a vanished tty) emits an unhandled
 * `'error'` that would end the run through the crash handler. The console is only a view: the
 * run's own `goaly.log` and write-ahead log keep the record, so the run continues without it.
 */
export function tolerateClosedConsole(
  streams: readonly Pick<NodeJS.EventEmitter, 'on'>[] = [process.stdout, process.stderr],
): void {
  for (const stream of streams) {
    stream.on('error', (err: unknown) => {
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
      if (!CLOSED_CONSOLE_CODES.has(code)) throw err;
    });
  }
}

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
