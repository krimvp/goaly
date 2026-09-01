import path from 'node:path';
import type { SessionId } from '../domain/ids';
import { SessionId as SessionIdSchema } from '../domain/ids';
import type { HarnessAdapter } from '../harness/adapter';
import type { HarnessRunResult } from '../domain/events';
import type { Logger } from '../log/logger';
import { AgentCliHarness } from '../harness/agent-cli-harness';
import { GoalyCodeHarness } from '../goaly-code/harness';
import { NodeToolHost, type ShellExec } from '../goaly-code/fs-host';
import { FileSessionStore } from '../goaly-code/session-store';
import { codecFor } from '../agent-cli/registry';
import type { AutonomyLevel } from '../agent-cli/droid-codec';
import { DEFAULT_AGENT_TIMEOUT_MS } from '../agent-cli/codec';
import { runProcess } from '../util/spawn';
import { augmentToolPath, scrubEnv } from '../workspace/scrub-env';
import {
  makeLauncher,
  neutralAgentExec,
  networkForSeam,
  resolveProfile,
  withSandboxAgent,
  SandboxUnavailableError,
  type SandboxLauncher,
  type SandboxProxy,
} from '../sandbox';
import type { SandboxPolicy } from '../sandbox/policy';
import type { ResolvedModels } from './models';
import type { HarnessChoice } from './args';
import type { ComposeOptions } from './compose-options';
import { EndpointConfigError, makeOpenAiClient } from './compose-provider';

/**
 * The HARNESS-side wiring (seam #1): the sandbox launcher and its fail-closed check, the
 * codec-backed adapters, the non-codec goaly-code adapter with its tool-grain jailed shell, and
 * the no-op harness for pipeline tests. Extracted from `compose.ts` so the composition root stays
 * about wiring seams together, not about how each adapter is jailed and constructed.
 */

/** The default (off) sandbox policy: identity passthrough, behavior byte-for-byte unchanged. */
export function defaultPolicy(): SandboxPolicy {
  return { mode: 'none', network: 'none' };
}

/**
 * Build the sandbox launcher ONCE from the policy (issue #9). A directly-injected launcher (tests)
 * wins; otherwise {@link makeLauncher} probes the host fail-closed. `none` (the default) ⇒ identity.
 */
export function makeSandboxLauncher(options: ComposeOptions): SandboxLauncher {
  if (options.sandboxLauncher !== undefined) return options.sandboxLauncher;
  return makeLauncher(options.sandbox ?? defaultPolicy());
}

/**
 * Fail-closed (invariant #4): an {@link UnavailableLauncher} (a requested mechanism that the host
 * lacks) makes the run REFUSE TO START — throw before any subprocess is composed, never a silent
 * downgrade to unsandboxed.
 */
export function refuseIfUnavailable(launcher: SandboxLauncher): void {
  if (!launcher.available) {
    throw new SandboxUnavailableError(
      launcher.unavailableReason ?? 'requested sandbox mechanism is unavailable',
    );
  }
}

/** The sandbox wiring threaded into {@link makeHarness}: the launcher + the harness-seam profile. */
type HarnessSandbox = {
  launcher: SandboxLauncher;
  workspace: string;
  policy: SandboxPolicy;
  /** The running egress proxy when the policy uses an allowlist (issue #39). */
  proxy?: SandboxProxy;
};

