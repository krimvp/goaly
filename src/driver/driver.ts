import type { Command, OrchestratorEvent, RunOutcome } from '../domain/events';
import { OrchestratorEvent as OrchestratorEventSchema } from '../domain/events';
import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { ContractHash, RunId } from '../domain/ids';
import { DiffHash, coerceSessionId } from '../domain/ids';
import type { Verdict } from '../domain/verdict';
import type { TokenUsage, UsageReport } from '../domain/usage';
import { isTerminal, iterationCount, type OrchestratorState } from '../orchestrator/state';
import { initial, step } from '../orchestrator/step';
import { replay } from '../runlog/replay';
import type { VerifierCompiler } from '../compile/compiler';
import type { SealGate } from '../compile/seal';
import type { Planner } from '../plan/planner';
import type { PlanGate } from '../plan/plan-gate';
import type { HarnessAdapter } from '../harness/adapter';
import type { Verifier } from '../verify/verifier';
import type { Approver } from '../verify/approver';
import type { LlmProvider } from '../llm/provider';
import type { Workspace } from '../workspace/workspace';
import type { Clock } from './clock';
import type { BudgetMeter } from './budget';
import { LlmTokenMeter, deltaToUsage } from './llm-meter';
import { summarizeUsage } from '../runlog/usage';
import type { RunLog } from '../runlog/runlog';
import { noopLogger, type Logger } from '../log/logger';
import type { PhasedStreamSink } from '../agent-cli/stream';
import { errorMessage } from '../util/errors';
import { prepareWorkspace, type PrepareTimeouts } from './prepare';

/** Distinct sentinel tree hashes used when the workspace cannot be hashed (kept != each other
 * so a workspace-error iteration never spuriously trips the no-diff detector). */
const SENTINEL_PREV_HASH: DiffHash = DiffHash.parse('0000000');
const SENTINEL_POST_HASH: DiffHash = DiffHash.parse('0000001');

/**
 * Everything the Driver needs to perform effects. The ladder is built once from the frozen
 * contract via `makeLadder` (the composition root knows how to assemble deterministic +
 * judge rungs); the Driver treats it as an opaque Verifier.
 */
export type DriverDeps = {
  compiler: VerifierCompiler;
  seal: SealGate;
  /**
   * The planner seam (issue #48), used ONLY by a phased run's PLAN phase. Optional: a classic
   * single-contract run never emits COMPILE_PLAN, so it needs no planner. When a phased run somehow
   * has none, the PLAN command fails closed (a typed PLAN_FAILED).
   */
  planner?: Planner;
  /** The plan Seal gate (issue #48); like {@link planner}, used only by a phased run. */
  planGate?: PlanGate;
  harness: HarnessAdapter;
  makeLadder: (contract: CompiledContract) => Verifier;
  approver: Approver;
  workspace: Workspace;
  clock: Clock;
  budget: BudgetMeter;
  /**
   * Meters LLM-step token spend (compiler / judge / approver). The composition root wraps each
   * workflow-step provider with `meterLlm` feeding this one meter; the Driver reads it per command
   * to attribute spend. Optional: when absent, LLM spend is simply reported as "unknown".
   */
  llmMeter?: LlmTokenMeter;
  runlog: RunLog;
  /**
   * Per-step kill-timeouts for the one-time prepare phase (Fix #1 setup + Fix #2 pre-flight). Pure
   * wiring — never enters the frozen contract; absent fields fall back to defaults/unbounded.
   */
  prepareTimeouts?: PrepareTimeouts;
  /**
   * The (read-only) LLM provider the pre-flight uses to classify a failing deterministic rung as a
   * broken frozen verifier (→ CONTRACT_UNSOUND) vs. an honest red (→ proceed). Metered like the other
   * LLM steps. Optional: when absent, pre-flight never aborts on a red — it proceeds and lets the
   * runtime ladder + stuck detection govern (see `prepare.ts`).
   */
  prepareLlm?: LlmProvider;
  /**
   * Diagnostic logger (the Driver is the orchestration choke-point: it sees every Command, Event,
   * verdict and decision). Optional and defaults to a no-op so logging never affects control flow,
   * never touches the filesystem in tests, and is pure wiring — it has no bearing on the contract,
   * the run log, or replay.
   */
  logger?: Logger;
  /**
   * Optional streaming sink (issue #23): receives the agent run's intermediate turns as
   * phase-tagged {@link PhasedStreamSink} events (phase `agent`). The composition root fans this
   * out to the `--stream` live view, the debug logger, and any embedder subscription, and wires
   * the same sink into the LLM-step providers. Pure observability — events are NEVER written to
   * the replay log, so resume stays a fold over `OrchestratorEvent` only.
   */
  onStreamEvent?: PhasedStreamSink;
};

