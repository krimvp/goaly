/**
 * The Driver's Command performer: one case per Command the pure reducer can request, each resolving
 * to exactly one Event and each fail-closed (an erroring seam becomes a typed FAIL / VETO / crashed
 * event, never a throw out of the loop). Split out of `driver.ts`; `drive()` owns the loop, the
 * write-ahead append, and the best-of-N tournament (which advances `seq` itself).
 */
import type { Command, HarnessRunResult, OrchestratorEvent } from '../domain/events';
import type { RunId } from '../domain/ids';
import { DiffHash, coerceSessionId } from '../domain/ids';
import type { Verdict } from '../domain/verdict';
import type { TokenUsage } from '../domain/usage';
import type { RunProvenance } from '../runlog/runlog';
import type { Verifier } from '../verify/verifier';
import type { Workspace } from '../workspace/workspace';
import type { PhasedStreamSink } from '../agent-cli/stream';
import type { Logger } from '../log/logger';
import { noopLogger } from '../log/logger';
import { errorMessage } from '../util/errors';
import { appendAdjudicatedDefect } from '../defects/corpus';
import type { DriverDeps } from './deps';
import type { Baseline } from './baseline';
import { type LlmTokenMeter, deltaToUsage } from './llm-meter';
import { performRefreeze } from './refreeze';
import { prepareWorkspace, recontractPrepareDeps } from './prepare';
import { classifyContractFault } from './preflight-soundness';

/** Distinct sentinel tree hashes used when the workspace cannot be hashed (kept != each other
 * so a workspace-error iteration never spuriously trips the no-diff detector). */
const SENTINEL_PREV_HASH: DiffHash = DiffHash.parse('0000000');
const SENTINEL_POST_HASH: DiffHash = DiffHash.parse('0000001');

/**
 * Transient-crash absorption for one agent turn: a CRASHED harness run (the CLI exited abnormally —
 * the shape a momentary rate-limit / network / auth blip produces) is retried once after a short
 * backoff BEFORE the crash reaches the reducer. Without it, two quick back-to-back blips burn the
 * whole `stuckCrashThreshold` (default 2) in seconds and abort an otherwise-healthy run. Retrying
 * here is an EFFECT policy (the Driver's job), so the reducer, the stuck detectors, and the run-log
 * semantics are untouched — a crash that survives the retry still counts toward the streak exactly
 * as before. Timeouts are NOT retried (the wall-clock cap is the run's own guard).
 */
const HARNESS_CRASH_RETRIES = 1;
const HARNESS_CRASH_BACKOFF_MS = 2000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export type Performed = {
  event: OrchestratorEvent;
  ladder?: Verifier;
  /** The advanced seq after best-of-N appended its own markers write-ahead (issue #85); else absent. */
  seq?: number;
};

type Cmd<T extends Command['tag']> = Extract<Command, { tag: T }>;

/** Everything one Command performer needs beyond the Command itself, built once per `perform`. */
type PerformCtx = {
  deps: DriverDeps;
  log: Logger;
  /** Meters the LLM spend of the step just performed; see {@link makeMeterStep}. */
  meterStep: (step: string) => TokenUsage | undefined;
  ladder: Verifier | null;
  baseline: Baseline;
  runId: RunId;
  provenance: RunProvenance | undefined;
};

/**
 * @param baseline Owns the run's diff baselines (issue #47/#49). `REQUEST_SIGNOFF` asks it for the
 *   approver's diff — the whole cumulative change under `--delta-verify`, else the workspace's
 *   default active-baseline diff — so the choice of what the approver reviews lives in one place,
 *   not threaded by hand here.
 * @param runId Provenance for a defect-corpus record (issue #122); never used for control flow.
 * @param provenance Successor provenance (`--recontract`, issue #117): widens AND FEEDS the
 *   pre-flight control.
 */