export function makeHarness(
  // `goaly-code` is the non-codec adapter, routed away in composeDeps; this builds only codec-backed (and fake).
  choice: Exclude<HarnessChoice, 'goaly-code'>,
  model: string | undefined,
  timeoutMs: number | undefined,
  idleTimeoutMs: number | undefined,
  sandbox: HarnessSandbox,
  autonomy?: AutonomyLevel | undefined,
): HarnessAdapter {
  const exec = sandboxedHarnessExec(choice, timeoutMs, idleTimeoutMs, sandbox);
  const opts = {
    // Run the agent IN the workspace, not goaly's invocation cwd (which `npm run` resets to the
    // package root). Only the default exec reads this; the sandbox exec sets the jail's cwd itself.
    cwd: sandbox.workspace,
    ...(model !== undefined ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(exec !== undefined ? { exec } : {}),
  };
  // The fake harness has no codec; every real CLI is a thin binding of its codec over the one
  // generic AgentCliHarness (seam #1). The codec→choice map lives once in `codecFor`.
  if (choice === 'fake') return new NoopHarness();
  // `autonomy` is the WRITE role's knob only; `codecFor` ignores it for CLIs without a tier.
  return new AgentCliHarness(codecFor(choice, { autonomy }), opts);
}

/**
 * Build the SANDBOXED harness exec (issue #9) for a codec-backed adapter, or `undefined` when no
 * sandbox is active (the adapter then uses its default exec — byte-for-byte the current call). The
 * whole agent-CLI invocation is untrusted, so we wrap the entire exec. The neutral spawner runs
 * the launcher's rewritten `[binary, ...argv]`; the harness seam always keeps network egress.
 */
function sandboxedHarnessExec(
  choice: Exclude<HarnessChoice, 'goaly-code'>,
  timeoutMs: number | undefined,
  idleTimeoutMs: number | undefined,
  sandbox: HarnessSandbox,
): ReturnType<typeof withSandboxAgent> | undefined {
  if (sandbox.launcher.identity || choice === 'fake') return undefined;
  const codec = codecFor(choice);
  const budget = timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const inner = neutralAgentExec(budget, codec.promptOnStdin, idleTimeoutMs);
  return withSandboxAgent(codec.command, inner, sandbox.launcher, {
    workspace: sandbox.workspace,
    network: networkForSeam(sandbox.policy, 'harness'),
    // The harness keeps the FULL host env (NOT scrubbed): the agent CLI needs its API keys to
    // authenticate. The container launcher re-exports each NAME with `-e` (a fresh `docker`/`podman
    // run` inherits nothing); bwrap inherits the env naturally and ignores this.
    env: process.env,
    // The egress proxy when an allowlist is active (issue #39); the launcher pins the jail at it.
    ...(sandbox.proxy !== undefined ? { proxy: sandbox.proxy } : {}),
  });
}

/**
 * Build the goaly-code harness (the first non-codec adapter). It needs a base URL and a resolved model
 * (fail-closed otherwise), an OpenAI client for inference, a path-guarded {@link NodeToolHost} whose
 * `run_shell` is the ONLY sandboxed exec (finer-grained than wrapping an opaque CLI — spec §2.5), and
 * a {@link FileSessionStore} for resume. `sandboxedHarnessExec` (a codec-command wrapper) is bypassed.
 */
export function makeGoalyCodeHarness(
  options: ComposeOptions,
  models: ResolvedModels,
  stateDir: string,
  logger: Logger,
  launcher: SandboxLauncher,
): HarnessAdapter {
  if (options.baseUrl === undefined) {
    throw new EndpointConfigError('--harness goaly-code requires --base-url <url>');
  }
  if (models.harness === undefined) {
    throw new EndpointConfigError('--harness goaly-code requires a model (--model <m>)');
  }
  const timeouts = options.timeouts ?? {};
  const client = makeOpenAiClient(options.baseUrl, options.llmApiKey, timeouts.harnessMs, options.llmFetch);
  const shell = goalyCodeShellExec({
    root: options.workspaceRoot,
    launcher,
    policy: options.sandbox ?? defaultPolicy(),
    ...(options.egressProxy !== undefined ? { proxy: options.egressProxy } : {}),
    ...(timeouts.harnessMs !== undefined ? { timeoutMs: timeouts.harnessMs } : {}),
  });
  return new GoalyCodeHarness({
    client,
    model: models.harness,
    host: new NodeToolHost({ root: options.workspaceRoot, shell }),
    sessionStore: new FileSessionStore({ dir: path.join(stateDir, 'goaly-code-sessions') }),
    logger,
    ...(timeouts.harnessMs !== undefined ? { timeoutMs: timeouts.harnessMs } : {}),
    ...(options.goalyCodeMaxTurns !== undefined ? { maxTurns: options.goalyCodeMaxTurns } : {}),
  });
}

/**
 * The sandboxed `run_shell` exec for the goaly-code harness — the agent's untrusted shell, jailed at the
 * tool grain. Mirrors the verifier seam's `sh -c` rewrite but keeps the HARNESS network profile +
 * full env (the agent may need egress to build/install; the inference call is made by goaly itself,
 * un-jailed). With a {@link NoneLauncher} it is a plain in-workspace shell (default behavior).
 */
function goalyCodeShellExec(opts: {
  root: string;
  launcher: SandboxLauncher;
  policy: SandboxPolicy;
  proxy?: SandboxProxy;
  timeoutMs?: number;
}): ShellExec {
  const budget = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs, killGroup: true } : { killGroup: true };
  return async (command) => {
    // Scrub credentials: run_shell runs model-authored commands but, unlike a CLI harness, it does
    // NOT make the inference call (goaly does, un-jailed), so it never needs API keys. Deny it the
    // parent's secrets (matches the verifier seam); still augment PATH so an agent-installed toolchain
    // is discoverable.
    const env = augmentToolPath(scrubEnv(process.env));
    if (opts.launcher.identity) {
      const r = await runProcess(command, [], { cwd: opts.root, shell: true, env, ...budget });
      return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut };
    }
    const profile = resolveProfile(networkForSeam(opts.policy, 'harness'), {
      workspace: opts.root,
      env,
      ...(opts.proxy !== undefined ? { proxy: opts.proxy } : {}),
    });
    const wrapped = opts.launcher.wrap('sh', ['-c', command], profile);
    const r = await runProcess(wrapped.command, wrapped.args, { cwd: opts.root, env, ...budget });
    return { stdout: r.stdout, stderr: r.stderr, code: r.code, timedOut: r.timedOut };
  };
}

export function resolveWorkspaceMode(mode: 'git' | 'file' | 'auto', root: string): 'git' | 'file' {
  if (mode !== 'auto') return mode;
  try {
    const stat = require('node:fs').statSync(path.join(root, '.git'));
    return stat.isDirectory() || stat.isFile() ? 'git' : 'file';
  } catch {
    return 'file';
  }
}

/**
 * A harness that makes no changes — for exercising the full pipeline (workspace, verifier,
 * gates, run log) end-to-end without spawning a real agent.
 */
export class NoopHarness implements HarnessAdapter {
  readonly name = 'noop';
  async run(_prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    return {
      output: '(noop harness made no changes)',
      sessionId: sessionId ?? SessionIdSchema.parse('noop-session'),
      status: 'completed',
    };
  }
}