export type DriveOptions = {
  /** Resume from an existing run log instead of starting fresh. */
  resume?: boolean;
};

/**
 * The Driver: performs the Commands the pure reducer requests, feeds the resulting Events
 * back, and persists every event write-ahead. The ONLY component that touches the clock,
 * the budget, processes, or the filesystem.
 */
export async function drive(
  deps: DriverDeps,
  config: RunConfig,
  runId: RunId,
  options: DriveOptions = {},
): Promise<RunOutcome> {
  let state: OrchestratorState;
  let commands: Command[];
  let seq: number;
  let ladder: Verifier | null = null;
  let contractHash: ContractHash | null = null;
  const log = deps.logger ?? noopLogger;
  const llmMeter = deps.llmMeter ?? new LlmTokenMeter();
  // Capture the run's START baseline BEFORE any internal checkpoint (or the resume re-point below)
  // advances it. On a FRESH run this is `--baseline`/HEAD as compose applied it. On --resume it is
  // whatever compose re-applied THIS invocation: `--baseline` is not persisted in the log, so a resumed
  // run that omits the flag falls back to HEAD here (the approver then reviews HEAD→now instead of
  // ref→now). That is safe for what delta-verify guards against — goaly makes no commits mid-run, so
  // every iteration's work is post-HEAD and stays fully in the approver's view; only pre-existing
  // ref→HEAD committed code drops out, which the deterministic rungs cover anyway. Phased runs instead
  // re-pin from the log below. Under --delta-verify the terminal Sign-off approver is pinned to a CUMULATIVE baseline —
  // `approverBaseline` — so it reviews the whole change a per-iteration judge would never see at once
  // (the cumulative guard, issue #49). It starts at the run-start baseline and, in a --phased run,
  // advances to each PHASE boundary (so the approver reviews that phase's whole cumulative diff) while
  // per-iteration delta checkpoints advance only the judge's (workspace) baseline. It never advances
  // on those per-iteration checkpoints — that is what keeps the approver cumulative.
  const runStartBaseline = deps.workspace.currentBaseline();
  let approverBaseline = runStartBaseline;

  log.info(options.resume === true ? 'resuming run' : 'starting run', {
    runId,
    resume: options.resume === true,
  });

  if (options.resume === true) {
    const resumed = await resume(deps, config);
    state = resumed.state;
    commands = resumed.commands;
    seq = resumed.seq;
    contractHash = resumed.contractHash;
    if (resumed.contract !== null) ladder = deps.makeLadder(resumed.contract);
    // Re-point the diff baseline at the last internal checkpoint (issue #47) so a resumed run keeps
    // the same small-diff baseline it had advanced to. This OVERRIDES any `--baseline` set at compose
    // time: the logged checkpoint reflects real progress and is the authoritative resume state.
    if (resumed.baseline !== null) deps.workspace.setBaseline(resumed.baseline);
    // Re-pin the approver's cumulative baseline to the current phase's start (issue #49). Null ⇒ no
    // phase has advanced yet (or a classic run) ⇒ keep the run-start baseline captured above.
    if (resumed.phaseBaseline !== null) approverBaseline = resumed.phaseBaseline;
  } else {
    [state, commands] = initial(config);
    seq = 0;
    await deps.runlog.writeHeader({ runId, startedAt: deps.clock.now(), config });
  }

  try {
    while (!isTerminal(state)) {
      if (commands.length !== 1) {
        throw new Error(
          `driver invariant: non-terminal state ${state.tag} emitted ${commands.length} commands (expected 1)`,
        );
      }
      const command = commands[0]!;
      log.debug('perform command', { command: command.tag, state: state.tag });

      // Perform the effect (the only place anything stochastic/IO happens), then build the
      // Event. `ladder` is created at COMPILE and reused for every RUN_VERIFIER.
      const performed = await perform(
        command,
        deps,
        ladder,
        llmMeter,
        config.deltaVerify ? approverBaseline : undefined,
      );
      const event = OrchestratorEventSchema.parse(performed.event); // parse at the reducer's edge
      if (performed.ladder !== undefined) ladder = performed.ladder;
      if (event.tag === 'CONTRACT_COMPILED') contractHash = event.contract.contractHash;
      logEvent(log, command, event);

      // step() is pure — computing it before persisting is side-effect-free and lets us log the
      // resulting state tag in the same write-ahead entry. Durability is AT-LEAST-ONCE: a crash
      // after `perform` but before this `append` re-runs exactly that one effect on resume (the
      // harness's session resume makes RUN_AGENT idempotent); we accept one repeated effect over
      // a lost one.
      const [next, nextCommands] = step(state, event);
      seq += 1;
      await deps.runlog.append({
        runId,
        seq,
        ts: deps.clock.now(),
        contractHash,
        event,
        stateTagAfter: next.tag,
      });

      log.debug('transition', { from: state.tag, to: next.tag, seq });
      state = next;
      commands = nextCommands;

      // Advance the approver's CUMULATIVE baseline at each --phased boundary (issue #49): from the
      // next phase on, Sign-off reviews that phase's whole change (against its start), exactly as a
      // non-delta phased run does. Per-iteration delta checkpoints (below) never touch this — only
      // phase boundaries do — which is what keeps the approver cumulative within a phase.
      if (event.tag === 'PHASE_ADVANCED') approverBaseline = event.tree;

      // Delta-verify (issue #49): after each CONTINUATION iteration — a ladder fail (`VERIFIED` →
      // `RUN_AGENT`) or a Sign-off veto (`SIGNOFF_DECIDED` → `RUN_AGENT`) that loops back to the
      // agent — take an internal checkpoint so the NEXT iteration's judge sees only its own delta.
      // (The first `RUN_AGENT` is excluded: its predecessor is CONTRACT_COMPILED/SEALED, not a
      // verify/Sign-off event.) The cumulative keys are untouched: deterministic rungs always run on
      // the full working tree, and the terminal approver is pinned to `approverBaseline`. This runs
      // in a --phased run too: it advances only the judge's (workspace) baseline WITHIN a phase, while
      // the approver baseline advances only at phase boundaries (above) — so the two compose cleanly.
      if (
        config.deltaVerify &&
        (event.tag === 'VERIFIED' || event.tag === 'SIGNOFF_DECIDED') &&
        commands[0]?.tag === 'RUN_AGENT'
      ) {
        // Snapshot the baseline BEFORE checkpointing: `recordCheckpoint` calls `workspace.checkpoint()`
        // which advances the in-memory baseline *before* it appends the CHECKPOINTED marker, so if that
        // append throws we must roll the baseline back (below) — otherwise the live judge keeps seeing
        // the delta while the unlogged advance silently diverges from what `--resume` reconstructs.
        const priorBaseline = deps.workspace.currentBaseline();
        try {
          const cp = await recordCheckpoint(
            { workspace: deps.workspace, runlog: deps.runlog, clock: deps.clock, logger: log },
            runId,
            seq,
            contractHash,
            next.tag,
          );
          seq = cp.seq;
        } catch (e) {
          // Fail-closed fallback (#4): a failed checkpoint must NEVER crash the run or leave an empty
          // baseline. Roll the baseline back to its pre-checkpoint value (checkpoint() may have already
          // advanced it before the append threw) so the judge genuinely falls back to the larger
          // cumulative diff this iteration — never the "nothing to review" empty diff that would read as
          // a false green — and the live run frames the same diff a resume (which never saw a
          // CHECKPOINTED) would reconstruct.
          deps.workspace.setBaseline(priorBaseline);
          log.warn('delta-verify checkpoint failed; judge will see the full diff this iteration', {
            reason: errorMessage(e),
          });
        }
      }
    }
  } catch (e) {
    // Last-resort safety net: every effectful seam is individually fail-closed, but an unexpected
    // throw (corrupt log on append, invalid transition) must still resolve to a terminal outcome
    // rather than reject — so the caller always gets a RunOutcome.
    log.error('driver error (fail-closed → ABORTED)', { reason: errorMessage(e) });
    const usage = await buildUsageReport(deps);
    return {
      status: 'ABORTED',
      reason: `driver error: ${errorMessage(e)}`,
      iterations: iterationCount(state),
      contractHash: contractHash ?? null,
      runId,
      ...(usage !== undefined ? { usage } : {}),
    };
  }

  const outcome = buildOutcome(state, runId);
  const usage = await buildUsageReport(deps);
  log.info('run finished', {
    status: outcome.status,
    iterations: outcome.iterations,
    ...(usage !== undefined ? { tokensTotal: usage.total.tokens } : {}),
  });
  return { ...outcome, ...(usage !== undefined ? { usage } : {}) };
}

