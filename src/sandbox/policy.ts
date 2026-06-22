import { z } from 'zod';

/**
 * The opt-in OS-isolation policy (issue #9). The sandbox is a Driver/composition concern — it
 * wraps the two untrusted-code execs (the agent CLI and the verifier `run`) at the composition
 * root and never touches the pure reducer. This module is the external seam's parsed shape: a
 * {@link SandboxMode} + the network toggle + the container knobs, all Zod-parsed (invariant #6),
 * plus the per-seam default profiles applied when `--sandbox` is on.
 */

/**
 * The sandbox mechanism requested on the CLI.
 *  - `none`   — identity passthrough; the current behavior, byte-for-byte (Option 1 default).
 *  - `auto`   — detect the best available mechanism (prefer `bwrap` on Linux, else `container`).
 *  - `bwrap`  — Linux bubblewrap.
 *  - `container` — a docker/podman `run` (the portable, cross-platform mechanism).
 */
export const SandboxMode = z.enum(['none', 'auto', 'bwrap', 'container']);
export type SandboxMode = z.infer<typeof SandboxMode>;

/** Binary egress toggle for slice 1 (an allowlist is a follow-up). */
export const SandboxNetwork = z.enum(['none', 'allow']);
export type SandboxNetwork = z.infer<typeof SandboxNetwork>;

/** The container runtime, when `mode === 'container'` (or `auto` resolves to it). */
export const SandboxRuntime = z.enum(['docker', 'podman']);
export type SandboxRuntime = z.infer<typeof SandboxRuntime>;

/** A concrete launcher mechanism (what a launcher reports as its `mode`). `auto` is never concrete. */
export type LauncherMode = 'none' | 'bwrap' | 'container';

/**
 * The parsed, validated sandbox policy. Built once at the composition root from the CLI flags and
 * threaded to {@link makeLauncher}. `image`/`runtime` are only meaningful for `container` mode.
 */
export const SandboxPolicy = z
  .object({
    mode: SandboxMode.default('none'),
    /**
     * Egress toggle — this is the VERIFIER default (`none`: no network). The harness seam always
     * overrides to `allow` via {@link networkForSeam} (it needs the model API).
     */
    network: SandboxNetwork.default('none'),
    /** Container image ref (container mode). Omitted ⇒ {@link DEFAULT_CONTAINER_IMAGE}. */
    image: z.string().min(1).optional(),
    /** Container runtime (container mode). Omitted ⇒ {@link DEFAULT_CONTAINER_RUNTIME}. */
    runtime: SandboxRuntime.optional(),
  })
  .strict();
export type SandboxPolicy = z.infer<typeof SandboxPolicy>;
export type SandboxPolicyInput = z.input<typeof SandboxPolicy>;

/** Default container image when `--sandbox-image` is unset (a generic toolchain base). */
export const DEFAULT_CONTAINER_IMAGE = 'debian:stable-slim';
/** Default container runtime when `--sandbox-runtime` is unset. */
export const DEFAULT_CONTAINER_RUNTIME: SandboxRuntime = 'docker';

/**
 * The two untrusted-code seams the sandbox wraps, each with its own default profile (per the ADR):
 *  - `harness`  — the agent CLI: needs network (model API) and full env (API keys).
 *  - `verifier` — `GitWorkspace.run()`: no network by default; env already scrubbed upstream.
 */
export type SandboxSeam = 'harness' | 'verifier';

/**
 * The per-run options a launcher needs to rewrite a command: the workspace it may write, whether
 * egress is allowed, and the (already-prepared, possibly scrubbed) env to pass through.
 */
export type SandboxRunOpts = {
  /** Absolute workspace path bound read-write (and mirrored inside a container). */
  readonly workspace: string;
  /** Egress: `allow` keeps the host network; `none` cuts it off. */
  readonly network: SandboxNetwork;
  /** The environment to expose inside the jail (container `-e` passthrough). */
  readonly env?: NodeJS.ProcessEnv;
};

/**
 * Resolve the policy's network toggle for one seam. The harness always keeps egress (it must reach
 * the model API); the verifier honours the policy (default `none`). Pure.
 */
export function networkForSeam(policy: SandboxPolicy, seam: SandboxSeam): SandboxNetwork {
  if (seam === 'harness') return 'allow';
  return policy.network;
}

/**
 * Host `$HOME` credential subdirectories that are NEVER bound into the jail (defense in depth on
 * top of env scrubbing). bwrap denies them with `--tmpfs`; the container simply never mounts
 * `$HOME`, so listing them is documentation of intent there.
 */
export const DENIED_HOME_SECRETS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
  '.docker',
  '.kube',
  '.npmrc',
] as const;
