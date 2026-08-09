import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitWorkspace, type ExecFn } from './git-workspace';
import { FileWorkspace } from './file-workspace';
import { FsScratchHost } from './scratch-copy';
import type { CommandResult } from './workspace';
import { FakeWorkspace, FakeScratchHost } from '../testing/fakes';
import { executionErrorReason } from '../verify/deterministic';

/**
 * SEAM PARITY for the three could-not-EVALUATE facts on {@link CommandResult}.
 *
 * `timedOut`, `spawnFailed` and `outputCapped` are the facts goaly OWNS about a command it started:
 * it fired the timeout, it failed the spawn, it fired the output-cap SIGKILL. Each leaves an
 * ordinary-looking non-zero exit behind, so a producer that drops the flag turns a
 * could-not-evaluate outcome into a bogus code RED (`executionErrorReason` → null), which the
 * verifier scores as an honest failure and the loop can abort on as `STUCK_REPEATED_FAILURE`.
 *
 * The bug this pins: the flag was threaded through `GitWorkspace.run` and `FsScratchCopy.run` but
 * NOT through `FileWorkspace.run` — the second implementation of the same seam, live under
 * `--workspace-mode file` (and under `auto` in a non-git tree). So the test is written over the
 * SEAM (a table of every producer), not over one implementation: a new producer is added to the
 * table and inherits all three checks.
 *
 * Every implementation of the seam, and where it is covered:
 *  - `GitWorkspace.run`     — below (exec-backed).
 *  - `FileWorkspace.run`    — below (exec-backed).
 *  - `FsScratchCopy.run`    — below (exec-backed, via `FsScratchHost`).
 *  - `FakeWorkspace.run`    — below: it is a scripted pass-through, so the requirement is that it
 *                             does not STRIP a scripted flag (it has no exec to learn one from).
 *  - `FakeScratchCopy.run`  — below, same pass-through requirement.
 * `withSandboxVerify` / `withSandboxAgent` (src/sandbox/sandboxed-exec.ts) need nothing: they return
 * the wrapped exec's `ExecResult` object unchanged rather than rebuilding it, so no field can be
 * dropped there.
 */

/** What `runProcess` reports when IT killed the child for blowing the captured-output cap. */
const cappedExec: ExecFn = async () => ({
  stdout: 'a'.repeat(64),
  stderr: '',
  code: 1, // SIGKILL ⇒ no exit code ⇒ runProcess' `code ?? 1` fallback
  outputCapped: true,
});

/** What `realExec` reports when goaly's own wall-clock timeout killed the child. */
const timedOutExec: ExecFn = async () => ({
  stdout: '',
  stderr: '[goaly] command timed out after 10ms',
  code: 124,
  timedOut: true,
});

/** An exec that cannot even start the command (the spawn itself throws). */
const throwingExec: ExecFn = async () => {
  throw new Error('spawn sh ENOENT');
};

type Producer = {
  readonly name: string;
  /** Build a `run()` over the given exec, plus its teardown. */
  readonly make: (exec: ExecFn) => Promise<{
    run: (command: string) => Promise<CommandResult>;
    cleanup: () => Promise<void>;
  }>;
};

const noop = async (): Promise<void> => {};

const producers: readonly Producer[] = [
  {
    name: 'GitWorkspace.run',
    make: async (exec) => {
      const root = await mkdtemp(join(tmpdir(), 'goaly-parity-git-'));
      return {
        run: (c) => new GitWorkspace(root, exec).run(c),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: 'FileWorkspace.run',
    make: async (exec) => {
      const root = await mkdtemp(join(tmpdir(), 'goaly-parity-file-'));
      return {
        run: (c) => new FileWorkspace(root, exec).run(c),
        cleanup: () => rm(root, { recursive: true, force: true }),
      };
    },
  },
  {
    name: 'FsScratchCopy.run',
    make: async (exec) => {
      const source = await mkdtemp(join(tmpdir(), 'goaly-parity-scratch-'));
      const host = new FsScratchHost(source, { exec });
      const copy = await host.create();
      return {
        run: (c) => copy.run(c),
        cleanup: async () => {
          await host.destroy(copy);
          await rm(source, { recursive: true, force: true });
        },
      };
    },
  },
];

describe.each(producers)('CommandResult seam parity — $name', ({ make }) => {
  it('propagates goaly’s own output-cap kill (never a bare red)', async () => {
    const { run, cleanup } = await make(cappedExec);
    try {
      const r = await run('noisy');
      expect(r.outputCapped).toBe(true);
      expect(executionErrorReason(r)).toMatch(/output/i);
    } finally {
      await cleanup();
    }
  });

  it('propagates goaly’s own timeout kill', async () => {
    const { run, cleanup } = await make(timedOutExec);
    try {
      const r = await run('hangs');
      expect(r.timedOut).toBe(true);
      expect(executionErrorReason(r)).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('reports a failed spawn as such instead of rejecting', async () => {
    const { run, cleanup } = await make(throwingExec);
    try {
      const r = await run('never starts');
      expect(r.spawnFailed).toBe(true);
      expect(r.exitCode).not.toBe(0);
      expect(executionErrorReason(r)).not.toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe('the seam FAKES pass the same facts through', () => {
  it('FakeWorkspace.run does not strip a scripted flag', async () => {
    const ws = new FakeWorkspace('0000000', '', [
      { exitCode: 1, stdout: '', stderr: '', outputCapped: true },
      { exitCode: 124, stdout: '', stderr: '', timedOut: true },
      { exitCode: 127, stdout: '', stderr: '', spawnFailed: true },
    ]);
    expect((await ws.run('a')).outputCapped).toBe(true);
    expect((await ws.run('b')).timedOut).toBe(true);
    expect((await ws.run('c')).spawnFailed).toBe(true);
  });

  it('FakeScratchCopy.run does not strip a scripted flag', async () => {
    const host = new FakeScratchHost({
      results: [{ exitCode: 1, stdout: '', stderr: '', outputCapped: true }],
    });
    const copy = await host.create();
    expect((await copy.run('a')).outputCapped).toBe(true);
    await host.destroy(copy);
  });
});