/** The Driver capabilities {@link recordCheckpoint} needs (a narrow slice of {@link DriverDeps}). */
export type CheckpointDeps = Pick<DriverDeps, 'workspace' | 'runlog' | 'clock'> & {
  logger?: Logger;
};

/**
 * Take an internal workspace checkpoint and record it write-ahead (issue #47). The Driver effect is:
 * snapshot the working tree into a git TREE (no user-visible commit, no HEAD/branch move — see
 * {@link Workspace.checkpoint}), adopt it as the new diff baseline, and append a `CHECKPOINTED` event
 * to the run log so `--resume` reconstructs the advanced baseline by replaying the log.
 *
 * This is the PRIMITIVE; the *policy* of when to checkpoint is the caller's. Two callers use it:
 * phased runs checkpoint between phases (issue #46/#48), and `--delta-verify` checkpoints after each
 * continuation iteration (issue #49) so the next iteration's judge sees only its own delta. Wiring it
 * into the per-iteration loop is safe ONLY because delta-verify pins the terminal Sign-off approver to
 * the run's START baseline — otherwise advancing the baseline mid-run would shrink what Sign-off
 * reviews. The reducer is untouched: a `CHECKPOINTED` event is a baseline marker, never fed to
 * `step()`. Returns the next `seq` and the snapshotted tree SHA. Fail-closed: a checkpoint snapshot
 * that throws propagates to the caller, which under --delta-verify degrades to the full diff for that
 * iteration (never a silently empty baseline).
 */
