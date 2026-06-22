import { describe, it, expect } from 'vitest';
import { ContainerLauncher } from './container';
import { DEFAULT_CONTAINER_IMAGE } from './policy';

const WS = '/work/repo';

describe('ContainerLauncher.wrap', () => {
  it('rewrites into a `docker run --rm` with the workspace mirrored rw and as cwd', () => {
    const { command, args } = new ContainerLauncher().wrap('npm', ['test'], {
      workspace: WS,
      network: 'allow',
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
      { workspace: WS, network: 'allow' },
    );
    expect(command).toBe('podman');
    expect(args).toContain('node:20');
    expect(args.slice(-4)).toEqual(['node:20', 'sh', '-c', 'true']);
  });

  it('cuts egress with --network none only when network is none', () => {
    const off = new ContainerLauncher().wrap('x', [], { workspace: WS, network: 'none' });
    const on = new ContainerLauncher().wrap('x', [], { workspace: WS, network: 'allow' });
    expect(off.args.join(' ')).toContain('--network none');
    expect(on.args.join(' ')).not.toContain('--network none');
  });

  it('passes env NAMEs through with -e (never the secret values in argv)', () => {
    const { args } = new ContainerLauncher().wrap('x', [], {
      workspace: WS,
      network: 'none',
      env: { PATH: '/usr/bin', CI: 'true', MISSING: undefined },
    });
    expect(args).toContain('-e');
    expect(args).toContain('PATH');
    expect(args).toContain('CI');
    expect(args).not.toContain('/usr/bin'); // value never embedded
    expect(args).not.toContain('MISSING'); // undefined env vars skipped
  });

  it('never bind-mounts the host $HOME or credential dirs', () => {
    const { args } = new ContainerLauncher().wrap('x', [], { workspace: WS, network: 'none' });
    const joined = args.join(' ');
    expect(joined).not.toContain('/home');
    expect(joined).not.toContain('.ssh');
    expect(joined).not.toContain('.aws');
  });
});
