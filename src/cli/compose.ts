import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DriverDeps } from '../driver/driver';
import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { RunId, SessionId } from '../domain/ids';
import { SessionId as SessionIdSchema } from '../domain/ids';
import type { HarnessAdapter } from '../harness/adapter';
import type { HarnessRunResult } from '../domain/events';
import type { Verifier } from '../verify/verifier';
import type { LlmProvider } from '../llm/provider';
import { Ladder } from '../verify/ladder';
import { DeterministicVerifier } from '../verify/deterministic';
import { GeneratedFilesGuard } from '../verify/generated-guard';
import { JudgeVerifier } from '../verify/judge';
import { AgentApprover } from '../verify/agent-approver';
import { AgentCompiler } from '../compile/agent-compiler';
import { AutoSealGate, HumanSealGate } from '../compile/seal-gates';
import { AgentPlanner } from '../plan/agent-planner';
import { StaticPlanner } from '../plan/static-planner';
import { AutoPlanGate, HumanPlanGate } from '../plan/plan-gates';
import type { Planner } from '../plan/planner';
import type { PlanGate } from '../plan/plan-gate';
import { GitWorkspace } from '../workspace/git-workspace';
import { excludeFromGit } from '../workspace/git-exclude';
import { FileRunLog } from '../runlog/file-runlog';
import { StreamTranscriptSink, STREAM_FILE } from '../runlog/stream-transcript';
import { AgentCliHarness } from '../harness/agent-cli-harness';
import { SystemClock } from '../driver/clock';
import { SystemBudgetMeter } from '../driver/budget';
import { LlmTokenMeter, meterLlm } from '../driver/llm-meter';
import { buildLogger, type FileLogOptions } from '../log/build';
import type { Logger, LogLevel } from '../log/logger';
import type { LogFs } from '../log/sinks';
import { AgentCliLlmProvider } from '../llm/agent-cli-provider';
import { OpenAiLlmProvider } from '../llm/openai-provider';
import { OpenAiClient, type FetchLike } from '../llm-client/openai-client';
import { GoalyCodeHarness } from '../goaly-code/harness';
import { NodeToolHost, type ShellExec } from '../goaly-code/fs-host';
import { FileSessionStore } from '../goaly-code/session-store';
import { codecFor, type AgentCli } from '../agent-cli/registry';
import { runProcess } from '../util/spawn';
import { augmentToolPath, scrubEnv } from '../workspace/scrub-env';
import { resolveProfile } from '../sandbox';
import type { ResolvedModels } from './models';
import type { AgentEventSink, PhasedStreamSink, StreamPhase } from '../agent-cli/stream';
import { makeStreamRenderer, streamLogFields } from './stream-render';
import { resolveModels, type ModelSelection } from './models';
import { independenceWarnings } from './independence';
import type { HarnessChoice, LlmProviderChoice, StepTimeouts } from './args';
import {
  makeLauncher,
  neutralAgentExec,
  networkForSeam,
  withSandboxAgent,
  withSandboxVerify,
  SandboxUnavailableError,
  type SandboxLauncher,
  type SandboxProxy,
} from '../sandbox';
import { DEFAULT_AGENT_TIMEOUT_MS } from '../agent-cli/codec';
import type { SandboxPolicy } from '../sandbox/policy';
import type { ExecFn } from '../workspace/git-workspace';

