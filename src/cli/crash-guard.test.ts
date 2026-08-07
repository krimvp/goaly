import { describe, it, expect } from 'vitest';
import { installCrashGuard } from './crash-guard';

const makeDeps = () => {
  const written: string[] = [];
  const calls = { killed: 0, exited: -1 };
  const deps = {
    err: (s: string) => {
      written.push(s);
    },
    killChildren: () => {
      calls.killed += 1;
    },
    exit: (code: number) => {
      calls.exited = code;
    },
  };
  return { written, calls, deps };
};

describe('installCrashGuard', () => {
  it('converts an uncaught exception into a loud diagnostic, a child sweep, and exit 1', () => {
    const { written, calls, deps } = makeDeps();
    const uninstall = installCrashGuard(deps);
    try {
      process.emit('uncaughtException', new Error('boom'));
    } finally {
      uninstall();
    }
    expect(calls.killed).toBe(1);
    expect(calls.exited).toBe(1);
    const out = written.join('');
    expect(out).toContain('uncaught exception');
    expect(out).toContain('boom');
    expect(out).toContain('--resume');
  });

  it('converts an unhandled rejection the same way, naming the rejection cause', () => {
    const { written, calls, deps } = makeDeps();
    const uninstall = installCrashGuard(deps);
    try {
      process.emit('unhandledRejection', 'string-cause', Promise.resolve());
    } finally {
      uninstall();
    }
    expect(calls.killed).toBe(1);
    expect(calls.exited).toBe(1);
    expect(written.join('')).toContain('unhandled rejection');
    expect(written.join('')).toContain('string-cause');
  });

  it('short-circuits a re-entrant trigger (cleanup path must not loop)', () => {
    const { calls, deps } = makeDeps();
    const uninstall = installCrashGuard(deps);
    try {
      process.emit('uncaughtException', new Error('first'));
      process.emit('uncaughtException', new Error('second'));
    } finally {
      uninstall();
    }
    expect(calls.killed).toBe(1);
    expect(calls.exited).toBe(1);
  });

  it('still exits when the child sweep itself throws', () => {
    const { calls, deps } = makeDeps();
    deps.killChildren = () => {
      calls.killed += 1;
      throw new Error('sweep failed');
    };
    const uninstall = installCrashGuard(deps);
    try {
      process.emit('uncaughtException', new Error('boom'));
    } finally {
      uninstall();
    }
    expect(calls.killed).toBe(1);
    expect(calls.exited).toBe(1);
  });

  it('uninstalls its listeners (no leak across repeated installs)', () => {
    const before = process.listenerCount('uncaughtException');
    const uninstall = installCrashGuard(makeDeps().deps);
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);
    uninstall();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });
});