export async function recordCheckpoint(
  deps: CheckpointDeps,
  runId: RunId,
  seq: number,
  contractHash: ContractHash | null,
  stateTagAfter: string,
): Promise<{ seq: number; tree: DiffHash }> {
  const tree = await deps.workspace.checkpoint();
  const next = seq + 1;
  await deps.runlog.append({
    runId,
    seq: next,
    ts: deps.clock.now(),
    contractHash,
    event: { tag: 'CHECKPOINTED', tree },
    stateTagAfter,
  });
  (deps.logger ?? noopLogger).info('checkpoint recorded', { tree });
  return { seq: next, tree };
}

/**
 * Fold the persisted event log into the per-run spend report (issue #17). Best-effort and
 * fail-closed: a log that cannot be read degrades the report to absent — it NEVER breaks the
 * outcome. Reading the log (the source of truth) means the report is identical fresh or resumed.
 */
async function buildUsageReport(deps: DriverDeps): Promise<UsageReport | undefined> {
  try {
    const stored = await deps.runlog.read();
    if (stored === null) return undefined;
    return summarizeUsage(
      stored.entries.map((entry) => entry.event),
      stored.header.config.budget,
    );
  } catch {
    return undefined;
  }
}

/**
 * Translate a performed Event into leveled diagnostics. Content that may carry repo text or
 * secrets (prompts, harness output, verifier detail, the diff) is kept at `debug` only — `info`
 * stays content-free (statuses, counts, hashes, decisions).
 */