export type ComposeOptions = {
  harness: HarnessChoice;
  workspaceRoot: string;
  runId: RunId;
  /** Override the LLM provider (tests inject a FakeLlm; production uses the CLI provider). */
  llm?: LlmProvider;
  /** Which CLI runs the LLM workflow steps (judge / approver / compiler). Default `claude`. */
  llmProvider?: LlmProviderChoice;
  /** Raw model-selection flags; resolved into per-seam models via the cascade. */
  models?: ModelSelection;
  /** Per-step subprocess timeouts (harness / LLM steps / verify command). Each absent ⇒ default. */
  timeouts?: StepTimeouts;
  /**
   * Opt-in OS-isolation policy (issue #9). Absent / `mode: 'none'` ⇒ identity passthrough, so the
   * harness and verifier execs are byte-for-byte the current calls. Any other mode is detected
   * fail-closed: if the requested mechanism is absent the run refuses to start.
   */
  sandbox?: SandboxPolicy;
  /** Inject the sandbox launcher directly (tests); bypasses host detection from {@link sandbox}. */
  sandboxLauncher?: SandboxLauncher;
  /**
   * The running egress proxy when the sandbox policy uses an allowlist (issue #39). Started at the
   * composition edge (main.ts) before deps are composed and torn down after the run; threaded into
   * both jailed seams so they pin their proxy env vars at it. Absent ⇒ no allowlist active.
   */
  egressProxy?: SandboxProxy;
  /**
   * Diff baseline (issue #47): the git ref/SHA `diff()` (and thus Sign-off) compares the working tree
   * against, instead of `HEAD`. The CLI validates it resolves fail-closed BEFORE composing; here it
   * is just adopted onto the workspace. Absent ⇒ baseline stays `HEAD` (behavior unchanged).
   */
  baseline?: string;
  /**
   * Preferred directory (relative to the workspace root) for compiler-authored verification files
   * (issue #52). Threaded to the compiler as authoring guidance; absent ⇒ the compiler chooses an
   * idiomatic location. Authored files are registered in `.git/info/exclude` either way.
   */
  verifyDir?: string;
  /**
   * Phased decomposition (issue #48): the `--plan-file <path>` that sources a structured plan instead
   * of authoring one with the LLM. When set (and `config.phased`), a {@link StaticPlanner} reads it;
   * absent ⇒ the {@link AgentPlanner} authors the plan. Ignored when `config.phased` is false.
   */
  planFile?: string;
  /** Where run logs live. Default `<workspaceRoot>/.goaly` (excluded from diffHash). */
  stateDir?: string;
  /** Minimum diagnostic log level. Default `info`. */
  logLevel?: LogLevel;
  /** Override the diagnostics file path. Default `<stateDir>/<runId>/goaly.log`. */
  logFile?: string;
  /** Disable the diagnostics file sink (console only). */
  noLogFile?: boolean;
  /** Disable the console sink (file only) — handy in tests to keep stderr quiet. */
  noLogConsole?: boolean;
  /** Inject a fully-built logger (tests); bypasses the level/file options above. */
  logger?: Logger;
  /** Inject the log filesystem (tests) so diagnostics never touch disk. */
  logFs?: LogFs;
  /** Inject the clock source for log timestamps (tests). */
  now?: () => number;
  /**
   * Enable the `--stream` live view (issue #23): render the harness run AND the LLM steps'
   * intermediate turns to stderr, phase-tagged. Opt-in; off by default.
   */
  stream?: boolean;
  /** Override where the `--stream` renderer writes (tests capture it; default `process.stderr`). */
  streamWrite?: (line: string) => void;
  /**
   * Embedder hook (issue #23): subscribe to every phase-tagged stream event (the agent run and the
   * compile / judge / approve steps). Composed alongside the live view and the debug logger, then
   * threaded into the harness (via `DriverDeps.onStreamEvent`) and the LLM-step providers.
   */
  onStreamEvent?: PhasedStreamSink;
  /**
   * Durable stream transcript (issue #28): persist every phase-tagged stream event as canonical
   * JSONL to a per-run file for offline replay. `streamTranscript: true` writes to the default
   * `<stateDir>/<runId>/stream.jsonl`. Opt-in; a SEPARATE file from the run log — never the state
   * replay source — and fail-closed (a write failure degrades to "no transcript").
   */
  streamTranscript?: boolean;
  /** Override the stream-transcript path (implies {@link streamTranscript}). Default next to the run log. */
  streamFile?: string;
  /**
   * OpenAI-compatible endpoint base URL for `--harness goaly-code` / `--llm-provider openai`. Required for
   * those targets; absent ⇒ they fail closed at composition (a typed {@link EndpointConfigError}).
   */
  baseUrl?: string;
  /** Resolved bearer token for that endpoint (read from env at the composition edge). May be absent. */
  llmApiKey?: string;
  /** Inject the HTTP fetch for the OpenAI client (tests/embedders); default binds global fetch. */
  llmFetch?: FetchLike;
  /** Override the goaly-code harness per-run turn cap. */
  goalyCodeMaxTurns?: number;
};

/**
 * Thrown when `--harness goaly-code` / `--llm-provider openai` is selected without the config they require
 * (a base URL, a resolved model). Fail-closed (invariant #4): the run refuses to start rather than
 * silently pointing at nothing. The CLI catches it for a friendly message + exit 2.
 */
