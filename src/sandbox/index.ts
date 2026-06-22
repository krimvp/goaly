import { which as defaultWhich } from '../util/which';
import { runProcess } from '../util/spawn';
import type { AgentExecFn } from '../agent-cli/codec';
import { BwrapLauncher } from './bwrap';
import { ContainerLauncher } from './container';
import { detectMechanism, type WhichProbe } from './detect';
import { NoneLauncher, UnavailableLauncher, type SandboxLauncher } from './launcher';
import type { SandboxPolicy } from './policy';

export type { SandboxLauncher } from './launcher';
export { SandboxUnavailableError } from './launcher';
export { withSandboxAgent, withSandboxVerify, type SandboxExecOpts } from './sandboxed-exec';
export {
  SandboxPolicy,
  networkForSeam,
  type SandboxSeam,
  type SandboxRunOpts,
  type SandboxNetwork,
} from './policy';

/** Options for {@link makeLauncher}: inject the host probe + platform so tests never touch a host. */
export type MakeLauncherOpts = {
  /** Host PATH probe (default: the real `which`). Inject a fake in tests. */
  which?: WhichProbe;
  /** OS platform (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** `$HOME` for bwrap's secret-masking (default `process.env.HOME`). */
  home?: string | undefined;
};

/**
 * The composition helper: turn a parsed {@link SandboxPolicy} into a concrete {@link SandboxLauncher}
 * ONCE. `none` ⇒ identity {@link NoneLauncher}; any other mode probes the host (fail-closed,
 * invariant #4) and returns either the real launcher or an {@link UnavailableLauncher} that makes
 * the run refuse to start. Pure given an injected `which`/`platform`.
 */
export function makeLauncher(policy: SandboxPolicy, opts: MakeLauncherOpts = {}): SandboxLauncher {
  if (policy.mode === 'none') return new NoneLauncher();

  const which = opts.which ?? defaultWhich;
  const detected = detectMechanism(policy.mode, {
    which,
    ...(opts.platform !== undefined ? { platform: opts.platform } : {}),
    ...(policy.runtime !== undefined ? { preferredRuntime: policy.runtime } : {}),
  });

  if (detected.kind === 'unavailable') {
    return new UnavailableLauncher(
      `--sandbox=${policy.mode} requested but unavailable: ${detected.reason}. Refusing to run unsandboxed.`,
    );
  }
  if (detected.kind === 'bwrap') {
    return new BwrapLauncher(opts.home);
  }
  return new ContainerLauncher({
    runtime: detected.runtime,
    ...(policy.image !== undefined ? { image: policy.image } : {}),
  });
}

/**
 * The neutral agent spawner used UNDER a real sandbox launcher: the launcher rewrites the agent
 * invocation into `[binary, ...launcherArgs]`, so this inner exec spawns `args[0]` with the rest.
 * Used only when {@link withSandboxAgent} actually rewrites; `none` keeps the codec's own exec.
 */
export function neutralAgentExec(timeoutMs: number, promptOnStdin: boolean): AgentExecFn {
  return async (args, input, onStdout) => {
    const [binary, ...rest] = args;
    if (binary === undefined) {
      return { stdout: '', stderr: 'sandbox produced an empty command', code: 127 };
    }
    const r = await runProcess(binary, rest, {
      timeoutMs,
      ...(promptOnStdin ? { input: input.prompt } : {}),
      ...(onStdout !== undefined ? { onStdout } : {}),
    });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut };
  };
}
