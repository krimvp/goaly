import { describe, it, expect } from 'vitest';
import { FirejailLauncher, FIREJAIL_COMMAND, FIREJAIL_CHDIR_WRAP } from './firejail';
import { DENIED_HOME_SECRETS } from './policy';

const WS = '/home/me/project';
const HOME = '/home/me';

function wrap(network: 'none' | 'allow', workspace = WS) {
  return new FirejailLauncher(HOME).wrap('npm', ['test'], { workspace, network });
}

describe('FirejailLauncher.wrap', () => {
  it('spawns firejail and reports its mode', () => {
    const launcher = new FirejailLauncher(HOME);
    expect(launcher.mode).toBe('firejail');
    expect(launcher.available).toBe(true);
    expect(launcher.identity).toBe(false);
    expect(wrap('allow').command).toBe(FIREJAIL_COMMAND);
  });

  it('runs deterministically and quietly (no host profile, no banner)', () => {
    const { args } = wrap('allow');
    expect(args).toContain('--noprofile');
    expect(args).toContain('--quiet');
    expect(args).toContain('--private-dev');
  });

  it('makes the whole FS read-only and the workspace read-write', () => {
    const { args } = wrap('allow');
    expect(args).toContain('--read-only=/');
    expect(args).toContain(`--read-write=${WS}`);
  });

  it('gives a fresh private /tmp when the workspace is not under /tmp', () => {
    const { args } = wrap('allow');
    expect(args).toContain('--private-tmp');
    expect(args).not.toContain('--read-write=/tmp');
  });

  it('keeps the real /tmp writable (not --private-tmp) when the workspace lives under /tmp', () => {
    // A private tmpfs would shadow a workspace under /tmp and firejail can't re-expose it (it applies
    // fs ops in its own order, unlike bwrap's "bind last"). Keep the real /tmp writable instead.
    const { args } = new FirejailLauncher(HOME).wrap('sh', ['-c', 'true'], {
      workspace: '/tmp/work-xyz',
      network: 'none',
    });
    expect(args).toContain('--read-write=/tmp');
    expect(args).not.toContain('--private-tmp');
    expect(args).toContain('--read-write=/tmp/work-xyz');
  });

  it('denies every $HOME credential dir with --blacklist (never re-enables it rw)', () => {
    const { args } = wrap('allow');
    for (const secret of DENIED_HOME_SECRETS) {
      expect(args).toContain(`--blacklist=${HOME}/${secret}`);
      // The secret path is never the target of a --read-write (which would expose it).
      expect(args).not.toContain(`--read-write=${HOME}/${secret}`);
    }
  });

  it('cuts the network with --net=none only when network is none', () => {
    expect(wrap('none').args).toContain('--net=none');
    expect(wrap('allow').args).not.toContain('--net=none');
  });

  it('routes an allowlist through the egress proxy via --env, keeping the network up (issue #39)', () => {
    const { args } = new FirejailLauncher(HOME).wrap('npm', ['test'], {
      workspace: WS,
      network: { allowlist: ['*.npmjs.org'] },
      proxy: { port: 8123 },
    });
    // Network stays up (no --net=none) so the jail can reach the host-loopback proxy.
    expect(args).not.toContain('--net=none');
    expect(args).toContain('--env=HTTPS_PROXY=http://127.0.0.1:8123');
    expect(args).toContain('--env=https_proxy=http://127.0.0.1:8123');
    expect(args).toContain('--env=ALL_PROXY=http://127.0.0.1:8123');
    expect(args).toContain('--env=NO_PROXY=localhost,127.0.0.1');
  });

  it('fails closed when an allowlist is requested without a running proxy (issue #39)', () => {
    expect(() =>
      new FirejailLauncher(HOME).wrap('npm', ['test'], {
        workspace: WS,
        network: { allowlist: ['x.com'] },
      }),
    ).toThrow(/no egress-proxy/);
  });

  it('ends by running the command under a cd-into-workspace shell, in order', () => {
    const { args } = wrap('none');
    const sh = args.indexOf('sh');
    expect(sh).toBeGreaterThan(0);
    expect(args.slice(sh)).toEqual(['sh', '-c', FIREJAIL_CHDIR_WRAP, WS, 'npm', 'test']);
  });

  it('omits home blacklisting when $HOME is empty/unset, but still jails the rest', () => {
    const { args } = new FirejailLauncher('').wrap('sh', ['-c', 'true'], {
      workspace: WS,
      network: 'none',
    });
    expect(args).toContain('--read-only=/');
    expect(args).toContain('--net=none');
    expect(args.some((a) => a.startsWith('--blacklist='))).toBe(false);
    const sh = args.indexOf('sh');
    expect(args.slice(sh)).toEqual(['sh', '-c', FIREJAIL_CHDIR_WRAP, WS, 'sh', '-c', 'true']);
  });
});