export async function perform(
  command: Command,
  deps: DriverDeps,
  ladder: Verifier | null,
  llmMeter: LlmTokenMeter,
  baseline: Baseline,
  runId: RunId,
  provenance?: RunProvenance,
): Promise<Performed> {
  const log = deps.logger ?? noopLogger;
  const ctx: PerformCtx = {
    deps,
    log,
    meterStep: makeMeterStep(deps, llmMeter, log),
    ladder,
    baseline,
    runId,
    provenance,
  };
  switch (command.tag) {
    case 'COMPILE_PLAN':
      return performCompilePlan(command, ctx);
    case 'REQUEST_PLAN_SEAL':
      return performRequestPlanSeal(command, ctx);
    case 'RUN_WAVE':
      return performRunWave(command, ctx);
    case 'CHECKPOINT_AND_ADVANCE':
      return performCheckpointAndAdvance(ctx);
    case 'COMPILE_VERIFIER':
      return performCompileVerifier(command, ctx);
    case 'REFREEZE_CONTRACT':
      return performRefreezeContract(command, ctx);
    case 'REQUEST_SEAL':
      return performRequestSeal(command, ctx);
    case 'PREPARE_WORKSPACE':
      return performPrepareWorkspace(command, ctx);
    case 'RUN_AGENT':
      return performRunAgent(command, ctx);
    case 'RUN_VERIFIER':
      return performRunVerifier(command, ctx);
    case 'REQUEST_SIGNOFF':
      return performRequestSignoff(command, ctx);
    case 'ADJUDICATE_CONTRACT':
      return performAdjudicateContract(command, ctx);
    case 'RUN_AGENT_BEST_OF':
      // Best-of-N is performed in the main loop (it appends its own write-ahead markers + advances
      // seq), never here. Reaching `perform` with it is a wiring bug — fail closed loudly.
      throw new Error('RUN_AGENT_BEST_OF must be performed by the main loop, not perform()');
  }
}

// Read the LLM spend accrued by THIS command (the loop is sequential, so the meter holds only the
// call(s) just made) and count it against the token budget so the cap governs total spend, not
// just the harness. Returns the per-event usage to persist, or undefined when no LLM call ran.
function makeMeterStep(
  deps: DriverDeps,
  llmMeter: LlmTokenMeter,
  log: Logger,
): PerformCtx['meterStep'] {
  return (step) => {
    const usage = deltaToUsage(llmMeter.take());
    if (usage !== undefined) {
      deps.budget.record(usage.tokens, usage.estimatedTokens ?? 0, {
        unknownCalls: usage.unknownCalls,
      });
      // Loud, not silent: an unaccounted LLM call means the token cap can't see this spend, so
      // wall-clock is the real backstop for it. Surfaced at warn level rather than read as zero.
      if (usage.unknownCalls > 0) {
        log.warn('llm step reported no token usage — token budget is partly blind, wall-clock governs', {
          step,
          unknownCalls: usage.unknownCalls,
        });
      }
    }
    return usage;
  };
}

/** The optional per-event `llm` field, omitted (not `undefined`) when no LLM call ran. */
function llmField(llm: TokenUsage | undefined): { llm?: TokenUsage } {
  return llm !== undefined ? { llm } : {};
}

async function performCompilePlan(
  command: Cmd<'COMPILE_PLAN'>,
  { deps, meterStep }: PerformCtx,
): Promise<Performed> {
  // Author the frozen plan (issue #48). A planner error / unparseable / over-`--max-phases` plan
  // is a typed, fail-closed PLAN_FAILED — never a skipped decomposition. The plan is FROZEN by the
  // planner (its `planHash` set), mirroring how the compiler freezes the contract.
  try {
    if (deps.planner === undefined) {
      throw new Error('phased run requires a planner, but none was configured');
    }
    const plan = await deps.planner.plan(command.config, command.feedback);
    if (plan.phases.length > command.config.maxPhases) {
      throw new Error(
        `plan has ${plan.phases.length} phases, exceeding --max-phases ${command.config.maxPhases}`,
      );
    }
    return { event: { tag: 'PLAN_COMPILED', plan, ...llmField(meterStep('plan')) } };
  } catch (e) {
    return {
      event: { tag: 'PLAN_FAILED', reason: errorMessage(e), ...llmField(meterStep('plan')) },
    };
  }
}

async function performRequestPlanSeal(
  command: Cmd<'REQUEST_PLAN_SEAL'>,
  { deps }: PerformCtx,
): Promise<Performed> {
  // No plan gate ⇒ fail closed to a reject (the run never silently auto-approves an unsealed plan).
  if (deps.planGate === undefined) {
    return {
      event: {
        tag: 'PLAN_SEAL_DECIDED',
        decision: { kind: 'reject', reason: 'no plan Seal gate configured for a phased run' },
      },
    };
  }
  const decision = await deps.planGate.approvePlan(command.plan);
  return { event: { tag: 'PLAN_SEAL_DECIDED', decision } };
}

