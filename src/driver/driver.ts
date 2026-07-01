import type { Command, OrchestratorEvent, RunOutcome } from '../domain/events';
import { OrchestratorEvent as OrchestratorEventSchema } from '../domain/events';
import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { ContractHash, RunId, SessionId } from '../domain/ids';
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
import type { Workspace, WorktreeHost } from '../workspace/workspace';
import type { Clock } from './clock';
import type { BudgetMeter } from './budget';
import { bestOfFloor, performBestOf } from './best-of-driver';
import { LlmTokenMeter, deltaToUsage } from './llm-meter';
import { summarizeUsage } from '../runlog/usage';
import { lastRealSessionId } from '../runlog/session-id';
import type { RunLog } from '../runlog/runlog';
import { noopLogger, type Logger } from '../log/logger';
import type { PhasedStreamSink } from '../agent-cli/stream';
import type { Observer } from '../observe/observer';
import { errorMessage } from '../util/errors';
import { prepareWorkspace, type PrepareTimeouts } from './prepare';
import { Baseline, recordCheckpoint, type CheckpointDeps } from './baseline';

// Re-exported from {@link ./baseline} (the checkpoint primitive + the Baseline diff-scope module live
// there now); kept on the Driver's public surface for embedders and the existing index.ts exports.
export { recordCheckpoint, type CheckpointDeps } from './baseline';

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
  /**
   * The worktree lifecycle seam for best-of-N (issue #85). REQUIRED only when `config.candidates > 1`:
   * the Driver fans out K isolated worktrees off the baseline tree, scores each against the frozen
   * ladder, and promotes the winner's tree — all here, never in the reducer. Absent ⇒ a `--candidates 1`
   * run never touches it (the classic single attempt is byte-for-byte unchanged). When `candidates > 1`
   * but this is absent, the run refuses to start (fail-closed).
   */
  worktrees?: WorktreeHost;
  clock: Clock;
  budget: BudgetMeter;
  /**
   * Backoff sleep used by the harness crash-retry (see {@link HARNESS_CRASH_RETRIES}). Injectable
   * so tests never wait a real timer; defaults to a real `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Cooperative interrupt probe (Ctrl-C / SIGTERM): polled between steps — and before a crash-retry
   * — so a graceful shutdown finishes the in-flight effect, persists its event write-ahead, and
   * resolves to a typed ABORTED (with a resume path) instead of dying mid-iteration. Absent ⇒ never
   * interrupted. The write-ahead log makes even a HARD kill safe (at-least-once resume); this just
   * turns the common case into a clean, resumable exit with a clear outcome.
   */
  interrupted?: () => boolean;
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
  /**
   * Optional `--explain` observer (issue #8): a strictly read-only side-LLM narrator fed the SAME
   * lifecycle events the Driver already sees, fired at the contract / verifier / outcome checkpoints.
   * Advisory only — it can never influence the frozen contract, the ladder, DECIDE, or the two-key
   * DONE, and its summaries are written to a sink, never to the replay log. Internally fail-closed;
   * the Driver also guards every call so even a programming error here can never reject `drive()`.
   * Absent ⇒ no narration (the default).
   */
  observer?: Observer;
};

