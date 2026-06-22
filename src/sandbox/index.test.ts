import { describe, it, expect } from 'vitest';
import { makeLauncher, neutralAgentExec } from './index';
import { SandboxPolicy } from './policy';
import type { WhichProbe } from './detect';

const probe =
  (...present: string[]): WhichProbe =>
  (binary) =>
    present.includes(binary);

describe('makeLauncher', () => {
  it('none → an identity NoneLauncher (no host probe)', () => {
    const l = makeLauncher(SandboxPolicy.parse({ mode: 'none' }));
    expect(l.mode).toBe('none');
    expect(l.available).toBe(true);
    expect(l.wrap('x', ['y'], { workspace: '/w', network: 'allow' })).toEqual({
      command: 'x',
      args: ['y'],
    });
  });

  it('bwrap present → a BwrapLauncher', () => {
    const l = makeLauncher(SandboxPolicy.parse({ mode: 'bwrap' }), {
      which: probe('bwrap'),
      platform: 'linux',
      home: '/home/me',
    });
    expect(l.mode).toBe('bwrap');
    expect(l.available).toBe(true);
  });

  it('container present → a ContainerLauncher honouring image/runtime', () => {
    const l = makeLauncher(SandboxPolicy.parse({ mode: 'container', runtime: 'podman', image: 'n:1' }), {
      which: probe('podman'),
    });
    expect(l.mode).toBe('container');
    const out = l.wrap('npm', ['test'], { workspace: '/w', network: 'allow' });
    expect(out.command).toBe('podman');
    expect(out.args).toContain('n:1');
  });

  it('requested but absent → an UnavailableLauncher that makes the run refuse to start', () => {
    const l = makeLauncher(SandboxPolicy.parse({ mode: 'bwrap' }), {
      which: probe(),
      platform: 'linux',
    });
    expect(l.available).toBe(false);
    expect(l.unavailableReason).toContain('bwrap');
  });

  it('auto with nothing present → unavailable (fail-closed)', () => {
    const l = makeLauncher(SandboxPolicy.parse({ mode: 'auto' }), {
      which: probe(),
      platform: 'linux',
    });
    expect(l.available).toBe(false);
  });
});

describe('neutralAgentExec', () => {
  it('refuses an empty argv (fail-closed, never spawns)', async () => {
    const exec = neutralAgentExec(1000, false);
    const r = await exec([], { prompt: '' });
    expect(r.code).toBe(127);
    expect(r.stderr).toContain('empty command');
  });
});