async function performRunWave(
  command: Cmd<'RUN_WAVE'>,
  { deps, log }: PerformCtx,
): Promise<Performed> {
  // EXPERIMENTAL parallel waves: the whole fan-out + merge + re-verify happens behind the
  // injected seam; the reducer sees ONE WAVE_RAN. Fail-closed on every failure shape: a missing
  // runner or a thrown runner DOWNGRADES every wave member to the classic sequential phase
  // (`unmerged`) — never a crash, never a skipped phase, never an unverified merge.
  try {
    if (deps.wave === undefined) {
      throw new Error('parallel waves require a wave runner, but none was configured');
    }
    const result = await deps.wave.run(command.phases, deps.interrupted);
    log.info('wave completed', {
      phases: command.phases.length,
      merged: result.outcomes.filter((o) => o.kind === 'merged').length,
    });
    return { event: { tag: 'WAVE_RAN', outcomes: result.outcomes, tree: result.tree } };
  } catch (e) {
    log.warn('wave runner failed — downgrading every wave member to sequential', {
      reason: errorMessage(e),
    });
    const tree = await deps.workspace.checkpoint();
    return {
      event: {
        tag: 'WAVE_RAN',
        outcomes: command.phases.map((p) => ({
          kind: 'unmerged' as const,
          index: p.index,
          reason: `wave fan-out unavailable: ${errorMessage(e)}`,
        })),
        tree,
      },
    };
  }
}

async function performCheckpointAndAdvance({ deps }: PerformCtx): Promise<Performed> {
  // Between-phase checkpoint (issue #47): snapshot the tree (advancing the diff baseline so the
  // next phase diffs only its own delta) and return the tree on PHASE_ADVANCED — which both drives
  // the reducer's advance AND lets resume reconstruct the baseline (see replay). Fail-closed: a
  // failed snapshot throws to the outer loop, resolving to a crashed/ABORTED run.
  const tree = await deps.workspace.checkpoint();
  return { event: { tag: 'PHASE_ADVANCED', tree } };
}

async function performCompileVerifier(
  command: Cmd<'COMPILE_VERIFIER'>,
  { deps, meterStep }: PerformCtx,
): Promise<Performed> {
  try {
    const contract = await deps.compiler.compile(command.config, command.feedback);
    return {
      event: { tag: 'CONTRACT_COMPILED', contract, ...llmField(meterStep('compile')) },
      ladder: deps.makeLadder(contract),
    };
  } catch (e) {
    return {
      event: { tag: 'COMPILE_FAILED', reason: errorMessage(e), ...llmField(meterStep('compile')) },
    };
  }
}

async function performRefreezeContract(
  command: Cmd<'REFREEZE_CONTRACT'>,
  { deps, log }: PerformCtx,
): Promise<Performed> {
  // Manual-edit refreeze (ADR 0016): re-read the authored files, re-pin their hashes, apply
  // the operator's field patch, re-freeze. No LLM call, no metering. A fresh ladder is
  // MANDATORY: RUN_VERIFIER prefers the cached ladder, which would otherwise still pin the
  // OLD generatedFiles hashes and red every iteration via the integrity guard.
  const result = await performRefreeze(deps.workspace, command.contract, command.patch);
  if (result.ok) {
    log.info('contract refrozen from operator edits', {
      contractHash: result.contract.contractHash,
    });
    return {
      event: { tag: 'CONTRACT_COMPILED', contract: result.contract },
      ladder: deps.makeLadder(result.contract),
    };
  }
  // Fail-closed and LOUD: the failure lands in the write-ahead log as COMPILE_FAILED, riding
  // the existing bounded compile-retry machinery — the recovery recompile is re-presented at
  // the Seal, never executed unseen.
  return { event: { tag: 'COMPILE_FAILED', reason: result.reason } };
}

async function performRequestSeal(
  command: Cmd<'REQUEST_SEAL'>,
  { deps }: PerformCtx,
): Promise<Performed> {
  const decision = await deps.seal.approveContract(command.contract);
  return { event: { tag: 'SEAL_DECIDED', decision } };
}

async function performPrepareWorkspace(
  command: Cmd<'PREPARE_WORKSPACE'>,
  { deps, meterStep, provenance }: PerformCtx,
): Promise<Performed> {
  // One-time setup (Fix #1) + deterministic pre-flight (Fix #2), both fail-closed inside
  // prepareWorkspace. Runs once after SEAL and before iteration 1; the reducer routes the
  // typed outcome (proceed / setup-failed / contract-unsound). The pre-flight may make ONE
  // read-only LLM call to classify a red as broken-verifier vs honest-red — metered below.
  const result = await prepareWorkspace(
    {
      workspace: deps.workspace,
      installMissingTools: command.installMissingTools,
      setupAuthored: command.setupAuthored,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      ...(deps.prepareTimeouts !== undefined ? { timeouts: deps.prepareTimeouts } : {}),
      ...(deps.prepareLlm !== undefined ? { llm: deps.prepareLlm } : {}),
      ...recontractPrepareDeps(provenance),
    },
    command.contract,
  );
  return {
    event: {
      tag: 'WORKSPACE_PREPARED',
      prepared: result.prepared,
      setupRan: result.setupRan,
      ...llmField(meterStep('preflight')),
    },
  };
}

