import { mkdir, open, readFile, rm } from 'node:fs/promises';
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
 * pid. On conflict, the holder pid is probed with `kill(pid, 0)`: a LIVE holder fails closed with
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
  } = {},
): Promise<RunLock> {
  const alive = opts.isPidAlive ?? defaultIsPidAlive;
  const pid = opts.pid ?? process.pid;
  const path = join(runDir, LOCK_FILE);
  await mkdir(runDir, { recursive: true });

  // Two attempts: the second runs only after a stale lock was unlinked. A concurrent racer that
  // re-creates the file between unlink and retry loses nothing — the retry then fails closed.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx');
      try {
        await handle.write(`${pid}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await rm(path, { force: true }).catch(() => undefined);
        },
      };
    } catch (err: unknown) {
      if (!isExists(err)) throw err;
      const holder = await readHolderPid(path);
      if (holder !== null && holder !== pid && alive(holder)) {
        throw new RunLockedError(
          `another goaly process (pid ${holder}) is already driving this run — ` +
            `refusing to start a second one on the same run directory. ` +
            `If that process is truly gone, delete ${path} and retry.`,
        );
      }
      // Stale (holder dead / unreadable / our own pid from a previous incarnation): self-heal.
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  throw new RunLockedError(
    `could not acquire the run lock at ${path} (another process kept re-creating it)`,
  );
}

async function readHolderPid(path: string): Promise<number | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
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
