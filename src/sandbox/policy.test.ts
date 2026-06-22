import { describe, it, expect } from 'vitest';
import {
  SandboxPolicy,
  networkForSeam,
  DENIED_HOME_SECRETS,
  DEFAULT_CONTAINER_IMAGE,
  DEFAULT_CONTAINER_RUNTIME,
} from './policy';

describe('SandboxPolicy schema', () => {
  it('defaults to the off (none) policy with no network', () => {
    const p = SandboxPolicy.parse({});
    expect(p.mode).toBe('none');
    expect(p.network).toBe('none');
    expect(p.image).toBeUndefined();
    expect(p.runtime).toBeUndefined();
  });

  it('accepts every valid mode', () => {
    for (const mode of ['none', 'auto', 'bwrap', 'container'] as const) {
      expect(SandboxPolicy.parse({ mode }).mode).toBe(mode);
    }
  });

  it('accepts the network toggle and container knobs', () => {
    const p = SandboxPolicy.parse({
      mode: 'container',
      network: 'allow',
      image: 'node:20',
      runtime: 'podman',
    });
    expect(p).toEqual({ mode: 'container', network: 'allow', image: 'node:20', runtime: 'podman' });
  });

  it('rejects an unknown mode (fail-closed)', () => {
    expect(SandboxPolicy.safeParse({ mode: 'firejail' }).success).toBe(false);
    expect(SandboxPolicy.safeParse({ mode: 'garbage' }).success).toBe(false);
  });

  it('rejects an unknown network value and an unknown runtime', () => {
    expect(SandboxPolicy.safeParse({ network: 'partial' }).success).toBe(false);
    expect(SandboxPolicy.safeParse({ runtime: 'lxc' }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(SandboxPolicy.safeParse({ mode: 'none', extra: 1 }).success).toBe(false);
  });
});

describe('networkForSeam', () => {
  it('always allows egress for the harness regardless of policy', () => {
    expect(networkForSeam(SandboxPolicy.parse({ network: 'none' }), 'harness')).toBe('allow');
    expect(networkForSeam(SandboxPolicy.parse({ network: 'allow' }), 'harness')).toBe('allow');
  });

  it('honours the policy for the verifier (default none)', () => {
    expect(networkForSeam(SandboxPolicy.parse({}), 'verifier')).toBe('none');
    expect(networkForSeam(SandboxPolicy.parse({ network: 'allow' }), 'verifier')).toBe('allow');
  });
});

describe('constants', () => {
  it('lists the $HOME credential dirs that must never be bound', () => {
    expect(DENIED_HOME_SECRETS).toContain('.ssh');
    expect(DENIED_HOME_SECRETS).toContain('.aws');
  });

  it('has sane container defaults', () => {
    expect(DEFAULT_CONTAINER_IMAGE.length).toBeGreaterThan(0);
    expect(DEFAULT_CONTAINER_RUNTIME).toBe('docker');
  });
});