async function performRunAgent(
  command: Cmd<'RUN_AGENT'>,
  { deps, log }: PerformCtx,
): Promise<Performed> {
  try {
    const prevDiffHash = await deps.workspace.diffHash();
    // Snapshot .gitignore around the agent run so a NEW ignore entry appearing mid-run is loud
    // diffHash honours .gitignore, so a worker that adds one can hide changes from
    // stuck-detection. We warn rather than block — it may be legitimate — but never go silent.
    const prevGitignore = await deps.workspace.fileHash('.gitignore');
    const run = await runHarnessWithRetry(command, deps, log);
    // An estimated harness count (issue #24) still counts against the cap, marked so the
    // snapshot/report can show it as approximate.
    const estimated =
      run.tokenSource === 'estimated' && run.tokensUsed !== undefined ? run.tokensUsed : 0;
    deps.budget.record(run.tokensUsed, estimated);
    // Loud, not silent: a harness that surfaces no usage AND couldn't be estimated leaves
    // the token cap blind for this iteration — wall-clock is the only backstop. Mark it.
    if (run.tokensUsed === undefined) {
      log.warn('harness reported no token usage — token budget is blind, wall-clock governs', {
        status: run.status,
      });
    }
    const diffHash = await deps.workspace.diffHash();
    const postGitignore = await deps.workspace.fileHash('.gitignore');
    if (prevGitignore !== postGitignore) {
      log.warn('.gitignore changed during the agent run — changes under new ignores are hidden from diffHash', {});
    }
    const budget = deps.budget.snapshot();
    return { event: { tag: 'AGENT_RAN', run, prevDiffHash, diffHash, budget } };
  } catch (e) {
    return workspaceErrorRan(command, deps, e);
  }
}

/**
 * Fail-closed: a workspace (diffHash) failure must not crash the loop. Synthesize a crashed run
 * with DISTINCT sentinel hashes (so no-diff doesn't false-fire) and a valid, persistable AGENT_RAN
 * event; the frozen verifier then runs and the loop proceeds toward a clean ABORTED/FAILED rather
 * than an unhandled rejection.
 */
function workspaceErrorRan(command: Cmd<'RUN_AGENT'>, deps: DriverDeps, e: unknown): Performed {
  const budget = deps.budget.snapshot();
  return {
    event: {
      tag: 'AGENT_RAN',
      run: {
        output: `workspace error: ${errorMessage(e)}`,
        sessionId: command.sessionId ?? coerceSessionId(undefined, 'workspace-error'),
        status: 'crashed',
      },
      prevDiffHash: SENTINEL_PREV_HASH,
      diffHash: SENTINEL_POST_HASH,
      budget,
    },
  };
}

/** One agent turn with the transient-crash absorption described at {@link HARNESS_CRASH_RETRIES}. */
async function runHarnessWithRetry(
  command: Cmd<'RUN_AGENT'>,
  deps: DriverDeps,
  log: Logger,
): Promise<HarnessRunResult> {
  // Tap the agent run's turns (phase `agent`) when a stream sink is wired. The StreamTap
  // inside the adapter guards the sink, so a throwing consumer never affects the run.
  const onEvent =
    deps.onStreamEvent !== undefined
      ? (event: Parameters<PhasedStreamSink>[1]): void => deps.onStreamEvent?.('agent', event)
      : undefined;
  let run = await deps.harness.run(command.prompt, command.sessionId, onEvent);
  // Transient-crash absorption: retry a crashed turn once after a short backoff, accounting
  // the abandoned attempt's spend first (usually none — a crash rarely reports usage). A
  // crash that survives the retry flows to the reducer unchanged (stuck detection governs).
  const sleep = deps.sleep ?? realSleep;
  for (
    let retry = 0;
    run.status === 'crashed' && retry < HARNESS_CRASH_RETRIES && deps.interrupted?.() !== true;
    retry++
  ) {
    const abandonedEstimate =
      run.tokenSource === 'estimated' && run.tokensUsed !== undefined ? run.tokensUsed : 0;
    deps.budget.record(run.tokensUsed, abandonedEstimate);
    log.warn('harness crashed — retrying once after backoff (transient blips must not burn the crash streak)', {
      backoffMs: HARNESS_CRASH_BACKOFF_MS,
    });
    await sleep(HARNESS_CRASH_BACKOFF_MS);
    run = await deps.harness.run(command.prompt, command.sessionId, onEvent);
  }
  return run;
}

