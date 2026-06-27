import { describe, it, expect } from 'vitest';
import {
  SandboxPolicy,
  networkForSeam,
  isAllowlist,
  proxyUrlFor,
  proxyEnv,
  resolveProfile,
  PROXY_ENV_VARS,
  PROXY_NO_PROXY,
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
    for (const mode of ['none', 'auto', 'bwrap', 'firejail', 'container'] as const) {
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

  it('accepts the firejail mode (issue #40)', () => {
    expect(SandboxPolicy.parse({ mode: 'firejail' }).mode).toBe('firejail');
  });

  it('rejects an unknown mode (fail-closed)', () => {
    expect(SandboxPolicy.safeParse({ mode: 'jail' }).success).toBe(false);
    expect(SandboxPolicy.safeParse({ mode: 'garbage' }).success).toBe(false);
  });

  it('rejects an unknown network value and an unknown runtime', () => {
    expect(SandboxPolicy.safeParse({ network: 'partial' }).success).toBe(false);
    expect(SandboxPolicy.safeParse({ runtime: 'lxc' }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(SandboxPolicy.safeParse({ mode: 'none', extra: 1 }).success).toBe(false);
  });

  it('accepts an egress allowlist network (issue #39)', () => {
    const p = SandboxPolicy.parse({
      mode: 'bwrap',
      network: { allowlist: ['api.anthropic.com', '*.npmjs.org', 'host:443'] },
    });
    expect(p.network).toEqual({ allowlist: ['api.anthropic.com', '*.npmjs.org', 'host:443'] });
  });

  it('rejects an empty allowlist and malformed hosts (fail-closed)', () => {
    expect(SandboxPolicy.safeParse({ network: { allowlist: [] } }).success).toBe(false);
    expect(SandboxPolicy.safeParse({ network: { allowlist: ['has space'] } }).success).toBe(false);
    expect(SandboxPolicy.safeParse({ network: { allowlist: ['http://x.com'] } }).success).toBe(false);
    // An unknown key inside the allowlist object is rejected (strict).
    expect(
      SandboxPolicy.safeParse({ network: { allowlist: ['x.com'], extra: 1 } }).success,
    ).toBe(false);
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

  it('applies an allowlist to BOTH seams — the harness is NOT upgraded to full allow (issue #39)', () => {
    const policy = SandboxPolicy.parse({ network: { allowlist: ['api.anthropic.com'] } });
    expect(networkForSeam(policy, 'harness')).toEqual({ allowlist: ['api.anthropic.com'] });
    expect(networkForSeam(policy, 'verifier')).toEqual({ allowlist: ['api.anthropic.com'] });
  });
});

describe('isAllowlist / proxyUrlFor (issue #39)', () => {
  it('narrows only the allowlist object, not the none/allow literals', () => {
    expect(isAllowlist('none')).toBe(false);
    expect(isAllowlist('allow')).toBe(false);
    expect(isAllowlist({ allowlist: ['x.com'] })).toBe(true);
  });

  it('builds the in-jail proxy url from the host + port', () => {
    expect(proxyUrlFor('127.0.0.1', { port: 8123 })).toBe('http://127.0.0.1:8123');
    expect(proxyUrlFor('goaly-host-gateway', { port: 9000 })).toBe('http://goaly-host-gateway:9000');
  });

  it('fails closed when an allowlist is requested with no running proxy', () => {
    expect(() => proxyUrlFor('127.0.0.1', undefined)).toThrow(/no egress-proxy/);
  });

  it('exposes both upper- and lower-case proxy env var names', () => {
    expect(PROXY_ENV_VARS).toContain('HTTPS_PROXY');
    expect(PROXY_ENV_VARS).toContain('https_proxy');
  });
});

describe('resolveProfile (issue #9)', () => {
  it('maps the per-seam egress onto the tri-state: none → isolated, allow → open, allowlist → proxied', () => {
    expect(resolveProfile('none', { workspace: '/ws' }).network).toBe('isolated');
    expect(resolveProfile('allow', { workspace: '/ws' }).network).toBe('open');
    expect(resolveProfile({ allowlist: ['x.com'] }, { workspace: '/ws' }).network).toBe('proxied');
  });

  it('keeps the workspace as given', () => {
    expect(resolveProfile('none', { workspace: '/ws' }).workspace).toBe('/ws');
  });

  it('resolves the credential deny-dirs from an injected $HOME', () => {
    const p = resolveProfile('none', { workspace: '/ws', home: '/home/me' });
    expect(p.denyDirs).toEqual(DENIED_HOME_SECRETS.map((s) => `/home/me/${s}`));
  });

  it('yields no deny-dirs when the injected home is empty (nothing to mask)', () => {
    expect(resolveProfile('none', { workspace: '/ws', home: '' }).denyDirs).toEqual([]);
  });

  it('yields no deny-dirs when neither an injected home nor $HOME is set', () => {
    const saved = process.env.HOME;
    try {
      delete process.env.HOME;
      expect(resolveProfile('none', { workspace: '/ws' }).denyDirs).toEqual([]);
    } finally {
      if (saved !== undefined) process.env.HOME = saved;
    }
  });

  it('carries env and proxy through when provided', () => {
    const p = resolveProfile(
      { allowlist: ['x.com'] },
      { workspace: '/ws', env: { CI: 'true' }, proxy: { port: 8123 } },
    );
    expect(p.env).toEqual({ CI: 'true' });
    expect(p.proxy).toEqual({ port: 8123 });
  });

  it('omits env and proxy when not provided', () => {
    const p = resolveProfile('none', { workspace: '/ws' });
    expect(p.env).toBeUndefined();
    expect(p.proxy).toBeUndefined();
  });
});

describe('proxyEnv (issue #39)', () => {
  it('emits every proxy env var (both cases) at the in-jail url, plus NO_PROXY/no_proxy', () => {
    const pairs: Array<[string, string]> = [];
    proxyEnv((n, v) => pairs.push([n, v]), '127.0.0.1', { port: 9 });
    const url = 'http://127.0.0.1:9';
    for (const name of PROXY_ENV_VARS) {
      expect(pairs).toContainEqual([name, url]);
    }
    expect(pairs).toContainEqual(['NO_PROXY', PROXY_NO_PROXY]);
    expect(pairs).toContainEqual(['no_proxy', PROXY_NO_PROXY]);
  });

  it('fails closed when no proxy is provided (never silently unrestricted egress)', () => {
    expect(() => proxyEnv(() => {}, '127.0.0.1', undefined)).toThrow(/no egress-proxy/);
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