export class EndpointConfigError extends Error {}

/** The orchestrator's own state directory name, kept out of stuck-detection hashing. */
export const STATE_DIR = '.goaly';

/** The default (off) sandbox policy: identity passthrough, behavior byte-for-byte unchanged. */
function defaultPolicy(): SandboxPolicy {
  return { mode: 'none', network: 'none' };
}

/**
 * Build the sandbox launcher ONCE from the policy (issue #9). A directly-injected launcher (tests)
 * wins; otherwise {@link makeLauncher} probes the host fail-closed. `none` (the default) ⇒ identity.
 */
function makeSandboxLauncher(options: ComposeOptions): SandboxLauncher {
  if (options.sandboxLauncher !== undefined) return options.sandboxLauncher;
  return makeLauncher(options.sandbox ?? defaultPolicy());
}

/**
 * Fail-closed (invariant #4): an {@link UnavailableLauncher} (a requested mechanism that the host
 * lacks) makes the run REFUSE TO START — throw before any subprocess is composed, never a silent
 * downgrade to unsandboxed.
 */
function refuseIfUnavailable(launcher: SandboxLauncher): void {
  if (!launcher.available) {
    throw new SandboxUnavailableError(
      launcher.unavailableReason ?? 'requested sandbox mechanism is unavailable',
    );
  }
}

/**
 * The composition root: assemble a fully-wired {@link DriverDeps} from validated config. This
 * is the only place that knows which concrete adapter/verifier/gate backs each seam, and the
 * only place that turns the frozen contract's rungs into a runnable Ladder.
 */
