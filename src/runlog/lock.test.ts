import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRunLock, RunLockedError, runLockActive } from './lock';
import { runProcess } from '../util/spawn';

let counter = 0;
async function freshDir(): Promise<string> {
  counter += 1;
  return mkdtemp(join(tmpdir(), `run-lock-${process.pid}-${counter}-`));
}

describe('acquireRunLock', () => {
  it('acquires a fresh lock and records the pid', async () => {
    const dir = await freshDir();
    try {
      const lock = await acquireRunLock(dir, { pid: 4242 });
      const raw = await readFile(join(dir, 'run.lock'), 'utf8');
      expect(raw.trim()).toBe('4242');
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed with RunLockedError while a live holder exists', async () => {
    const dir = await freshDir();
    try {
      const lock = await acquireRunLock(dir, { pid: 1000, isPidAlive: () => true });
      await expect(acquireRunLock(dir, { pid: 2000, isPidAlive: () => true })).rejects.toThrow(
        RunLockedError,
      );
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('self-heals a stale lock whose holder is dead', async () => {
    const dir = await freshDir();
    try {
      await acquireRunLock(dir, { pid: 1000, isPidAlive: () => true });
      // Holder "dies": the liveness probe now says the recorded pid is gone.
      const lock = await acquireRunLock(dir, { pid: 2000, isPidAlive: () => false });
      const raw = await readFile(join(dir, 'run.lock'), 'utf8');
      expect(raw.trim()).toBe('2000');
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('self-heals a lock whose pid now belongs to a different live process (pid reuse)', async () => {
    const dir = await freshDir();
    try {
      // After a reboot or a container restart, the dead holder's pid is reused by another process.
      await acquireRunLock(dir, { pid: 1000, isPidAlive: () => true, processStartOf: async () => '111' });
      await expect(
        acquireRunLock(dir, { pid: 2000, isPidAlive: () => true, processStartOf: async () => '111' }),
      ).rejects.toThrow(RunLockedError);
      expect(await runLockActive(dir, () => true, async () => '999')).toBe(false);

      const notices: string[] = [];
      const lock = await acquireRunLock(dir, {
        pid: 2000,
        isPidAlive: () => true,
        processStartOf: async (pid) => (pid === 1000 ? '999' : '222'),
        onStaleReclaim: (m) => notices.push(m),
      });
      expect(notices[0]).toContain('pid 1000');
      expect((await readFile(join(dir, 'run.lock'), 'utf8')).trim()).toBe('2000 222');
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a stale-lock reclaim through onStaleReclaim, naming the dead pid', async () => {
    const dir = await freshDir();
    try {
      await acquireRunLock(dir, { pid: 1000, isPidAlive: () => true });
      const notices: string[] = [];
      const lock = await acquireRunLock(dir, {
        pid: 2000,
        isPidAlive: () => false,
        onStaleReclaim: (m) => notices.push(m),
      });
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('stale run lock');
      expect(notices[0]).toContain('pid 1000');
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not report a reclaim of our own pid from a previous incarnation', async () => {
    const dir = await freshDir();
    try {
      await acquireRunLock(dir, { pid: 2000, isPidAlive: () => true });
      const notices: string[] = [];
      const lock = await acquireRunLock(dir, {
        pid: 2000,
        isPidAlive: () => true,
        onStaleReclaim: (m) => notices.push(m),
      });
      expect(notices).toHaveLength(0);
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('self-heals an unreadable/garbage lock file', async () => {
    const dir = await freshDir();
    try {
      await writeFile(join(dir, 'run.lock'), 'not-a-pid\n', 'utf8');
      const lock = await acquireRunLock(dir, { pid: 2000, isPidAlive: () => true });
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('release() removes the lock so a new run can start, and is idempotent', async () => {
    const dir = await freshDir();
    try {
      const first = await acquireRunLock(dir, { pid: 1000, isPidAlive: () => true });
      await first.release();
      await first.release(); // idempotent
      const second = await acquireRunLock(dir, { pid: 2000, isPidAlive: () => true });
      await second.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const hasProc = existsSync('/proc/self/stat');

/** A detached `sleep` (its own process group, like a goaly agent or verify command). */
function detachedSleep(): ChildProcess {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child;
}

function startOf(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]!;
}

const exited = (child: ChildProcess): Promise<boolean> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(false), 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

describe('orphaned child groups of a killed driver', () => {
  it.skipIf(!hasProc)('a stale-lock reclaim kills the recorded groups whose start time still matches', async () => {
    const dir = await freshDir();
    const orphan = detachedSleep();
    const reused = detachedSleep();
    try {
      await writeFile(join(dir, 'run.lock'), '4242 1\n');
      await writeFile(
        join(dir, 'run.children'),
        `${orphan.pid} ${startOf(orphan.pid!)}\n${reused.pid} 1\n`,
      );
      const notices: string[] = [];
      const lock = await acquireRunLock(dir, {
        isPidAlive: (p) => p !== 4242,
        onStaleReclaim: (m) => notices.push(m),
      });
      expect(await exited(orphan)).toBe(true);
      // Its start time does not match the record: the pid names another process now.
      expect(reused.exitCode).toBeNull();
      expect(reused.signalCode).toBeNull();
      expect(existsSync(join(dir, 'run.children'))).toBe(false);
      expect(notices.join('')).toContain('stopped 1 process group(s)');
      await lock.release();
    } finally {
      orphan.kill('SIGKILL');
      reused.kill('SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasProc)('records each live group-spawned child next to the held lock, and clears it after', async () => {
    const dir = await freshDir();
    try {
      const lock = await acquireRunLock(dir);
      let record = '';
      let expected = '';
      await runProcess('sh', ['-c', 'echo $$; sleep 0.3'], {
        killGroup: true,
        onStdout: (chunk) => {
          const pid = Number(chunk.trim());
          expected = `${pid} ${startOf(pid)}\n`;
          record = readFileSync(join(dir, 'run.children'), 'utf8');
        },
      });
      expect(record).toBe(expected);
      expect(existsSync(join(dir, 'run.children'))).toBe(false);
      await lock.release();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
