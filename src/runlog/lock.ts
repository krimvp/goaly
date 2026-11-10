import { rmSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_FILE = 'run.lock';

/** Thrown when another live goaly process already holds the run directory. */
export class RunLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunLockedError';
  }
}

/** An acquired exclusive run-dir lock. `release()` is idempotent and best-effort. */
export type RunLock = { release(): Promise<void> };

/**
 * Take an exclusive per-run lock so two goaly processes can never drive the SAME run directory
 * concurrently (an accidental double `--resume`, or resuming a run that is still live, would
 * interleave appends with duplicate `seq` values and corrupt the write-ahead log logically).
 *
 * Mechanism: create `run.lock` with the `wx` flag (atomic create-or-fail) carrying the holder's
 * pid and start time. On conflict, the holder is probed with `kill(pid, 0)` and its start time
 * (see {@link holderAlive}): a LIVE holder fails closed with
 * a clear {@link RunLockedError}; a DEAD holder (crash / SIGKILL left the file behind) is stale —
 * the lock self-heals by unlinking and retrying, so a crashed run never needs manual cleanup.
 */
export async function acquireRunLock(
  runDir: string,
  opts: {
    /** Injected liveness probe (tests). Defaults to `process.kill(pid, 0)`. */
    isPidAlive?: (pid: number) => boolean;
    /** The pid recorded in the lock file. Defaults to `process.pid`. */
    pid?: number;
    /**
     * Called when a stale lock (dead holder) is reclaimed. The self-heal is correct but must not
     * be silent: the stale file is the trace of a crashed/killed driver, and the operator deserves
     * to know one was swept away. Default: no notice (library callers opt in).
     */
    onStaleReclaim?: (message: string) => void;
    /** Injected process start-time probe (tests). Defaults to `/proc/<pid>/stat`. */
    processStartOf?: (pid: number) => Promise<string | null>;
  } = {},
): Promise<RunLock> {
  const alive = opts.isPidAlive ?? defaultIsPidAlive;
  const startOf = opts.processStartOf ?? defaultProcessStartOf;
  const pid = opts.pid ?? process.pid;
  const path = join(runDir, LOCK_FILE);
  await mkdir(runDir, { recursive: true });

  // Two attempts: the second runs only after a stale lock was unlinked. A concurrent racer that
  // re-creates the file between unlink and retry loses nothing — the retry then fails closed.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      try {
        const start = await startOf(pid);
        await handle.write(start === null ? `${pid}\n` : `${pid} ${start}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      heldLocks.add(path);
      return {
        release: async () => {
          if (!heldLocks.delete(path)) return;
          await rm(path, { force: true }).catch(() => undefined);
        },
      };
    } catch (err: unknown) {
      if (!isExists(err)) throw err;
      const holder = await readHolder(path);
      if (holder !== null && holder.pid !== pid && (await holderAlive(holder, alive, startOf))) {
        throw new RunLockedError(
          `another goaly process (pid ${holder.pid}) is already driving this run — ` +
            `refusing to start a second one on the same run directory. ` +
            `If that process is truly gone, delete ${path} and retry.`,
        );
      }
      // Stale (holder dead / unreadable / our own pid from a previous incarnation): self-heal.
      // Suppress the notice for our own pid — re-locking after our own earlier incarnation is
      // routine, not the trace of a crash.
      if (holder?.pid !== pid) {
        opts.onStaleReclaim?.(
          holder === null
            ? `reclaimed an unreadable run lock at ${path} (previous driver left no valid pid)`
            : `reclaimed a stale run lock at ${path} (previous driver pid ${holder.pid} is gone — it crashed or was killed)`,
        );
      }
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  throw new RunLockedError(
    `could not acquire the run lock at ${path} (another process kept re-creating it)`,
  );
}

/** Lock files this process holds, so a forced exit or a fatal crash can remove them synchronously. */
const heldLocks = new Set<string>();

/**
 * Remove every run lock this process holds. For the exit paths that cannot await `release()`
 * (a second Ctrl-C, a fatal error): without it the next `--resume` reports a crashed driver.
 */
export function releaseHeldRunLocksSync(): void {
  for (const path of heldLocks) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best-effort: a lock left behind only costs the stale-lock notice.
    }
  }
  heldLocks.clear();
}

/**
 * Is a LIVE goaly process currently holding this run directory's lock? Read-only — used by
 * `runs watch` to tell "the run is still being driven" from "the run stalled/crashed" without ever
 * touching the lock itself.
 */
export async function runLockActive(
  runDir: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
  processStartOf: (pid: number) => Promise<string | null> = defaultProcessStartOf,
): Promise<boolean> {
  const holder = await readHolder(join(runDir, LOCK_FILE));
  return holder !== null && holderAlive(holder, isPidAlive, processStartOf);
}

type Holder = { pid: number; start: string | undefined };

/**
 * A live pid is the holder only when its process start time still matches the one the lock
 * recorded. After a reboot or a container restart the dead holder's pid is often reused by an
 * unrelated process, and that lock would otherwise block `--resume` until a human deleted it.
 * Without a recorded or readable start time (an old lock, no `/proc`), a live pid stays the holder.
 */
async function holderAlive(
  holder: Holder,
  isPidAlive: (pid: number) => boolean,
  processStartOf: (pid: number) => Promise<string | null>,
): Promise<boolean> {
  if (!isPidAlive(holder.pid)) return false;
  if (holder.start === undefined) return true;
  const current = await processStartOf(holder.pid);
  return current === null || current === holder.start;
}

/**
 * Is ANY run under this state dir currently held by a live process? The "one live run per tree"
 * guard (ADR 0015): per-run locks stop two drivers on one run, but nothing else stops two agents
 * editing one working tree — the UI refuses to start a second run in an occupied root, and
 * worktree removal refuses while an agent is inside. Read-only; a missing state dir is `false`.
 */
export async function anyRunLockActive(
  stateDir: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): Promise<boolean> {
  let names: string[];
  try {
    names = (await readdir(stateDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return false;
  }
  for (const name of names) {
    if (await runLockActive(join(stateDir, name), isPidAlive)) return true;
  }
  return false;
}

async function readHolder(path: string): Promise<Holder | null> {
  try {
    const [pidText, start] = (await readFile(path, 'utf8')).trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? { pid, start } : null;
  } catch {
    return null;
  }
}

/** Field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot); null where unreadable. */
async function defaultProcessStartOf(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but is owned by someone else — still alive.
    return isErrnoCode(err, 'EPERM');
  }
}

function isExists(err: unknown): boolean {
  return isErrnoCode(err, 'EEXIST');
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === code
  );
}