export function composeDeps(config: RunConfig, options: ComposeOptions): DriverDeps {
  const models = resolveModels(options.models ?? {});
  const provider = options.llmProvider ?? 'claude';
  const timeouts = options.timeouts ?? {};
  // One meter for every LLM workflow step (compiler / judge / approver) so the Driver can aggregate
  // their token spend per command (issue #17). Wrapping is transparent — the consumers still see a
  // plain LlmProvider, and an injected test `llm` is metered just the same.
  const llmMeter = new LlmTokenMeter();
  const clock = new SystemClock();
  // Keep the orchestrator's own state dir AND any user-listed verifier artifacts out of the
  // tree hash, so stuck-detection sees only the agent's real work — not coverage dirs / build output
  // a verifier drops between iterations. Deduped so an explicit `.goaly` in --diff-ignore is a no-op.
  const excludes = [...new Set([STATE_DIR, ...config.diffIgnore])];
  // Build the sandbox launcher ONCE (issue #9). `none` ⇒ identity; any other mode is detected
  // fail-closed (an absent mechanism makes the run refuse to start — never silently unsandboxed).
  const launcher = makeSandboxLauncher(options);
  refuseIfUnavailable(launcher);
  // The verifier seam: wrap ONLY GitWorkspace.run() — never the git plumbing. The dedicated
  // run-launcher injection point applies the jail inside run(), where scrubVerifyEnv already lives.
  const runLauncher = launcher.identity
    ? undefined
    : (exec: ExecFn): ExecFn =>
        withSandboxVerify(
          exec,
          launcher,
          networkForSeam(options.sandbox ?? defaultPolicy(), 'verifier'),
          options.egressProxy,
        );
  const workspace = new GitWorkspace(options.workspaceRoot, undefined, excludes, true, runLauncher);
  // Adopt an explicit `--baseline` (issue #47) so `diff()`/Sign-off compare against it instead of HEAD.
  // The CLI already validated it resolves (fail-closed); a resumed run re-points it from the log.
  if (options.baseline !== undefined) workspace.setBaseline(options.baseline);
  const stateDir = options.stateDir ?? path.join(options.workspaceRoot, STATE_DIR);
  const logger = options.logger ?? buildRunLogger(options, stateDir);
  const streamSink = buildStreamSink(options, logger, stateDir, options.now ?? (() => clock.now()));

  // Warn loudly when the "two independent keys" collapse onto one model. Skipped when
  // the caller injects its own `llm` — then the resolved per-seam models are not what runs, so the
  // wiring warning would be misleading (and noisy in tests/embedders).
  if (options.llm === undefined) {
    for (const warning of independenceWarnings(models, options.harness, provider)) {
      logger.warn('model independence', { detail: warning });
    }
  }

  // An injected `llm` (tests) overrides every step; otherwise build a provider per step so each can
  // carry its own resolved model, per-step timeout, AND its phase-tagged stream sink. All three are
  // wiring — none enters the frozen contract. The sink is injected at CONSTRUCTION so it never leaks
  // through the Verifier/Approver seams (the `LlmProvider` stays an internal seam). Each provider is
  // wrapped with the shared meter so its token spend is aggregated at the Driver (issue #17).
  const llmFor = (model: string | undefined, phase: StreamPhase): LlmProvider =>
    meterLlm(
      options.llm ??
        makeLlmProvider(provider, model, {
          ...(timeouts.llmMs !== undefined ? { timeoutMs: timeouts.llmMs } : {}),
          ...(streamSink !== undefined ? { onEvent: (event) => streamSink(phase, event) } : {}),
          ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
          ...(options.llmApiKey !== undefined ? { apiKey: options.llmApiKey } : {}),
          ...(options.llmFetch !== undefined ? { fetch: options.llmFetch } : {}),
        }),
      llmMeter,
    );

  // Phased decomposition (issue #48): wire the planner + plan Seal ONLY for a phased run (a classic
  // run never emits a PLAN command, so building them would be dead wiring + a spurious LLM provider).
  // `--plan-file` selects the StaticPlanner; otherwise the AgentPlanner authors the plan. `--autonomous`
  // moves the plan Seal pause too (still frozen + logged loudly).
  const phasedSeams: { planner: Planner; planGate: PlanGate } | undefined = config.phased
    ? {
        planner:
          options.planFile !== undefined
            ? new StaticPlanner({ path: options.planFile })
            : new AgentPlanner({ llm: llmFor(models.planner, 'plan') }),
        planGate: config.autonomous
          ? new AutoPlanGate()
          : new HumanPlanGate({ allowRevise: config.maxPlanRevisions > 0 }),
      }
    : undefined;

  return {
    compiler: new AgentCompiler({
      llm: llmFor(models.compiler, 'compile'),
      writeFile: (rel, content) => writeVerificationFile(options.workspaceRoot, rel, content, logger),
      ...(options.verifyDir !== undefined ? { verifyDir: options.verifyDir } : {}),
    }),
    seal: config.autonomous
      ? new AutoSealGate()
      : new HumanSealGate({ allowRevise: config.maxSealRevisions > 0 }),
    ...(phasedSeams !== undefined ? phasedSeams : {}),
    harness:
      options.harness === 'goaly-code'
        ? makeGoalyCodeHarness(options, models, stateDir, logger, launcher)
        : makeHarness(options.harness, models.harness, timeouts.harnessMs, timeouts.harnessIdleMs, {
            launcher,
            workspace: options.workspaceRoot,
            policy: options.sandbox ?? defaultPolicy(),
            ...(options.egressProxy !== undefined ? { proxy: options.egressProxy } : {}),
          }),
    makeLadder: (contract) => buildLadder(contract, llmFor(models.judge, 'judge'), timeouts.verifyMs),
    approver: new AgentApprover({ llm: llmFor(models.approver, 'approve') }),
    // Pre-flight soundness classifier (Fix #2): a read-only call that decides whether a failing
    // deterministic pre-flight rung is a broken frozen verifier or an honest red. Reuses the judge
    // model — it is a verification judgment — and is metered through the same shared meter.
    prepareLlm: llmFor(models.judge, 'preflight'),
    workspace,
    clock,
    budget: new SystemBudgetMeter(config.budget, clock),
    llmMeter,
    runlog: new FileRunLog(path.join(stateDir, options.runId)),
    logger,
    // Per-step timeouts for the one-time prepare phase (Fix #1 setup + Fix #2 pre-flight). The setup
    // command gets its own cap; the deterministic pre-flight reuses the verify-command cap. Pure wiring.
    prepareTimeouts: {
      ...(timeouts.setupMs !== undefined ? { setupMs: timeouts.setupMs } : {}),
      ...(timeouts.verifyMs !== undefined ? { verifyMs: timeouts.verifyMs } : {}),
    },
    ...(streamSink !== undefined ? { onStreamEvent: streamSink } : {}),
  };
}

