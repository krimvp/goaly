import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireRunLock, RunLockedError } from './lock';

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
