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
 *  - `auto`   — detect the best available mechanism (prefer `bwrap`, then `firejail`, on Linux,
 *    else `container`).
 *  - `bwrap`  — Linux bubblewrap.
 *  - `firejail` — Linux firejail (the fallback when bwrap is absent; issue #40).
 *  - `container` — a docker/podman `run` (the portable, cross-platform mechanism).
 */
export const SandboxMode = z.enum(['none', 'auto', 'bwrap', 'firejail', 'container']);
export type SandboxMode = z.infer<typeof SandboxMode>;

/**
 * A single egress-allowlist host (issue #39): a bare hostname (`api.anthropic.com`), a subdomain
 * wildcard (`*.npmjs.org`), each optionally pinned to a port (`host:443`). Non-empty; the host part
 * is lower-cased by the proxy when matched.
 */
export const AllowlistHost = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^(\*\.)?[A-Za-z0-9._-]+(:\d{1,5})?$/,
    'expected a host, *.host wildcard, or host:port',
  );
export type AllowlistHost = z.infer<typeof AllowlistHost>;

/**
 * Egress restricted to an allowlist (issue #39): the network stays up but is routed through the
 * allowlisting egress proxy, so only the listed hosts are reachable and everything else is denied.
 */
export const SandboxAllowlist = z
  .object({ allowlist: z.array(AllowlistHost).min(1) })
  .strict();
export type SandboxAllowlist = z.infer<typeof SandboxAllowlist>;

/**
 * The egress policy (issue #39 extends the slice-1 binary toggle with an allowlist):
 *  - `none`  — cut the network entirely.
 *  - `allow` — keep the host network, fully open.
 *  - `{ allowlist }` — keep the network but route it through an allowlisting proxy: only the listed
 *    hosts (the model API + package registries, say) are reachable; all other egress is denied.
 */
export const SandboxNetwork = z.union([
  z.literal('none'),
  z.literal('allow'),
  SandboxAllowlist,
]);
export type SandboxNetwork = z.infer<typeof SandboxNetwork>;

/** Is this resolved egress value an allowlist (vs. the `none`/`allow` literals)? Pure narrowing. */
export function isAllowlist(network: SandboxNetwork): network is SandboxAllowlist {
  return typeof network === 'object';
}

/**
 * The standard env vars cooperating clients honour to route egress through a proxy (issue #39).
 * Both cases are set because tools differ in which they read.
 */
export const PROXY_ENV_VARS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

/** Hosts that must never be proxied (the loopback the jail uses for the proxy itself). */
export const PROXY_NO_PROXY = 'localhost,127.0.0.1';

/**
 * Build the in-jail proxy URL from the host the jail reaches the proxy on and the run's proxy port.
 * Fail-closed (invariant #4): an allowlist with no running proxy is a hard error, never silent
 * unrestricted egress. PURE.
 */
export function proxyUrlFor(host: string, proxy: SandboxProxy | undefined): string {
  if (proxy === undefined) {
    throw new Error(
      'sandbox egress allowlist requested but no egress-proxy port was provided to the launcher',
    );
  }
  return `http://${host}:${proxy.port}`;
}

/**
 * Emit the standard proxy env vars (issue #39) for a `proxied` profile through a launcher-supplied
 * `emit(name, value)` — the launchers differ only in flag SYNTAX (`--setenv NAME val` /
 * `--env=NAME=val` / `-e NAME=val`), so the var NAMES and the `NO_PROXY` exemption live here ONCE.
 * `host` is the launcher's own route to the host proxy (`127.0.0.1` for bwrap/firejail; the container
 * gateway alias). Fail-closed (invariant #4): a `proxied` profile with no running proxy throws via
 * {@link proxyUrlFor}. PURE.
 */
export function proxyEnv(
  emit: (name: string, value: string) => void,
  host: string,
  proxy: SandboxProxy | undefined,
): void {
  const url = proxyUrlFor(host, proxy);
  for (const name of PROXY_ENV_VARS) emit(name, url);
  emit('NO_PROXY', PROXY_NO_PROXY);
  emit('no_proxy', PROXY_NO_PROXY);
}