/**
 * Assemble the one phase-tagged stream sink (issue #23) that fans every event out to the
 * driver-side consumer surfaces — the `--stream` live stderr view, the diagnostics logger (at
 * `debug`, respecting `--log-level`), the durable transcript (issue #28), and any embedder
 * subscription. Returns `undefined` when no consumer is active so a default run builds NO taps and
 * pays zero streaming overhead. Each branch is guarded: a throwing consumer can never crash a run
 * or starve the others (fail-closed).
 */
function buildStreamSink(
  options: ComposeOptions,
  logger: Logger,
  stateDir: string,
  now: () => number,
): PhasedStreamSink | undefined {
  const renderer = options.stream === true ? makeStreamRenderer(streamRendererOpts(options)) : undefined;
  const routeToLog = (options.logLevel ?? 'info') === 'debug';
  const transcript = buildTranscriptSink(options, stateDir, now);
  const embedder = options.onStreamEvent;
  if (renderer === undefined && !routeToLog && transcript === undefined && embedder === undefined) {
    return undefined;
  }

  return (phase, event) => {
    if (renderer !== undefined) renderer(phase, event);
    if (routeToLog) logger.debug('stream', streamLogFields(phase, event));
    if (transcript !== undefined) transcript(phase, event); // already fail-closed inside the sink
    if (embedder !== undefined) {
      try {
        embedder(phase, event);
      } catch {
        /* an embedder subscription must never crash the run */
      }
    }
  };
}

/**
 * Build the durable stream-transcript subscriber (issue #28) when enabled. `streamFile` sets an
 * explicit path; `streamTranscript: true` uses the default `<stateDir>/<runId>/stream.jsonl`.
 * Returns the bound, already-fail-closed {@link PhasedStreamSink}, or `undefined` when no transcript
 * was requested.
 */
function buildTranscriptSink(
  options: ComposeOptions,
  stateDir: string,
  now: () => number,
): PhasedStreamSink | undefined {
  const file =
    options.streamFile ??
    (options.streamTranscript === true ? path.join(stateDir, options.runId, STREAM_FILE) : undefined);
  if (file === undefined) return undefined;
  return new StreamTranscriptSink({ path: file, now }).record;
}

function streamRendererOpts(options: ComposeOptions): { write?: (line: string) => void } {
  return options.streamWrite !== undefined ? { write: options.streamWrite } : {};
}

/**
 * Build the run's diagnostic logger: a console sink (stderr, human-formatted) plus, unless
 * disabled, a size-rotated JSON file co-located with the run log at `<stateDir>/<runId>/goaly.log`.
 * `runId` is bound onto every record. This is the only place real filesystem logging is wired.
 */
