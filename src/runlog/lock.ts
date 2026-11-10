import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setChildGroupsListener } from '../util/spawn';

const LOCK_FILE = 'run.lock';
/** The holder's live child process groups, `pid start` per line — see {@link recordChildGroups}. */
const CHILDREN_FILE = 'run.children';

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
 * Before it does, it SIGKILLs the child process groups the dead holder recorded (see
 * {@link reapRecordedChildGroups}): after a SIGKILL of goaly its agent can still be editing the tree.
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
      heldRunDirs.add(runDir);
      setChildGroupsListener(recordChildGroups);
      return {
        release: async () => {
          if (!heldRunDirs.delete(runDir)) return;
          await rm(join(runDir, CHILDREN_FILE), { force: true }).catch(() => undefined);
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
        const reaped = await reapRecordedChildGroups(runDir, startOf);
        const orphans =
          reaped > 0 ? `; stopped ${reaped} process group(s) it left running in the tree` : '';
        opts.onStaleReclaim?.(
          holder === null
            ? `reclaimed an unreadable run lock at ${path} (previous driver left no valid pid${orphans})`
            : `reclaimed a stale run lock at ${path} (previous driver pid ${holder.pid} is gone — it crashed or was killed${orphans})`,
        );
      }
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
  throw new RunLockedError(
    `could not acquire the run lock at ${path} (another process kept re-creating it)`,
  );
}

/** Run dirs whose lock this process holds. */
const heldRunDirs = new Set<string>();

/**
 * Write this process's live child groups next to every lock it holds. A SIGKILL of goaly cannot reap
 * them, so the next driver that reclaims the stale lock does. A child whose start time cannot be read
 * (no `/proc`) is not recorded and so is never reaped. No fsync: the record must outlive the goaly
 * process only — a power loss stops the children too.
 */
function recordChildGroups(pids: number[]): void {
  const lines = pids
    .flatMap((pid) => {
      const start = processStartSync(pid);
      return start === null ? [] : [`${pid} ${start}\n`];
    })
    .join('');
  for (const dir of heldRunDirs) {
    const file = join(dir, CHILDREN_FILE);
    try {
      if (lines === '') {
        rmSync(file, { force: true });
      } else {
        writeFileSync(`${file}.tmp`, lines);
        renameSync(`${file}.tmp`, file);
      }
    } catch {
      // One unwritable run dir must not cost the others their record.
    }
  }
}

/**
 * SIGKILL each child group a dead driver recorded, but only while its leader still has the recorded
 * start time: a pid that now names another process is never touched. Returns the count killed.
 */
async function reapRecordedChildGroups(
  runDir: string,
  startOf: (pid: number) => Promise<string | null>,
): Promise<number> {
  const file = join(runDir, CHILDREN_FILE);
  let reaped = 0;
  for (const child of parseEntries(await readFile(file, 'utf8').catch(() => ''))) {
    // `kill(-1)` would signal every process this user owns: never let a record reach it.
    if (child.pid <= 1 || child.start === undefined) continue;
    if ((await startOf(child.pid)) !== child.start) continue;
    try {
      process.kill(-child.pid, 'SIGKILL');
      reaped += 1;
    } catch {
      // Already gone.
    }
  }
  await rm(file, { force: true }).catch(() => undefined);
  return reaped;
}

/**
 * Remove every run lock this process holds. For the exit paths that cannot await `release()`
 * (a second Ctrl-C, a fatal error): without it the next `--resume` reports a crashed driver.
 */
export function releaseHeldRunLocksSync(): void {
  for (const dir of heldRunDirs) {
    try {
      rmSync(join(dir, CHILDREN_FILE), { force: true });
      rmSync(join(dir, LOCK_FILE), { force: true });
    } catch {
      // Best-effort: a lock left behind only costs the stale-lock notice.
    }
  }
  heldRunDirs.clear();
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
 * editing one working tree — `executeRun` and the UI refuse to start a second run in an occupied
 * root, and worktree removal refuses while an agent is inside. Read-only; a missing state dir is `false`.
 */
export async function anyRunLockActive(
  stateDir: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): Promise<boolean> {
  return (await liveRunIn(stateDir, undefined, isPidAlive)) !== undefined;
}

/** The id of a run under this state dir, other than `exceptRunId`, that a live process holds. */
export async function liveRunIn(
  stateDir: string,
  exceptRunId?: string,
  isPidAlive: (pid: number) => boolean = defaultIsPidAlive,
): Promise<string | undefined> {
  let names: string[];
  try {
    names = (await readdir(stateDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name !== exceptRunId)
      .map((d) => d.name);
  } catch {
    return undefined;
  }
  for (const name of names) {
    if (await runLockActive(join(stateDir, name), isPidAlive)) return name;
  }
  return undefined;
}

async function readHolder(path: string): Promise<Holder | null> {
  try {
    return parseEntries(await readFile(path, 'utf8'))[0] ?? null;
  } catch {
    return null;
  }
}

/** `pid [start]` per line; a line without a valid pid is dropped. */
function parseEntries(text: string): Holder[] {
  return text.split('\n').flatMap((line) => {
    const [pidText, start] = line.trim().split(/\s+/);
    const pid = Number.parseInt(pidText ?? '', 10);
    return Number.isInteger(pid) && pid > 0 ? [{ pid, start }] : [];
  });
}

/** Field 22 of `/proc/<pid>/stat` (start time in clock ticks since boot); null where unreadable. */
function processStartSync(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

async function defaultProcessStartOf(pid: number): Promise<string | null> {
  return processStartSync(pid);
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
