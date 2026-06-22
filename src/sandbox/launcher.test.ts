import { describe, it, expect } from 'vitest';
import {
  NoneLauncher,
  UnavailableLauncher,
  SandboxUnavailableError,
} from './launcher';

describe('NoneLauncher', () => {
  it('is a perfect identity passthrough', () => {
    const l = new NoneLauncher();
    expect(l.mode).toBe('none');
    expect(l.available).toBe(true);
    const out = l.wrap('npm', ['run', 'test']);
    expect(out).toEqual({ command: 'npm', args: ['run', 'test'] });
  });

  it('is the ONLY identity launcher (the sole fail-open passthrough path)', () => {
    expect(new NoneLauncher().identity).toBe(true);
  });
});

describe('UnavailableLauncher', () => {
  it('is not available and carries the reason', () => {
    const l = new UnavailableLauncher('bwrap missing');
    expect(l.available).toBe(false);
    expect(l.unavailableReason).toBe('bwrap missing');
  });

  it('is NOT identity, so the exec wrappers invoke its throwing wrap() (fail-closed)', () => {
    expect(new UnavailableLauncher('bwrap missing').identity).toBe(false);
  });

  it('throws if anything tries to wrap with it (never an unsandboxed run)', () => {
    const l = new UnavailableLauncher('bwrap missing');
    expect(() => l.wrap()).toThrow(SandboxUnavailableError);
  });
});
