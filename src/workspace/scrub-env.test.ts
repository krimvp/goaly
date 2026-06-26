import { describe, it, expect } from 'vitest';
import { isSecretEnvName, scrubEnv, augmentToolPath } from './scrub-env';

describe('isSecretEnvName', () => {
  it('flags credential-looking names', () => {
    for (const name of [
      'AWS_SECRET_ACCESS_KEY',
      'GITHUB_TOKEN',
      'npm_token',
      'MY_API_KEY',
      'DB_PASSWORD',
      'SESSION_SECRET',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'SOME_AUTH_HEADER',
    ]) {
      expect(isSecretEnvName(name)).toBe(true);
    }
  });

  it('leaves ordinary build/runtime vars alone', () => {
    for (const name of ['PATH', 'HOME', 'LANG', 'CI', 'NODE_ENV', 'TMPDIR', 'PWD', 'SHELL']) {
      expect(isSecretEnvName(name)).toBe(false);
    }
  });
});

describe('scrubEnv', () => {
  it('drops secrets but keeps the toolchain environment, without mutating the input', () => {
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/me',
      AWS_SECRET_ACCESS_KEY: 'shhh',
      GITHUB_TOKEN: 'ghp_xxx',
      NODE_ENV: 'test',
      MISSING: undefined,
    };
    const out = scrubEnv(env);

    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/me');
    expect(out.NODE_ENV).toBe('test');
    expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
    expect('MISSING' in out).toBe(false);
    // input untouched
    expect(env.AWS_SECRET_ACCESS_KEY).toBe('shhh');
  });
});

describe('augmentToolPath', () => {
  it('appends the standard per-user tool bin dirs so an agent-installed toolchain is discoverable', () => {
    const out = augmentToolPath({ HOME: '/home/me', PATH: '/usr/bin' });
    const dirs = (out.PATH ?? '').split(':');
    expect(dirs[0]).toBe('/usr/bin'); // existing PATH stays highest priority
    expect(dirs).toContain('/home/me/.cargo/bin'); // rustup
    expect(dirs).toContain('/home/me/.local/bin'); // pip/pipx --user
    expect(dirs).toContain('/home/me/go/bin'); // go
  });

  it('appends (never prepends) so a system binary of the same name still wins', () => {
    const out = augmentToolPath({ HOME: '/home/me', PATH: '/usr/bin:/bin' });
    const dirs = (out.PATH ?? '').split(':');
    expect(dirs.indexOf('/usr/bin')).toBeLessThan(dirs.indexOf('/home/me/.cargo/bin'));
  });

  it('does not duplicate a dir already on PATH', () => {
    const out = augmentToolPath({ HOME: '/home/me', PATH: '/home/me/.cargo/bin:/usr/bin' });
    const dirs = (out.PATH ?? '').split(':');
    expect(dirs.filter((d) => d === '/home/me/.cargo/bin')).toHaveLength(1);
  });

  it('is a no-op (just a copy) when HOME is unset', () => {
    const env = { PATH: '/usr/bin' };
    const out = augmentToolPath(env);
    expect(out.PATH).toBe('/usr/bin');
    expect(out).not.toBe(env); // a copy, never the same reference
  });

  it('never mutates the input', () => {
    const env = { HOME: '/home/me', PATH: '/usr/bin' };
    augmentToolPath(env);
    expect(env.PATH).toBe('/usr/bin');
  });
});
