import { describe, it, expect } from 'vitest';
import { detectMechanism, type WhichProbe } from './detect';

/** A fake `which` that answers true only for the named binaries. */
const probe =
  (...present: string[]): WhichProbe =>
  (binary) =>
    present.includes(binary);

describe('detectMechanism', () => {
  it('bwrap present → bwrap', () => {
    expect(detectMechanism('bwrap', { which: probe('bwrap') })).toEqual({ kind: 'bwrap' });
  });

  it('bwrap absent → unavailable (fail-closed)', () => {
    const r = detectMechanism('bwrap', { which: probe() });
    expect(r.kind).toBe('unavailable');
  });

  it('container present → container with the discovered runtime', () => {
    expect(detectMechanism('container', { which: probe('docker') })).toEqual({
      kind: 'container',
      runtime: 'docker',
    });
    expect(detectMechanism('container', { which: probe('podman') })).toEqual({
      kind: 'container',
      runtime: 'podman',
    });
  });

  it('container prefers the policy-preferred runtime when both are present', () => {
    expect(
      detectMechanism('container', { which: probe('docker', 'podman'), preferredRuntime: 'podman' }),
    ).toEqual({ kind: 'container', runtime: 'podman' });
  });

  it('container absent → unavailable (fail-closed)', () => {
    expect(detectMechanism('container', { which: probe() }).kind).toBe('unavailable');
  });

  it('auto on Linux prefers bwrap', () => {
    expect(
      detectMechanism('auto', { which: probe('bwrap', 'docker'), platform: 'linux' }),
    ).toEqual({ kind: 'bwrap' });
  });

  it('auto on Linux without bwrap falls back to a container runtime', () => {
    expect(detectMechanism('auto', { which: probe('podman'), platform: 'linux' })).toEqual({
      kind: 'container',
      runtime: 'podman',
    });
  });

  it('auto on non-Linux ignores bwrap and uses a container runtime', () => {
    expect(detectMechanism('auto', { which: probe('bwrap', 'docker'), platform: 'darwin' })).toEqual(
      { kind: 'container', runtime: 'docker' },
    );
  });

  it('auto with nothing present → unavailable (fail-closed)', () => {
    expect(detectMechanism('auto', { which: probe(), platform: 'linux' }).kind).toBe('unavailable');
  });
});