function logEvent(log: Logger, command: Command, event: OrchestratorEvent): void {
  switch (event.tag) {
    case 'PLAN_COMPILED':
      // Log the frozen plan LOUDLY so the decomposition is auditable (the plan-level analogue of the
      // CONTRACT_COMPILED audit line). Phase goals may carry repo text — keep them at debug.
      log.info('plan compiled', {
        planHash: event.plan.planHash,
        phases: event.plan.phases.length,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
      });
      log.debug('plan phases', { goals: event.plan.phases.map((p) => p.goal) });
      return;
    case 'PLAN_FAILED':
      log.error('plan failed', { reason: event.reason });
      return;
    case 'PLAN_SEAL_DECIDED':
      log.info('plan seal decided', { decision: event.decision.kind });
      return;
    case 'PHASE_ADVANCED':
      log.info('phase advanced (checkpoint taken)', { tree: event.tree });
      return;
    case 'CONTRACT_COMPILED':
      log.info('contract compiled', {
        contractHash: event.contract.contractHash,
        rungs: event.contract.rungs.length,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
      });
      return;
    case 'COMPILE_FAILED':
      log.error('compile failed', { reason: event.reason });
      return;
    case 'SEAL_DECIDED':
      log.info('seal decided', { decision: event.decision.kind });
      return;
    case 'WORKSPACE_PREPARED':
      log.info('workspace prepared', {
        status: event.prepared.status,
        setupRan: event.setupRan,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
      });
      // The detail of a fail-closed outcome may carry repo text / tool output — keep it at debug.
      if (event.prepared.status !== 'proceed') {
        log.debug('prepare detail', { detail: event.prepared.detail });
      }
      return;
    case 'AGENT_RAN':
      log.info('agent ran', {
        status: event.run.status,
        changed: event.prevDiffHash !== event.diffHash,
        ...(event.budget.tokensSpent !== undefined ? { tokensSpent: event.budget.tokensSpent } : {}),
        ...(event.budget.tokensEstimated !== undefined
          ? { tokensEstimated: event.budget.tokensEstimated }
          : {}),
        ...(event.budget.tokensUnknown === true ? { tokensUnknown: true } : {}),
        budgetExceeded: event.budget.exceeded,
      });
      if (command.tag === 'RUN_AGENT') {
        // Prompt CONTENT stays out of logs; its size is a safe diagnostic signal.
        log.debug('agent prompt', { promptChars: command.prompt.length });
      }
      return;
    case 'VERIFIED':
      log.info('verified', {
        pass: event.verdict.pass,
        confidence: event.verdict.confidence,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
      });
      log.debug('verdict detail', { detail: event.verdict.detail });
      return;
    case 'SIGNOFF_DECIDED':
      log.info('sign-off decided', {
        veto: event.approval.veto,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
        ...(event.approval.reason !== undefined ? { reason: event.approval.reason } : {}),
      });
      return;
  }
}

type Performed = { event: OrchestratorEvent; ladder?: Verifier };

