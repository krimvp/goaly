import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { installInterruptHandlers, makeCrashHandler, tolerateClosedConsole } from './crash-guard';

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

describe('installInterruptHandlers', () => {
  it('routes SIGHUP (the terminal went away) to the same cooperative stop as SIGINT/SIGTERM', () => {
    const proc = new EventEmitter();
    const seen: string[] = [];
    const uninstall = installInterruptHandlers(() => seen.push('stop'), proc);

    proc.emit('SIGHUP');
    proc.emit('SIGINT');
    proc.emit('SIGTERM');
    expect(seen).toEqual(['stop', 'stop', 'stop']);

    uninstall();
    expect(proc.listenerCount('SIGHUP')).toBe(0);
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
  });
});

describe('tolerateClosedConsole', () => {
  const streamError = (code: string): Error => Object.assign(new Error(code), { code });

  it('a closed stdout/stderr (EPIPE, EIO) no longer becomes a fatal uncaught error', () => {
    const stream = new EventEmitter();
    expect(() => stream.emit('error', streamError('EPIPE'))).toThrow();

    tolerateClosedConsole([stream]);

    expect(() => stream.emit('error', streamError('EPIPE'))).not.toThrow();
    expect(() => stream.emit('error', streamError('EIO'))).not.toThrow();
    expect(() => stream.emit('error', streamError('ERR_STREAM_DESTROYED'))).not.toThrow();
  });

  it('any other stream error stays fatal', () => {
    const stream = new EventEmitter();
    tolerateClosedConsole([stream]);
    expect(() => stream.emit('error', streamError('ENOSPC'))).toThrow('ENOSPC');
  });
});