/** The container runtime, when `mode === 'container'` (or `auto` resolves to it). */
export const SandboxRuntime = z.enum(['docker', 'podman']);
export type SandboxRuntime = z.infer<typeof SandboxRuntime>;

/** A concrete launcher mechanism (what a launcher reports as its `mode`). `auto` is never concrete. */
export type LauncherMode = 'none' | 'bwrap' | 'firejail' | 'container';

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

/** The running egress proxy a jail routes through under an allowlist (issue #39): its host port. */
export type SandboxProxy = {
  /** The proxy's listening port on the host (bound to loopback). */
  readonly port: number;
};

/**
 * The egress shape a launcher must enforce, resolved from the per-seam {@link SandboxNetwork}:
 *  - `isolated` — cut the network entirely (`none`).
 *  - `proxied`  — keep it up but route through the egress proxy (an `{ allowlist }`).
 *  - `open`     — full egress (`allow`).
 * The launcher branches on these three, never on the raw allowlist (the proxy enforces the hosts).
 */
export type SandboxNetMode = 'isolated' | 'proxied' | 'open';

/**
 * The mechanism-AGNOSTIC isolation profile a launcher translates into its own flag dialect. ALL the
 * per-seam POLICY is resolved here once ({@link resolveProfile}); a launcher makes no policy decision
 * — it only expresses this profile in bwrap / firejail / docker flags. That kills the triplicated
 * `$HOME`-denial / network-branching / proxy logic the launchers used to each re-derive.
 */
export type SandboxProfile = {
  /** Absolute workspace path bound read-write (and mirrored inside a container). */
  readonly workspace: string;
  /** Absolute credential dirs to DENY inside the jail (already `$HOME`-resolved). */
  readonly denyDirs: readonly string[];
  /** The resolved egress shape — the launcher branches on this, not the raw allowlist. */
  readonly network: SandboxNetMode;
  /** The environment to expose inside the jail (container `-e` passthrough). */
  readonly env?: NodeJS.ProcessEnv;
  /** The egress proxy to route through when `network === 'proxied'` (issue #39); absent ⇒ fail-closed. */
  readonly proxy?: SandboxProxy;
};

/**
 * Resolve the mechanism-agnostic {@link SandboxProfile} for one seam from its already-per-seam
 * egress ({@link networkForSeam}) plus the workspace / env / proxy / `$HOME`. The single place the
 * `$HOME` credential dirs are turned into absolute deny paths and the tri-state egress is chosen, so
 * every launcher consumes a finished profile and re-derives nothing. PURE (given `home`).
 */
export function resolveProfile(
  network: SandboxNetwork,
  opts: {
    workspace: string;
    env?: NodeJS.ProcessEnv | undefined;
    proxy?: SandboxProxy | undefined;
    home?: string | undefined;
  },
): SandboxProfile {
  const home = opts.home ?? process.env.HOME;
  const denyDirs =
    home !== undefined && home.length > 0 ? DENIED_HOME_SECRETS.map((s) => `${home}/${s}`) : [];
  const mode: SandboxNetMode =
    network === 'none' ? 'isolated' : isAllowlist(network) ? 'proxied' : 'open';
  return {
    workspace: opts.workspace,
    denyDirs,
    network: mode,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}),
  };
}

/**
 * Resolve the policy's egress for one seam. Pure.
 *  - An `{ allowlist }` policy constrains BOTH seams: the harness's model-API host must simply be on
 *    the list too (issue #39). This is the whole point — `npm test` no longer opens exfiltration
 *    egress just because the harness needs the API.
 *  - Otherwise the harness always keeps full egress (it must reach the model API) and the verifier
 *    honours the policy (default `none`).
 */
export function networkForSeam(policy: SandboxPolicy, seam: SandboxSeam): SandboxNetwork {
  if (isAllowlist(policy.network)) return policy.network;
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
