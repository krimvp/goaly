import { BWRAP_COMMAND } from './bwrap';
import { FIREJAIL_COMMAND } from './firejail';
import type { LauncherMode, SandboxRuntime } from './policy';

/**
 * Probe the host for whether a binary is on PATH. INJECTABLE so tests never touch the real host —
 * they pass a fake that answers from a fixed set. The default production probe is wired in
 * `index.ts` (it is the only IO in this seam and lives at the composition boundary).
 */
export type WhichProbe = (binary: string) => boolean;

/** What `--sandbox=auto`/explicit detection resolved to, plus the runtime when it's a container. */
export type DetectedMechanism =
  | { kind: 'bwrap' }
  | { kind: 'firejail' }
  | { kind: 'container'; runtime: SandboxRuntime }
  | { kind: 'unavailable'; reason: string };

/** Whether the current platform is Linux (so `auto` prefers bwrap). Injectable for tests. */
export type DetectOpts = {
  /** Inject the host PATH probe (required — never defaults to real IO here). */
  which: WhichProbe;
  /** The OS platform string (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** A preferred container runtime from policy, probed first when set. */
  preferredRuntime?: SandboxRuntime;
};

/** Probe for an available container runtime, honouring a preferred one from policy. */
function detectContainer(which: WhichProbe, preferred?: SandboxRuntime): DetectedMechanism {
  const order: SandboxRuntime[] = preferred === 'podman' ? ['podman', 'docker'] : ['docker', 'podman'];
  for (const runtime of order) {
    if (which(runtime)) return { kind: 'container', runtime };
  }
  return { kind: 'unavailable', reason: 'no container runtime (docker/podman) found on PATH' };
}

/**
 * Resolve a requested mode against the host. Fail-closed (invariant #4): a mode whose mechanism is
 * absent resolves to `unavailable`, never a silent downgrade. `auto` prefers `bwrap` on Linux, then
 * `firejail` (issue #40), else a container runtime; `unavailable` when none is present.
 */
export function detectMechanism(
  mode: Exclude<LauncherMode, 'none'> | 'auto',
  opts: DetectOpts,
): DetectedMechanism {
  const platform = opts.platform ?? process.platform;

  if (mode === 'bwrap') {
    return opts.which(BWRAP_COMMAND)
      ? { kind: 'bwrap' }
      : { kind: 'unavailable', reason: `bwrap requested but '${BWRAP_COMMAND}' not found on PATH` };
  }

  if (mode === 'firejail') {
    return opts.which(FIREJAIL_COMMAND)
      ? { kind: 'firejail' }
      : {
          kind: 'unavailable',
          reason: `firejail requested but '${FIREJAIL_COMMAND}' not found on PATH`,
        };
  }

  if (mode === 'container') {
    return detectContainer(opts.which, opts.preferredRuntime);
  }

  // auto: on Linux prefer bwrap, then firejail; otherwise fall back to a container runtime.
  if (platform === 'linux') {
    if (opts.which(BWRAP_COMMAND)) return { kind: 'bwrap' };
    if (opts.which(FIREJAIL_COMMAND)) return { kind: 'firejail' };
  }
  const container = detectContainer(opts.which, opts.preferredRuntime);
  if (container.kind === 'container') return container;
  return {
    kind: 'unavailable',
    reason: '--sandbox=auto found no available mechanism (no bwrap, no firejail, no docker/podman)',
  };
}
