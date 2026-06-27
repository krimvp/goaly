import { describe, it, expect } from 'vitest';
import { ContainerLauncher, CONTAINER_HOST_GATEWAY } from './container';
import { DEFAULT_CONTAINER_IMAGE, DENIED_HOME_SECRETS } from './policy';

const WS = '/work/repo';

describe('ContainerLauncher.wrap', () => {
  it('rewrites into a `docker run --rm` with the workspace mirrored rw and as cwd', () => {
    const { command, args } = new ContainerLauncher().wrap('npm', ['test'], {
      workspace: WS,
      denyDirs: [],
      network: 'open',
    });
    expect(command).toBe('docker');
    const joined = args.join(' ');
    expect(joined).toContain('run --rm');
    expect(joined).toContain(`-v ${WS}:${WS}`); // mirrored path
    expect(joined).toContain(`-w ${WS}`);
    expect(args.slice(-3)).toEqual([DEFAULT_CONTAINER_IMAGE, 'npm', 'test']);
  });

  it('honours the runtime and image from policy', () => {
    const { command, args } = new ContainerLauncher({ runtime: 'podman', image: 'node:20' }).wrap(
      'sh',
      ['-c', 'true'],
      { workspace: WS, denyDirs: [], network: 'open' },
    );
    expect(command).toBe('podman');
    expect(args).toContain('node:20');
    expect(args.slice(-4)).toEqual(['node:20', 'sh', '-c', 'true']);
  });

  it('cuts egress with --network none only when network is none', () => {
    const off = new ContainerLauncher().wrap('x', [], { workspace: WS, denyDirs: [], network: 'isolated' });
    const on = new ContainerLauncher().wrap('x', [], { workspace: WS, denyDirs: [], network: 'open' });
    expect(off.args.join(' ')).toContain('--network none');
    expect(on.args.join(' ')).not.toContain('--network none');
  });

  it('routes an allowlist through the egress proxy via a host-gateway alias + -e (issue #39)', () => {
    const { args } = new ContainerLauncher().wrap('npm', ['test'], {
      workspace: WS,
      denyDirs: [],
      network: 'proxied',
      proxy: { port: 8123 },
    });
    const joined = args.join(' ');
    // The bridge network stays up (no --network none) and the host is reachable via the alias.
    expect(joined).not.toContain('--network none');
    expect(joined).toContain(`--add-host ${CONTAINER_HOST_GATEWAY}:host-gateway`);
    expect(args).toContain(`HTTPS_PROXY=http://${CONTAINER_HOST_GATEWAY}:8123`);
    expect(args).toContain(`all_proxy=http://${CONTAINER_HOST_GATEWAY}:8123`);
    expect(args).toContain('NO_PROXY=localhost,127.0.0.1');
    // The image + original command still run last.
    expect(args.slice(-3)).toEqual([DEFAULT_CONTAINER_IMAGE, 'npm', 'test']);
  });

  it('fails closed when an allowlist is requested without a running proxy (issue #39)', () => {
    expect(() =>
      new ContainerLauncher().wrap('x', [], {
        workspace: WS,
        denyDirs: [],
        network: 'proxied',
      }),
    ).toThrow(/no egress-proxy/);
  });

  it('passes env NAMEs through with -e (never the secret values in argv)', () => {
    const { args } = new ContainerLauncher().wrap('x', [], {
      workspace: WS,
      denyDirs: [],
      network: 'isolated',
      env: { PATH: '/usr/bin', CI: 'true', MISSING: undefined },
    });
    expect(args).toContain('-e');
    expect(args).toContain('PATH');
    expect(args).toContain('CI');
    expect(args).not.toContain('/usr/bin'); // value never embedded
    expect(args).not.toContain('MISSING'); // undefined env vars skipped
  });

  it('never bind-mounts the host $HOME or credential dirs (denyDirs are moot for containers)', () => {
    // The container never mounts $HOME, so it simply ignores the profile's denyDirs — even when they
    // are supplied, the argv must never reference the host credential paths.
    const { args } = new ContainerLauncher().wrap('x', [], {
      workspace: WS,
      denyDirs: DENIED_HOME_SECRETS.map((s) => `/home/me/${s}`),
      network: 'isolated',
    });
    const joined = args.join(' ');
    expect(joined).not.toContain('/home');
    expect(joined).not.toContain('.ssh');
    expect(joined).not.toContain('.aws');
  });
});