export type DriveOptions = {
  /** Resume from an existing run log instead of starting fresh. */
  resume?: boolean;
  /**
   * Which harness (coding-agent CLI) backs this run — recorded once in the run-log header so the
   * follow-up resume-hint (Capability A) can print the harness-correct `--resume` command. Pure
   * wiring, never the frozen contract; absent ⇒ the header omits it (old behavior unchanged).
   */
  harness?: string;
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
  // The Baseline module owns both diff baselines + the delta-verify checkpoint policy (issue #47/#49),
  // so the main loop and `perform` only ask it "what diff does the approver see" / "advance after this
  // transition" instead of threading baselines by hand. `--delta-verify` is read here, never the reducer.
  const baseline = new Baseline(
    {
      workspace: deps.workspace,
      runlog: deps.runlog,
      clock: deps.clock,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    },
    config.deltaVerify,
    deps.workspace.currentBaseline(),
  );

  log.info(options.resume === true ? 'resuming run' : 'starting run', {
    runId,
    resume: options.resume === true,
  });

  // The pre-loop IO (reading the log to resume; writing the fresh header) must resolve to a typed
  // ABORTED like every other seam — a disk-full/corrupt-log throw here used to escape `drive()`
  // entirely (the only rejection path left), reaching the caller as a raw stack trace.
  try {
    ({ state, commands, seq, contractHash, ladder } = await bootstrap(
      deps, config, runId, options, baseline, log,
    ));
  } catch (e) {
    log.error('run bootstrap failed (fail-closed → ABORTED)', { reason: errorMessage(e) });
    return {
      status: 'ABORTED',
      reason: `run bootstrap failed: ${errorMessage(e)}`,
      iterations: 0,
      contractHash: null,
      runId,
    };
  }

  // Worktree floor (issue #85, locked decision #8): best-of-N needs a resolvable HEAD — `git worktree`
  // cannot check out an unborn branch's tree — and a WorktreeHost to drive. Refuse to start fail-closed
  // (a clear ABORTED, never a silent downgrade to a single attempt or a thrown rejection) when
  // `--candidates > 1` on a HEAD-less repo or with no worktree host wired.
  if (config.candidates > 1) {
    const floor = await bestOfFloor(deps);
    if (floor !== null) {
      log.error('best-of-N refused to start (fail-closed)', { reason: floor });
      return {
        status: 'ABORTED',
        reason: floor,
        iterations: iterationCount(state),
        contractHash: contractHash ?? null,
        runId,
      };
    }
  }

  try {
    while (!isTerminal(state)) {
      // Cooperative interrupt: stop BETWEEN steps (the previous event is already durable), so the
      // user gets a clean ABORTED with the resume path instead of a mid-iteration kill.
      if (deps.interrupted?.() === true) {
        log.warn('interrupt requested — stopping before the next step', { runId });
        const extras = await buildOutcomeExtras(deps);
        return {
          status: 'ABORTED',
          reason: `interrupted by user — resume this run with: --resume ${runId}`,
          iterations: iterationCount(state),
          contractHash: contractHash ?? null,
          runId,
          ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
          ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
        };
      }
      if (commands.length !== 1) {
        throw new Error(
          `driver invariant: non-terminal state ${state.tag} emitted ${commands.length} commands (expected 1)`,
        );
      }
      const command = commands[0]!;
      log.debug('perform command', { command: command.tag, state: state.tag });

      // Best-of-N (issue #85): the Driver performs the WHOLE tournament here — it appends its own
      // CANDIDATE_RAN/CANDIDATE_SELECTED markers write-ahead (advancing seq) and feeds back ONE
      // AGENT_RAN for the winner, so the reducer is unchanged. Kept in this seam (not `perform`) so it
      // can read the log for resume + advance seq exactly like the Baseline checkpoint path.
      const performed =
        command.tag === 'RUN_AGENT_BEST_OF'
          ? await performBestOf(
              command,
              deps,
              ladder,
              state,
              runId,
              contractHash,
              seq,
              config.resumeBestOfIncomplete,
            )
          : await perform(command, deps, ladder, llmMeter, baseline);
      if (performed.seq !== undefined) seq = performed.seq;
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

      // Advance the baselines after the transition: the approver's cumulative baseline at a --phased
      // boundary, and (under --delta-verify) an internal checkpoint after a continuation iteration so
      // the next judge sees only its delta. All of that — including the fail-closed rollback — lives in
      // the Baseline module now; the loop just hands it the transition and takes back the (advanced) seq.
      seq = await baseline.onTransition({
        event,
        nextCommand: commands[0],
        seq,
        runId,
        contractHash,
        nextTag: next.tag,
      });

      // `--explain` narration (issue #8) — AFTER the write-ahead append, so a slow side-LLM never
      // sits on the durability path. Strictly advisory and off the critical path: the observer is
      // internally fail-closed, and this extra guard means even a throw here degrades to "no
      // summary" rather than touching the run's outcome.
      await observe(deps.observer, (o) => o.onEvent(event), log);
    }
  } catch (e) {
    // Last-resort safety net: every effectful seam is individually fail-closed, but an unexpected
    // throw (corrupt log on append, invalid transition) must still resolve to a terminal outcome
    // rather than reject — so the caller always gets a RunOutcome.
    log.error('driver error (fail-closed → ABORTED)', { reason: errorMessage(e) });
    const extras = await buildOutcomeExtras(deps);
    return {
      status: 'ABORTED',
      reason: `driver error: ${errorMessage(e)}`,
      iterations: iterationCount(state),
      contractHash: contractHash ?? null,
      runId,
      ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
      ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
    };
  }

  const outcome = buildOutcome(state, runId);
  const extras = await buildOutcomeExtras(deps);
  log.info('run finished', {
    status: outcome.status,
    iterations: outcome.iterations,
    ...(extras.usage !== undefined ? { tokensTotal: extras.usage.total.tokens } : {}),
  });
  const finalOutcome: RunOutcome = {
    ...outcome,
    ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
    ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
  };
  // Final `--explain` checkpoint (issue #8): narrate the terminal outcome — especially a stuck
  // ABORTED. Same advisory, fail-closed contract as the per-iteration narration above.
  await observe(deps.observer, (o) => o.onOutcome(finalOutcome), log);
  return finalOutcome;
}

