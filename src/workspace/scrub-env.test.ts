import { describe, it, expect } from 'vitest';
import { isSecretEnvName, scrubEnv } from './scrub-env';

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
