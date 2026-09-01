import type { ParsedArgs } from './args';
import type { ComposeOptions } from './compose';
import type { EgressProxy } from '../sandbox';
import type { RunId } from '../domain/ids';
import type { RunConfig } from '../domain/config';
import type { SealGate } from '../compile/seal';
import type { PlanGate } from '../plan/plan-gate';
import type { PhasedStreamSink } from '../agent-cli/stream';
import { resolveModels, type ResolvedModels } from './models';
import { degradedMode } from './independence';
import { mostDegraded, type DegradedMode } from '../domain/degraded';

/**
 * The pure MAPPINGS of the `goaly run` path: the parsed flags + prepared context onto the
 * composition options, and the per-invocation model resolution onto the run's degraded label.
 * No IO — the run body in `run-cmd.ts` keeps the effects (lock, proxy, `composeDeps`, `drive`).
 */

/** The injected gates/sinks the composition needs — the subset of `RunIo` that reaches `composeDeps`. */
export type WiringIo = {
  readonly sealGate?: SealGate;
  readonly planGate?: PlanGate;
  readonly onStreamEvent?: PhasedStreamSink;
  readonly forceStreamTranscript?: boolean;
  readonly quietConsole?: boolean;
};

export type WiringContext = {
  readonly runId: RunId;
  readonly concreteWorkspaceMode: 'git' | 'file';
  readonly autoPinnedBaseline: string | undefined;
  readonly followupSeed: string | undefined;
  readonly egressProxy: EgressProxy | undefined;
};

/**
 * Map the flags onto `composeDeps` options. The OpenAI-compatible bearer token is resolved from
 * its env var (default OPENAI_API_KEY) here, at the composition edge. A keyless local endpoint
 * (ollama) leaves it unset — that's allowed.
 */
export function composeOptions(parsed: ParsedArgs, io: WiringIo, ctx: WiringContext): ComposeOptions {
  const llmApiKey = process.env[parsed.llmApiKeyEnv];
  return {
    harness: parsed.harness,
    models: parsed.models,
    llmProvider: parsed.llmProvider,
    ...(parsed.harnessAutonomy !== undefined ? { harnessAutonomy: parsed.harnessAutonomy } : {}),
    workspaceRoot: parsed.workspace,
    workspaceMode: ctx.concreteWorkspaceMode,
    runId: ctx.runId,
    ...(ctx.followupSeed !== undefined ? { followupSeed: ctx.followupSeed } : {}),
    ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
    ...(llmApiKey !== undefined ? { llmApiKey } : {}),
    ...(parsed.baseline !== undefined
      ? { baseline: parsed.baseline }
      : ctx.autoPinnedBaseline !== undefined
        ? { baseline: ctx.autoPinnedBaseline }
        : {}),
    ...(parsed.verifyDir !== undefined ? { verifyDir: parsed.verifyDir } : {}),
    // Cross-run defect corpus (issue #122) — wiring, like --verify-dir; fail-open downstream.
    defects: parsed.defects,
    ...(parsed.planFile !== undefined ? { planFile: parsed.planFile } : {}),
    logLevel: parsed.logLevel,
    timeouts: parsed.timeouts,
    ...(parsed.maxAgentTurns !== undefined ? { goalyCodeMaxTurns: parsed.maxAgentTurns } : {}),
    sandbox: parsed.sandbox,
    ...(ctx.egressProxy !== undefined ? { egressProxy: ctx.egressProxy } : {}),
    ...(parsed.logFile !== undefined ? { logFile: parsed.logFile } : {}),
    ...(parsed.noLogFile ? { noLogFile: true } : {}),
    ...(io.quietConsole === true ? { noLogConsole: true } : {}),
    ...(parsed.stream ? { stream: true } : {}),
    ...(parsed.explain ? { explain: true } : {}),
    ...(parsed.streamTranscript || io.forceStreamTranscript === true
      ? { streamTranscript: true }
      : {}),
    ...(parsed.streamFile !== undefined ? { streamFile: parsed.streamFile } : {}),
    ...(io.sealGate !== undefined ? { sealGate: io.sealGate } : {}),
    ...(io.planGate !== undefined ? { planGate: io.planGate } : {}),
    ...(io.onStreamEvent !== undefined ? { onStreamEvent: io.onStreamEvent } : {}),
  };
}

/**
 * The per-seam models this run actually uses (issue #125): resolved ONCE — with the LLM provider,
 * so the approver-independence default is applied — and reused for the loud startup notice, the
 * degraded-mode label recorded in the run header, and the cost overlay at the end. One resolution
 * means the log, the header and the price report can never disagree.
 *
 * On a resume the run as a whole is as degraded as its WORST invocation: the earlier iterations
 * already ran with the wiring the header recorded, and a repaired wiring does not undo them. The
 * Driver applies the same rule to the header itself, so the two can never disagree.
 */
export function resolveRunDegraded(
  parsed: ParsedArgs,
  runConfig: RunConfig,
  recordedDegraded: DegradedMode | undefined,
): { resolvedModels: ResolvedModels; degraded: DegradedMode | undefined } {
  const resolvedModels = resolveModels(parsed.models, { llmProvider: parsed.llmProvider });
  const thisInvocationDegraded = degradedMode(resolvedModels, parsed.harness, parsed.llmProvider, {
    generate: runConfig.verifier.kind === 'generate',
    autonomous: runConfig.autonomous,
    approverQuorum: runConfig.approver.quorum,
    ...(resolvedModels.approverModels !== undefined
      ? { approverModels: resolvedModels.approverModels }
      : {}),
  });
  return { resolvedModels, degraded: mostDegraded(recordedDegraded, thisInvocationDegraded) };
}