async function perform(
  command: Command,
  deps: DriverDeps,
  ladder: Verifier | null,
  llmMeter: LlmTokenMeter,
  /**
   * Delta-verify (#49): the cumulative baseline the Sign-off approver's diff is pinned to — the run's
   * START baseline, or in a --phased run the current PHASE's start. `undefined` ⇒ default behavior —
   * the approver diffs against the workspace's active baseline, exactly as before. Set only when
   * `--delta-verify` is on, so the terminal approver stays cumulative while per-iteration checkpoints
   * have advanced the active baseline for the judge.
   */
  approverBaseline: string | undefined,
): Promise<Performed> {
  const log = deps.logger ?? noopLogger;

  // Read the LLM spend accrued by THIS command (the loop is sequential, so the meter holds only the
  // call(s) just made) and count it against the token budget so the cap governs total spend, not
  // just the harness. Returns the per-event usage to persist, or undefined when no LLM call ran.
  const meterStep = (step: string): TokenUsage | undefined => {
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

  switch (command.tag) {
    case 'COMPILE_PLAN': {
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
        const llm = meterStep('plan');
        return { event: { tag: 'PLAN_COMPILED', plan, ...(llm !== undefined ? { llm } : {}) } };
      } catch (e) {
        const llm = meterStep('plan');
        return {
          event: { tag: 'PLAN_FAILED', reason: errorMessage(e), ...(llm !== undefined ? { llm } : {}) },
        };
      }
    }

    case 'REQUEST_PLAN_SEAL': {
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

    case 'CHECKPOINT_AND_ADVANCE': {
      // Between-phase checkpoint (issue #47): snapshot the tree (advancing the diff baseline so the
      // next phase diffs only its own delta) and return the tree on PHASE_ADVANCED — which both drives
      // the reducer's advance AND lets resume reconstruct the baseline (see replay). Fail-closed: a
      // failed snapshot throws to the outer loop, resolving to a crashed/ABORTED run.
      const tree = await deps.workspace.checkpoint();
      return { event: { tag: 'PHASE_ADVANCED', tree } };
    }

    case 'COMPILE_VERIFIER': {
      try {
        const contract = await deps.compiler.compile(command.config, command.feedback);
        const llm = meterStep('compile');
        return {
          event: { tag: 'CONTRACT_COMPILED', contract, ...(llm !== undefined ? { llm } : {}) },
          ladder: deps.makeLadder(contract),
        };
      } catch (e) {
        const llm = meterStep('compile');
        return {
          event: { tag: 'COMPILE_FAILED', reason: errorMessage(e), ...(llm !== undefined ? { llm } : {}) },
        };
      }
    }

    case 'REQUEST_SEAL': {
      const decision = await deps.seal.approveContract(command.contract);
      return { event: { tag: 'SEAL_DECIDED', decision } };
    }

    case 'PREPARE_WORKSPACE': {
      // One-time setup (Fix #1) + deterministic pre-flight (Fix #2), both fail-closed inside
      // prepareWorkspace. Runs once after SEAL and before iteration 1; the reducer routes the
      // typed outcome (proceed / setup-failed / contract-unsound). The pre-flight may make ONE
      // read-only LLM call to classify a red as broken-verifier vs honest-red — metered below.
      const result = await prepareWorkspace(
        {
          workspace: deps.workspace,
          installMissingTools: command.installMissingTools,
          ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
          ...(deps.prepareTimeouts !== undefined ? { timeouts: deps.prepareTimeouts } : {}),
          ...(deps.prepareLlm !== undefined ? { llm: deps.prepareLlm } : {}),
        },
        command.contract,
      );
      const llm = meterStep('preflight');
      return {
        event: {
          tag: 'WORKSPACE_PREPARED',
          prepared: result.prepared,
          setupRan: result.setupRan,
          ...(llm !== undefined ? { llm } : {}),
        },
      };
    }

    case 'RUN_AGENT': {
      try {
        const prevDiffHash = await deps.workspace.diffHash();
        // Snapshot .gitignore around the agent run so a NEW ignore entry appearing mid-run is loud
        // diffHash honours .gitignore, so a worker that adds one can hide changes from
        // stuck-detection. We warn rather than block — it may be legitimate — but never go silent.
        const prevGitignore = await deps.workspace.fileHash('.gitignore');
        // Tap the agent run's turns (phase `agent`) when a stream sink is wired. The StreamTap
        // inside the adapter guards the sink, so a throwing consumer never affects the run.
        const onEvent =
          deps.onStreamEvent !== undefined
            ? (event: Parameters<PhasedStreamSink>[1]): void => deps.onStreamEvent?.('agent', event)
            : undefined;
        const run = await deps.harness.run(command.prompt, command.sessionId, onEvent);
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
        // Fail-closed: a workspace (diffHash) failure must not crash the loop. Synthesize a
        // crashed run with DISTINCT sentinel hashes (so no-diff doesn't false-fire) and a valid,
        // persistable AGENT_RAN event; the frozen verifier then runs and the loop proceeds toward
        // a clean ABORTED/FAILED rather than an unhandled rejection.
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
    }

    case 'RUN_VERIFIER': {
      const active = ladder ?? deps.makeLadder(command.contract);
      const verdict = await runVerifierFailClosed(
        active,
        deps.workspace,
        command.contract.goal,
        command.contract.rubric,
      );
      const llm = meterStep('verify');
      return { event: { tag: 'VERIFIED', verdict, ...(llm !== undefined ? { llm } : {}) } };
    }

    case 'REQUEST_SIGNOFF': {
      let diff = '';
      try {
        // Pin the approver to the run's START baseline under --delta-verify so it reviews the WHOLE
        // cumulative change (the guard), not the shrunken delta the internal checkpoints left on the
        // active baseline. `undefined` ⇒ the default active-baseline diff (behavior unchanged).
        diff = await deps.workspace.diff(approverBaseline);
        const approval = await deps.approver.review({
          goal: command.goal,
          rubric: command.rubric,
          diff,
          verdicts: command.verdicts,
        });
        const llm = meterStep('approve');
        return { event: { tag: 'SIGNOFF_DECIDED', approval, ...(llm !== undefined ? { llm } : {}) } };
      } catch (e) {
        // Fail-closed: an approver that errors is treated as a veto, never a green.
        const llm = meterStep('approve');
        return {
          event: {
            tag: 'SIGNOFF_DECIDED',
            approval: { veto: true, reason: `approver error: ${errorMessage(e)}` },
            ...(llm !== undefined ? { llm } : {}),
          },
        };
      }
    }
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

// ---- resume / replay ------------------------------------------------------

type Resumed = {
  state: OrchestratorState;
  commands: Command[];
  seq: number;
  contractHash: ContractHash | null;
  contract: CompiledContract | null;
  /** The latest internal checkpoint's tree SHA (issue #47), or null when none was taken. */
  baseline: DiffHash | null;
  /** The current phase's start tree SHA (last PHASE_ADVANCED), for re-pinning the approver (#49). */
  phaseBaseline: DiffHash | null;
};

/**
 * Reconstruct state by folding the pure reducer over the persisted event stream, then
 * continue. No completed iteration is repeated — replay applies `step` only, never `perform`.
 */
async function resume(deps: DriverDeps, config: RunConfig): Promise<Resumed> {
  const stored = await deps.runlog.read();
  if (stored === null) {
    const [state, commands] = initial(config);
    return {
      state,
      commands,
      seq: 0,
      contractHash: null,
      contract: null,
      baseline: null,
      phaseBaseline: null,
    };
  }

  // Same replay-fold the read-only `runs` inspection uses — a single source of truth so an
  // inspected run's state matches exactly what resume reconstructs here.
  const { state, commands, contract, contractHash, baseline, phaseBaseline } = replay(
    stored.header.config,
    stored.entries,
  );
  return {
    state,
    commands,
    seq: stored.entries.length,
    contractHash,
    contract,
    baseline,
    phaseBaseline,
  };
}

function buildOutcome(state: OrchestratorState, runId: RunId): RunOutcome {
  switch (state.tag) {
    case 'DONE':
      return {
        status: 'DONE',
        iterations: state.iterations,
        contractHash: state.contractHash,
        runId,
      };
    case 'FAILED':
      return {
        status: 'FAILED',
        reason: state.reason,
        iterations: state.iterations,
        contractHash: state.contractHash ?? null,
        runId,
      };
    case 'ABORTED':
      return {
        status: 'ABORTED',
        reason: state.reason,
        iterations: state.iterations,
        contractHash: state.contractHash ?? null,
        runId,
      };
    default:
      throw new Error(`buildOutcome called on non-terminal state ${state.tag}`);
  }
}
