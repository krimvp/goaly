import { describe, it, expect } from 'vitest';
import { makeCrashHandler } from './crash-guard';

describe('makeCrashHandler', () => {
  it('reaps children, writes the error, and exits 1', () => {
    const calls: string[] = [];
    let exitCode: number | undefined;
    const handler = makeCrashHandler({
      reap: () => calls.push('reap'),
      write: (s) => calls.push(`write:${s}`),
      exit: (code) => {
        exitCode = code;
        calls.push('exit');
      },
    });

    handler(new Error('boom'));

    expect(calls[0]).toBe('reap');
    expect(calls[1]).toContain('goaly: fatal:');
    expect(calls[1]).toContain('boom');
    expect(calls[2]).toBe('exit');
    expect(exitCode).toBe(1);
  });

  it('stringifies a non-Error value', () => {
    let written = '';
    const handler = makeCrashHandler({
      reap: () => {},
      write: (s) => (written = s),
      exit: () => {},
    });

    handler('plain failure');

    expect(written).toBe('goaly: fatal: plain failure\n');
  });

  it('still exits when the reap and the write both throw (a dead stderr must not stop the exit)', () => {
    let exited = false;
    const handler = makeCrashHandler({
      reap: () => {
        throw new Error('reap failed');
      },
      write: () => {
        throw new Error('stderr gone');
      },
      exit: () => {
        exited = true;
      },
    });

    handler(new Error('boom'));

    expect(exited).toBe(true);
  });
});
