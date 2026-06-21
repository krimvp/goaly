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
import { AutoContractGate, HumanContractGate } from '../compile/gates';
import { GitWorkspace } from '../workspace/git-workspace';
import { FileRunLog } from '../runlog/file-runlog';
import { ClaudeCodeAdapter } from '../harness/claude-code';
import { CodexAdapter } from '../harness/codex';
import { DroidAdapter } from '../harness/droid';
import { SystemClock } from '../driver/clock';
import { SystemBudgetMeter } from '../driver/budget';
import { LlmTokenMeter, meterLlm } from '../driver/llm-meter';
import { buildLogger, type FileLogOptions } from '../log/build';
import type { Logger, LogLevel } from '../log/logger';
import type { LogFs } from '../log/sinks';
import { CliLlmProvider } from '../llm/cli-provider';
import { AgentCliLlmProvider } from '../llm/agent-cli-provider';
import { codexCodec } from '../agent-cli/codex-codec';
import { droidCodec } from '../agent-cli/droid-codec';
import type { AgentEventSink, PhasedStreamSink, StreamPhase } from '../agent-cli/stream';
import { makeStreamRenderer, streamLogFields } from './stream-render';
import { resolveModels, type ModelSelection } from './models';
import { independenceWarnings } from './independence';
import type { HarnessChoice, LlmProviderChoice, StepTimeouts } from './args';

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
};

/** The orchestrator's own state directory name, kept out of stuck-detection hashing. */
export const STATE_DIR = '.goaly';

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
  const workspace = new GitWorkspace(options.workspaceRoot);
  const stateDir = options.stateDir ?? path.join(options.workspaceRoot, STATE_DIR);
  const logger = options.logger ?? buildRunLogger(options, stateDir);
  const streamSink = buildStreamSink(options, logger);

  // Warn loudly when the "two independent keys" collapse onto one model (finding C3). Skipped when
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
        }),
      llmMeter,
    );

  return {
    compiler: new AgentCompiler({
      llm: llmFor(models.compiler, 'compile'),
      writeFile: (rel, content) => writeWorkspaceFile(options.workspaceRoot, rel, content),
    }),
    gateA: config.autonomous
      ? new AutoContractGate()
      : new HumanContractGate({ allowRevise: config.maxGateARevisions > 0 }),
    harness: makeHarness(options.harness, models.harness, timeouts.harnessMs),
    makeLadder: (contract) => buildLadder(contract, llmFor(models.judge, 'judge'), timeouts.verifyMs),
    approver: new AgentApprover({ llm: llmFor(models.approver, 'approve') }),
    workspace,
    clock,
    budget: new SystemBudgetMeter(config.budget, clock),
    llmMeter,
    runlog: new FileRunLog(path.join(stateDir, options.runId)),
    logger,
    ...(streamSink !== undefined ? { onStreamEvent: streamSink } : {}),
  };
}

/**
 * Assemble the one phase-tagged stream sink (issue #23) that fans every event out to the three
 * driver-side consumer surfaces — the `--stream` live stderr view, the diagnostics logger (at
 * `debug`, respecting `--log-level`), and any embedder subscription. Returns `undefined` when no
 * consumer is active so a default run builds NO taps and pays zero streaming overhead. Each branch
 * is guarded: a throwing consumer can never crash a run or starve the others (fail-closed).
 */
function buildStreamSink(options: ComposeOptions, logger: Logger): PhasedStreamSink | undefined {
  const renderer = options.stream === true ? makeStreamRenderer(streamRendererOpts(options)) : undefined;
  const routeToLog = (options.logLevel ?? 'info') === 'debug';
  const embedder = options.onStreamEvent;
  if (renderer === undefined && !routeToLog && embedder === undefined) return undefined;

  return (phase, event) => {
    if (renderer !== undefined) renderer(phase, event);
    if (routeToLog) logger.debug('stream', streamLogFields(phase, event));
    if (embedder !== undefined) {
      try {
        embedder(phase, event);
      } catch {
        /* an embedder subscription must never crash the run */
      }
    }
  };
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
 * `codex`/`droid` wrap their agentic CLI in a one-shot READ-ONLY mode (codex `--sandbox read-only`,
 * droid's default no-`--auto` exec) so a judge / approver / compiler can use that tool's model
 * without ever mutating the working tree it is judging. The resolved per-step model is threaded in.
 */
export function makeLlmProvider(
  choice: LlmProviderChoice,
  model: string | undefined,
  opts: { onEvent?: AgentEventSink; timeoutMs?: number } = {},
): LlmProvider {
  const timeout = opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};
  const stream = opts.onEvent !== undefined ? { onEvent: opts.onEvent } : {};
  switch (choice) {
    case 'claude':
      return new CliLlmProvider({ ...(model !== undefined ? { model } : {}), ...timeout, ...stream });
    case 'codex':
      return new AgentCliLlmProvider({
        name: codexCodec.name,
        command: codexCodec.command,
        extractor: codexCodec.fieldExtractor,
        buildArgs: (prompt) => codexCompletionArgs(prompt, model),
        ...timeout,
        ...(opts.onEvent !== undefined
          ? { onEvent: opts.onEvent, streamExtractor: codexCodec.streamExtractor }
          : {}),
      });
    case 'droid':
      return new AgentCliLlmProvider({
        name: droidCodec.name,
        command: droidCodec.command,
        extractor: droidCodec.fieldExtractor,
        buildArgs: (prompt) => droidCompletionArgs(prompt, model),
        ...timeout,
        ...(opts.onEvent !== undefined
          ? { onEvent: opts.onEvent, streamExtractor: droidCodec.streamExtractor }
          : {}),
      });
  }
}

/** codex one-shot completion argv — READ-ONLY (`--sandbox read-only`), model before the prompt. */
export function codexCompletionArgs(prompt: string, model: string | undefined): string[] {
  return codexCodec.readonlyArgs({ prompt, model, stream: false });
}

/** droid one-shot completion argv — READ-ONLY (no `--auto`, droid's `exec` default cannot edit). */
export function droidCompletionArgs(prompt: string, model: string | undefined): string[] {
  return droidCodec.readonlyArgs({ prompt, model, stream: false });
}

/**
 * Turn the frozen contract's ordered rungs into a Ladder of concrete verifiers. An optional
 * `verifyTimeoutMs` caps each deterministic command (a timeout is a fail-closed FAIL); the model
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
  // Pin compiler-authored verification files (finding C1): a guard runs FIRST and fails closed if
  // any frozen generated file was modified/removed, so the worker can't rewrite the bar the frozen
  // command measures. No generated files ⇒ no guard (the common --verify-cmd path is unchanged).
  if (contract.generatedFiles.length > 0) {
    rungs.unshift(new GeneratedFilesGuard(contract.generatedFiles));
  }
  return new Ladder(rungs);
}

function makeHarness(
  choice: HarnessChoice,
  model: string | undefined,
  timeoutMs?: number,
): HarnessAdapter {
  const opts = {
    ...(model !== undefined ? { model } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  switch (choice) {
    case 'claude-code':
      return new ClaudeCodeAdapter(opts);
    case 'codex':
      return new CodexAdapter(opts);
    case 'droid':
      return new DroidAdapter(opts);
    case 'fake':
      return new NoopHarness();
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
