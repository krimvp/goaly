import { describe, it, expect } from 'vitest';
import { BwrapLauncher, BWRAP_COMMAND } from './bwrap';
import { DENIED_HOME_SECRETS } from './policy';

const WS = '/home/me/project';
const HOME = '/home/me';

function wrap(network: 'none' | 'allow') {
  return new BwrapLauncher().wrap('npm', ['test'], {
    workspace: WS,
    denyDirs: DENIED_HOME_SECRETS.map((s) => `${HOME}/${s}`),
    network: network === 'none' ? 'isolated' : 'open',
  });
}

describe('BwrapLauncher.wrap', () => {
  it('spawns bwrap and reports its mode', () => {
    const launcher = new BwrapLauncher();
    expect(launcher.mode).toBe('bwrap');
    expect(launcher.available).toBe(true);
    expect(wrap('allow').command).toBe(BWRAP_COMMAND);
  });

  it('binds / read-only and the workspace read-write, and chdirs into the workspace', () => {
    const { args } = wrap('allow');
    const joined = args.join(' ');
    expect(joined).toContain('--ro-bind / /');
    expect(joined).toContain(`--bind ${WS} ${WS}`);
    expect(joined).toContain('--dev /dev');
    expect(joined).toContain('--proc /proc');
    expect(joined).toContain('--tmpfs /tmp');
    expect(joined).toContain(`--chdir ${WS}`);
  });

  it('binds the rw workspace AFTER --tmpfs /tmp so a workspace under /tmp is not shadowed', () => {
    // Regression: bubblewrap applies mounts in order; a `--tmpfs /tmp` placed after the workspace
    // bind would hide a workspace that lives under /tmp, breaking --chdir. The rw bind must come last.
    const { args } = new BwrapLauncher().wrap('sh', ['-c', 'true'], {
      workspace: '/tmp/work-xyz',
      denyDirs: [],
      network: 'isolated',
    });
    const tmpfsTmp = args.indexOf('/tmp'); // the `--tmpfs /tmp` target
    const wsBind = args.lastIndexOf('/tmp/work-xyz');
    expect(tmpfsTmp).toBeGreaterThan(0);
    expect(args[tmpfsTmp - 1]).toBe('--tmpfs');
    // The workspace bind (its first occurrence is the --bind target) comes after the /tmp tmpfs.
    const wsBindStart = args.indexOf('/tmp/work-xyz');
    expect(args[wsBindStart - 1]).toBe('--bind');
    expect(wsBindStart).toBeGreaterThan(tmpfsTmp);
    expect(wsBind).toBeGreaterThan(wsBindStart); // also the --chdir target, even later
  });

  it('masks every $HOME credential dir with a tmpfs (NOT bound)', () => {
    const { args } = wrap('allow');
    for (const secret of DENIED_HOME_SECRETS) {
      const i = args.indexOf(`${HOME}/${secret}`);
      expect(i).toBeGreaterThan(0);
      expect(args[i - 1]).toBe('--tmpfs');
    }
    // The $HOME secret paths are never the target of a --bind (which would expose them rw).
    for (const secret of DENIED_HOME_SECRETS) {
      const i = args.indexOf(`${HOME}/${secret}`);
      expect(args[i - 1]).not.toBe('--bind');
    }
  });

  it('cuts the network with --unshare-net only when network is none', () => {
    expect(wrap('none').args).toContain('--unshare-net');
    expect(wrap('allow').args).not.toContain('--unshare-net');
  });

  it('routes an allowlist through the egress proxy via --setenv, keeping the network up (issue #39)', () => {
    const { args } = new BwrapLauncher().wrap('npm', ['test'], {
      workspace: WS,
      denyDirs: [],
      network: 'proxied',
      proxy: { port: 8123 },
    });
    // Network stays up (no --unshare-net) so the jail can reach the host-loopback proxy.
    expect(args).not.toContain('--unshare-net');
    const joined = args.join(' ');
    expect(joined).toContain('--setenv HTTPS_PROXY http://127.0.0.1:8123');
    expect(joined).toContain('--setenv https_proxy http://127.0.0.1:8123');
    expect(joined).toContain('--setenv ALL_PROXY http://127.0.0.1:8123');
    expect(joined).toContain('--setenv NO_PROXY localhost,127.0.0.1');
    // The original command still runs last, unchanged.
    expect(args.slice(args.indexOf('--'))).toEqual(['--', 'npm', 'test']);
  });

  it('fails closed when an allowlist is requested without a running proxy (issue #39)', () => {
    expect(() =>
      new BwrapLauncher().wrap('npm', ['test'], {
        workspace: WS,
        denyDirs: [],
        network: 'proxied',
      }),
    ).toThrow(/no egress-proxy/);
  });

  it('ends with the -- separator then the original command and args, in order', () => {
    const { args } = wrap('none');
    const sep = args.indexOf('--');
    expect(sep).toBeGreaterThan(0);
    expect(args.slice(sep)).toEqual(['--', 'npm', 'test']);
  });

  it('omits home masking when there are no deny dirs, but still jails the rest', () => {
    const { args } = new BwrapLauncher().wrap('sh', ['-c', 'true'], {
      workspace: WS,
      denyDirs: [],
      network: 'isolated',
    });
    expect(args.join(' ')).toContain('--ro-bind / /');
    expect(args.join(' ')).toContain('--unshare-net');
    expect(args.slice(args.indexOf('--'))).toEqual(['--', 'sh', '-c', 'true']);
  });
});
