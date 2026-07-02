import { describe, it, expect } from 'vitest';
import { SessionStore, RootBusyError, rootKey, type UiRunSession } from './sessions';
import { UiGates } from './ui-gates';
import { asRunId } from '../domain/ids';
import type { RunResult } from '../cli/run-cmd';
import type { RootRef } from './api-schema';

function session(
  runId: string,
  root: RootRef,
  done: Promise<RunResult> = new Promise(() => {}),
): UiRunSession {
  return {
    runId: asRunId(runId),
    root,
    rootPath: '/ws',
    startedAt: 1,
    gates: new UiGates(),
    stop: () => {},
    stopRequested: () => false,
    done,
  };
}

describe('SessionStore — one live UI-owned run per root', () => {
  it('registers and looks up sessions; refuses a second live run in the SAME root', () => {
    const store = new SessionStore();
    store.register(session('run-a', { kind: 'main' }));
    expect(store.get('run-a')).toBeDefined();
    expect(() => store.register(session('run-b', { kind: 'main' }))).toThrow(RootBusyError);
  });

  it('different roots run concurrently (main + each worktree are separate trees)', () => {
    const store = new SessionStore();
    store.register(session('run-a', { kind: 'main' }));
    store.register(session('run-b', { kind: 'worktree', name: 'feat' }));
    store.register(session('run-c', { kind: 'worktree', name: 'other' }));
    expect(store.all()).toHaveLength(3);
    expect(store.liveInRoot({ kind: 'worktree', name: 'feat' })?.runId).toBe('run-b');
  });

  it('removes the session when its run settles — the root frees up', async () => {
    const store = new SessionStore();
    let settle!: (r: RunResult) => void;
    const done = new Promise<RunResult>((resolve) => {
      settle = resolve;
    });
    store.register(session('run-a', { kind: 'main' }, done));
    settle({ code: 1, runId: asRunId('run-a'), outcome: undefined });
    await done;
    await new Promise((r) => setImmediate(r)); // let the .finally cleanup run
    expect(store.get('run-a')).toBeUndefined();
    expect(() => store.register(session('run-b', { kind: 'main' }))).not.toThrow();
  });

  it('rootKey distinguishes main from each worktree', () => {
    expect(rootKey({ kind: 'main' })).toBe('main');
    expect(rootKey({ kind: 'worktree', name: 'x' })).toBe('worktree:x');
    expect(rootKey({ kind: 'worktree', name: 'y' })).not.toBe(rootKey({ kind: 'worktree', name: 'x' }));
  });
});