async function performRunVerifier(
  command: Cmd<'RUN_VERIFIER'>,
  { deps, ladder, meterStep }: PerformCtx,
): Promise<Performed> {
  const active = ladder ?? deps.makeLadder(command.contract);
  const verdict = await runVerifierFailClosed(
    active,
    deps.workspace,
    command.contract.goal,
    command.contract.rubric,
  );
  return { event: { tag: 'VERIFIED', verdict, ...llmField(meterStep('verify')) } };
}

async function performRequestSignoff(
  command: Cmd<'REQUEST_SIGNOFF'>,
  { deps, baseline, meterStep }: PerformCtx,
): Promise<Performed> {
  try {
    // The Baseline module decides what the approver reviews: the WHOLE cumulative change under
    // --delta-verify (the guard), else the default active-baseline diff (behavior unchanged).
    const diff = await baseline.approverDiff();
    const approval = await deps.approver.review({
      goal: command.goal,
      rubric: command.rubric,
      diff,
      verdicts: command.verdicts,
    });
    return { event: { tag: 'SIGNOFF_DECIDED', approval, ...llmField(meterStep('approve')) } };
  } catch (e) {
    // Fail-closed: an approver that errors is treated as a veto, never a green.
    return {
      event: {
        tag: 'SIGNOFF_DECIDED',
        approval: { veto: true, reason: `approver error: ${errorMessage(e)}` },
        ...llmField(meterStep('approve')),
      },
    };
  }
}

/**
 * In-loop contract-fault adjudication (issue #116): ONE read-only LLM call, at most once per run,
 * asking whether the frozen bar the worker keeps failing is itself unsatisfiable. The run is
 * already terminating, so EVERY failure mode here fail-closes to `defective: false` — which the
 * reducer folds into today's repeat-failure abort text, marked CONTRACT_ADJUDICATED_SOUND.
 *
 * Provider: the already-wired `prepareLlm` — the JUDGE model, deliberately not the compiler model
 * that authored the (possibly defective) bar, so the review is not purely self-review.
 */
async function performAdjudicateContract(
  command: Cmd<'ADJUDICATE_CONTRACT'>,
  { deps, log, baseline, runId, meterStep }: PerformCtx,
): Promise<Performed> {
  if (deps.prepareLlm === undefined) {
    return {
      event: { tag: 'CONTRACT_ADJUDICATED', defective: false, reason: 'no adjudicator configured' },
    };
  }
  const diff = await advisoryDiff(baseline, log);
  const verdict = await classifyContractFault(
    { llm: deps.prepareLlm, ...(deps.logger !== undefined ? { logger: deps.logger } : {}) },
    command.contract,
    command.signature,
    diff,
    command.repeatCount,
  );
  const llm = meterStep('adjudicate');
  // The ONE sanctioned write to the cross-run defect corpus (issue #122): a positive
  // adjudication, and nothing else, teaches the compiler. Everything recorded is goaly's own
  // (the adjudicator's generalized pattern + facts derived from the FROZEN contract) and the
  // helper never throws, so this can neither fail a run nor carry worker text.
  if (deps.defectCorpus !== undefined) {
    await appendAdjudicatedDefect(
      deps.defectCorpus,
      verdict,
      { contract: command.contract, runId, now: deps.clock.now() },
      deps.logger,
    );
  }
  return {
    event: {
      tag: 'CONTRACT_ADJUDICATED',
      defective: verdict.defective,
      reason: verdict.reason,
      ...(verdict.pattern !== undefined ? { pattern: verdict.pattern } : {}),
      ...(verdict.assertionShape !== undefined ? { assertionShape: verdict.assertionShape } : {}),
      ...llmField(llm),
    },
  };
}

/** Advisory input only: a diff we cannot read weakens the prompt, it must never fail the run. */
async function advisoryDiff(baseline: Baseline, log: Logger): Promise<string> {
  try {
    return await baseline.approverDiff();
  } catch (e) {
    log.debug('contract adjudication: could not read the diff (proceeding without it)', {
      reason: errorMessage(e),
    });
    return '';
  }
}

/** A verifier that throws is a malformed grader; treat it as a hard fail, never a green. */
async function runVerifierFailClosed(
  verifier: Verifier,
  workspace: Workspace,
  goal: string,
  rubric: string,
): Promise<Verdict> {
  try {
    return await verifier.verify(workspace, goal, rubric);
  } catch (e) {
    return { pass: false, confidence: 1, detail: `verifier error (fail-closed): ${errorMessage(e)}` };
  }
}