function buildRunLogger(options: ComposeOptions, stateDir: string): Logger {
  const file: FileLogOptions | undefined =
    options.noLogFile === true
      ? undefined
      : {
          path: options.logFile ?? path.join(stateDir, options.runId, 'goaly.log'),
          ...(options.logFs !== undefined ? { fs: options.logFs } : {}),
        };
  return buildLogger({
    level: options.logLevel ?? 'info',
    console: options.noLogConsole !== true,
    ...(file !== undefined ? { file } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    fields: { runId: options.runId },
  });
}

/**
 * Build the LLM provider for the workflow steps. `claude` uses the lean `claude -p` completion;
 * `codex`/`droid`/`pi` wrap their agentic CLI in a one-shot READ-ONLY mode (codex `--sandbox
 * read-only`, droid's default no-`--auto` exec, pi's `--tools read,grep,find,ls`) so a judge /
 * approver / compiler can use that tool's model without ever mutating the working tree it is judging.
 * The resolved per-step model is threaded in.
 */
export function makeLlmProvider(
  choice: LlmProviderChoice,
  model: string | undefined,
  opts: {
    onEvent?: AgentEventSink;
    timeoutMs?: number;
    baseUrl?: string;
    apiKey?: string;
    fetch?: FetchLike;
  } = {},
): LlmProvider {
  // `openai` is the first non-CLI provider: a direct chat-completions call (no coding CLI). It is
  // structurally read-only (one [system,user] exchange, no tools) and fails closed without the
  // endpoint/model it needs.
  if (choice === 'openai') {
    if (opts.baseUrl === undefined) {
      throw new EndpointConfigError('--llm-provider openai requires --base-url <url>');
    }
    if (model === undefined) {
      throw new EndpointConfigError('--llm-provider openai requires a model (--llm-model or --model)');
    }
    return new OpenAiLlmProvider({ client: makeOpenAiClient(opts.baseUrl, opts.apiKey, opts.timeoutMs, opts.fetch), model });
  }
  // One codec-driven provider for every CLI: the codec owns the read-only argv, the prompt-on-stdin
  // decision, and the field/stream extractors, so judge/approver/compiler share one source of truth
  // with the harness role. `claude` reads its prompt on stdin; codex/droid/pi carry it on argv —
  // the provider keys that off `codec.promptOnStdin`.
  return new AgentCliLlmProvider({
    codec: codecFor(choice),
    ...(model !== undefined ? { model } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {}),
  });
}

/** Build the shared OpenAI-compatible HTTP client (transport for the provider AND the goaly-code harness). */
function makeOpenAiClient(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number | undefined,
  fetch: FetchLike | undefined,
): OpenAiClient {
  return new OpenAiClient({
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(fetch !== undefined ? { fetch } : {}),
  });
}

/**
 * Turn the frozen contract's ordered rungs into a Ladder of concrete verifiers. An optional
 * `verifyTimeoutMs` caps each deterministic command — including an artifact-running smoke command
 * (issue #53), which is just another deterministic rung (a timeout is a fail-closed FAIL); the model
 * and timeout are wiring and never alter the frozen rungs themselves.
 */
export function buildLadder(
  contract: CompiledContract,
  llm: LlmProvider,
  verifyTimeoutMs?: number,
): Verifier {
  const rungs: Verifier[] = contract.rungs.map((rung) =>
    rung.kind === 'deterministic'
      ? new DeterministicVerifier(rung.command, rung.label, verifyTimeoutMs)
      : new JudgeVerifier({
          rubric: rung.rubric,
          quorum: rung.quorum,
          confidenceFloor: rung.confidenceFloor,
          llm,
        }),
  );
  // Pin compiler-authored verification files: a guard runs FIRST and fails closed if
  // any frozen generated file was modified/removed, so the worker can't rewrite the bar the frozen
  // command measures. No generated files ⇒ no guard (the common --verify-cmd path is unchanged).
  if (contract.generatedFiles.length > 0) {
    rungs.unshift(new GeneratedFilesGuard(contract.generatedFiles));
  }
  return new Ladder(rungs);
}

/** The sandbox wiring threaded into {@link makeHarness}: the launcher + the harness-seam profile. */
type HarnessSandbox = {
  launcher: SandboxLauncher;
  workspace: string;
  policy: SandboxPolicy;
  /** The running egress proxy when the policy uses an allowlist (issue #39). */
  proxy?: SandboxProxy;
};

function makeHarness(
  // `goaly-code` is the non-codec adapter, routed away in composeDeps; this builds only codec-backed (and fake).
  choice: Exclude<HarnessChoice, 'goaly-code'>,
  model: string | undefined,
  timeoutMs: number | undefined,
  idleTimeoutMs: number | undefined,
  sandbox: HarnessSandbox,
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
  return new AgentCliHarness(codecFor(choice), opts);
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
function makeGoalyCodeHarness(
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

/**
 * Write a compiler-authored verification file and seamlessly keep it out of the user's git (issue
 * #52): after the path-guarded write, register the exact path in `.git/info/exclude` so it never
 * shows up in `git status` and is never accidentally committed — no `.gitignore` edit, no tracked
 * file touched, nothing for the user to review or undo. The exclude step is best-effort and
 * fail-closed: a failure degrades to "not excluded" (logged loudly), never a changed run outcome.
 * One loud log line per file tells the user what was authored and how to keep it (`git add -f`).
 */
async function writeVerificationFile(
  root: string,
  rel: string,
  content: string,
  logger: Logger,
): Promise<void> {
  await writeWorkspaceFile(root, rel, content);
  const result = await excludeFromGit(root, rel);
  if (result.ok) {
    logger.info('authored verification file', {
      path: rel,
      excludedLocally: result.excluded,
      keep: 'git add -f to keep it as durable verification',
    });
  } else {
    logger.warn('authored verification file (could not exclude from git — it may show in git status)', {
      path: rel,
      reason: result.reason,
    });
  }
}

/**
 * Write an agent-authored verification file, refusing any path that escapes the workspace
 * root (the compile phase output is untrusted — this is a path-traversal boundary).
 */
async function writeWorkspaceFile(root: string, rel: string, content: string): Promise<void> {
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, rel);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`refusing to write outside the workspace: ${rel}`);
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf8');
}