/**
 * Run one observer call, fully guarded (issue #8). The {@link Observer} is already internally
 * fail-closed, but `drive()` must NEVER reject — so a no-op when absent and a swallowed throw here
 * keep the read-only narrator strictly off the run's control flow (invariant #4).
 */
async function observe(
  observer: Observer | undefined,
  call: (o: Observer) => Promise<void>,
  log: Logger,
): Promise<void> {
  if (observer === undefined) return;
  try {
    await call(observer);
  } catch (e) {
    log.debug('explain observer error (ignored)', { reason: errorMessage(e) });
  }
}

/**
 * Fold the persisted event log into the per-run spend report (issue #17) AND recover the run's last
 * real harness session id (Capability A) in the same read. Best-effort and fail-closed: a log that
 * cannot be read degrades both to absent — it NEVER breaks the outcome. Reading the log (the source
 * of truth) means the extras are identical fresh or resumed.
 */
async function buildOutcomeExtras(
  deps: DriverDeps,
): Promise<{ usage?: UsageReport; sessionId?: SessionId }> {
  try {
    const stored = await deps.runlog.read();
    if (stored === null) return {};
    const usage = summarizeUsage(
      stored.entries.map((entry) => entry.event),
      stored.header.config.budget,
    );
    const sessionId = lastRealSessionId(stored.entries);
    return { usage, ...(sessionId !== undefined ? { sessionId } : {}) };
  } catch {
    return {};
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

type Performed = {
  event: OrchestratorEvent;
  ladder?: Verifier;
  /** The advanced seq after best-of-N appended its own markers write-ahead (issue #85); else absent. */
  seq?: number;
};

async function perform(
  command: Command,
  deps: DriverDeps,
  ladder: Verifier | null,
  llmMeter: LlmTokenMeter,
  /**
   * Owns the run's diff baselines (issue #47/#49). `REQUEST_SIGNOFF` asks it for the approver's diff —
   * the whole cumulative change under `--delta-verify`, else the workspace's default active-baseline
   * diff — so the choice of what the approver reviews lives in one place, not threaded by hand here.
   */
  baseline: Baseline,
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
          setupAuthored: command.setupAuthored,
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
        // The Baseline module decides what the approver reviews: the WHOLE cumulative change under
        // --delta-verify (the guard), else the default active-baseline diff (behavior unchanged).
        diff = await baseline.approverDiff();
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

    case 'RUN_AGENT_BEST_OF':
      // Best-of-N is performed in the main loop (it appends its own write-ahead markers + advances
      // seq), never here. Reaching `perform` with it is a wiring bug — fail closed loudly.
      throw new Error('RUN_AGENT_BEST_OF must be performed by the main loop, not perform()');
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

// ---- bootstrap / resume / replay ------------------------------------------

type Bootstrapped = {
  state: OrchestratorState;
  commands: Command[];
  seq: number;
  contractHash: ContractHash | null;
  ladder: Verifier | null;
};

/**
 * The pre-loop IO in one guarded place: on `--resume`, fold the log, rebuild the ladder, re-point
 * the baselines, and re-arm the budget meter with prior spend; on a fresh run, write the header.
 * Called inside `drive()`'s bootstrap try/catch so any throw here (corrupt log, disk full) resolves
 * to a typed ABORTED rather than the last remaining rejection path out of `drive()`.
 */
async function bootstrap(
  deps: DriverDeps,
  config: RunConfig,
  runId: RunId,
  options: DriveOptions,
  baseline: Baseline,
  log: Logger,
): Promise<Bootstrapped> {
  if (options.resume !== true) {
    const [state, commands] = initial(config);
    await deps.runlog.writeHeader({
      runId,
      startedAt: deps.clock.now(),
      config,
      ...(options.harness !== undefined ? { harness: options.harness } : {}),
    });
    return { state, commands, seq: 0, contractHash: null, ladder: null };
  }

  const resumed = await resume(deps, config);
  // Re-point both baselines from the resumed fold (issue #47/#49): the active baseline to the last
  // internal checkpoint (overriding any compose-time `--baseline`, since the logged checkpoint reflects
  // real progress), and the approver's cumulative baseline to the current phase's start.
  baseline.hydrateResume(resumed);
  // Re-arm the LIVE budget meter with the prior spend, so `--budget-tokens` caps the RUN, not
  // each process: a run resumed near its cap must not get a fresh budget every restart.
  if (
    resumed.priorSpend !== null &&
    (resumed.priorSpend.tokens > 0 || resumed.priorSpend.unknownCalls > 0)
  ) {
    deps.budget.record(resumed.priorSpend.tokens, resumed.priorSpend.estimatedTokens ?? 0, {
      unknownCalls: resumed.priorSpend.unknownCalls,
    });
    log.info('resume: prior token spend re-armed against the budget', {
      tokens: resumed.priorSpend.tokens,
      ...(resumed.priorSpend.unknownCalls > 0
        ? { unknownCalls: resumed.priorSpend.unknownCalls }
        : {}),
    });
  }
  return {
    state: resumed.state,
    commands: resumed.commands,
    seq: resumed.seq,
    contractHash: resumed.contractHash,
    ladder: resumed.contract !== null ? deps.makeLadder(resumed.contract) : null,
  };
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
  /**
   * The prior run's TOTAL token spend folded from the log, so `drive()` can re-arm the LIVE budget
   * meter. Without this a resumed run restarted `--budget-tokens` from zero — a run resumed near
   * its cap got a whole fresh budget, and repeated resumes could overshoot it arbitrarily. Null on
   * a fresh/unreadable log. (Wall-clock deliberately restarts per process: the gap between crash
   * and resume is idle time, not spend — see ADR 0011.)
   */
  priorSpend: TokenUsage | null;
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
      priorSpend: null,
    };
  }

  // Same replay-fold the read-only `runs` inspection uses — a single source of truth so an
  // inspected run's state matches exactly what resume reconstructs here.
  const { state, commands, contract, contractHash, baseline, phaseBaseline } = replay(
    stored.header.config,
    stored.entries,
  );
  const priorSpend = summarizeUsage(
    stored.entries.map((entry) => entry.event),
    stored.header.config.budget,
  ).total;
  return {
    state,
    commands,
    seq: stored.entries.length,
    contractHash,
    contract,
    baseline,
    phaseBaseline,
    priorSpend,
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
