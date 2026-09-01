import type { Command, RunOutcome } from '../domain/events';
import { OrchestratorEvent as OrchestratorEventSchema } from '../domain/events';
import type { RunProvenance } from '../runlog/runlog';
import type { RunConfig } from '../domain/config';
import type { ContractHash, RunId, SessionId } from '../domain/ids';
import type { UsageReport } from '../domain/usage';
import { isTerminal, iterationCount, remediationsTotal, type OrchestratorState } from '../orchestrator/state';
import { MAX_STUCK_REMEDIATIONS } from '../orchestrator/remediate';
import { step } from '../orchestrator/step';
import { bootstrapFailedReason, driverErrorReason } from '../orchestrator/reason-quote';
import type { Verifier } from '../verify/verifier';
import { bestOfFloor, performBestOf } from './best-of-driver';
import { LlmTokenMeter } from './llm-meter';
import { summarizeUsage } from '../runlog/usage';
import { lastRealSessionId } from '../runlog/session-id';
import { noopLogger, type Logger } from '../log/logger';
import type { Observer } from '../observe/observer';
import { errorMessage } from '../util/errors';
import { noopTelemetry, type TelemetryEvent } from '../telemetry/telemetry';
import { Baseline } from './baseline';
import { logEvent } from './log-event';
import { buildOutcome } from './outcome';
import type { DriverDeps, DriveOptions } from './deps';
import { perform, type Performed } from './perform';
import { bootstrap } from './bootstrap';

// Re-exported from {@link ./baseline} (the checkpoint primitive + the Baseline diff-scope module live
// there now) and {@link ./deps} (the dependency bag + drive options); kept on the Driver's public
// surface for embedders and the existing index.ts exports.
export { recordCheckpoint, type CheckpointDeps } from './baseline';
export type { DriverDeps, DriveOptions } from './deps';

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
  let pendingNote: string | null = null;
  /** The run's EFFECTIVE successor provenance — see `Bootstrapped.provenance` in `bootstrap.ts`. */
  let provenance: RunProvenance | undefined;
  const log = deps.logger ?? noopLogger;
  const llmMeter = deps.llmMeter ?? new LlmTokenMeter();
  // Telemetry (pure observability seam): a fire-and-forget sink for lifecycle datapoints. Strictly
  // OFF the control flow — never fed to the reducer, never on the durability path, never able to
  // touch the frozen contract or the two-key DONE. Every call is GUARDED: a throwing sink degrades
  // to "no telemetry" instead of taking down a run (invariant #4, fail-closed).
  const telemetry = deps.telemetry ?? noopTelemetry;
  const emitTelemetry = (event: TelemetryEvent): void => {
    try {
      telemetry.record(event);
    } catch (e) {
      log.debug('telemetry sink error (ignored)', { reason: errorMessage(e) });
    }
  };
  const emitRunFinished = (o: RunOutcome): void =>
    emitTelemetry({
      kind: 'run_finished',
      runId,
      status: o.status,
      iterations: o.iterations,
      ts: deps.clock.now(),
    });
  emitTelemetry({ kind: 'run_started', runId, resume: options.resume === true, ts: deps.clock.now() });
  // Capture the run's START baseline BEFORE any internal checkpoint (or the resume re-point below)
  // advances it. On a FRESH run this is `--baseline`/HEAD as compose applied it (including the
  // raised-autonomy auto-pin), and bootstrap records it in the run-log header. On --resume it is
  // whatever compose re-applied THIS invocation; a run resumed without the flag re-adopts the
  // header's recorded baseline in bootstrap (see `adoptRunStart`), so the pin survives a crash —
  // essential at raised harness autonomy, where the agent may have committed mid-run and a MOVED
  // HEAD would empty the diff both keys review. Only a pre-recording log falls back to HEAD, which
  // is safe when goaly's harness makes no commits (every iteration's work stays post-HEAD). Phased
  // runs instead re-pin from the log below. Under --delta-verify the terminal Sign-off approver is pinned to a CUMULATIVE baseline —
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
    ({ state, commands, seq, contractHash, ladder, pendingNote, provenance } = await bootstrap(
      deps, config, runId, options, baseline, log,
    ));
  } catch (e) {
    log.error('run bootstrap failed (fail-closed → ABORTED)', { reason: errorMessage(e) });
    const outcome: RunOutcome = {
      status: 'ABORTED',
      reason: bootstrapFailedReason(errorMessage(e)),
      iterations: 0,
      contractHash: null,
      runId,
    };
    emitRunFinished(outcome);
    return outcome;
  }

  // Worktree floor (issue #85, locked decision #8): best-of-N needs a resolvable HEAD — `git worktree`
  // cannot check out an unborn branch's tree — and a WorktreeHost to drive. Refuse to start fail-closed
  // (a clear ABORTED, never a silent downgrade to a single attempt or a thrown rejection) when
  // `--candidates > 1` on a HEAD-less repo or with no worktree host wired.
  if (config.candidates > 1) {
    const floor = await bestOfFloor(deps);
    if (floor !== null) {
      log.error('best-of-N refused to start (fail-closed)', { reason: floor });
      const outcome: RunOutcome = {
        status: 'ABORTED',
        reason: floor,
        iterations: iterationCount(state),
        contractHash: contractHash ?? null,
        runId,
      };
      emitRunFinished(outcome);
      return outcome;
    }
  }

  try {
    while (!isTerminal(state)) {
      // Cooperative interrupt: stop BETWEEN steps (the previous event is already durable), so the
      // user gets a clean ABORTED with the resume path instead of a mid-iteration kill.
      if (deps.interrupted?.() === true) {
        log.warn('interrupt requested — stopping before the next step', { runId });
        const extras = await buildOutcomeExtras(deps);
        const outcome: RunOutcome = {
          status: 'ABORTED',
          reason: `interrupted by user — resume this run with: --resume ${runId}`,
          iterations: iterationCount(state),
          contractHash: contractHash ?? null,
          runId,
          ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
          ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
        };
        emitRunFinished(outcome);
        return outcome;
      }
      if (commands.length !== 1) {
        throw new Error(
          `driver invariant: non-terminal state ${state.tag} emitted ${commands.length} commands (expected 1)`,
        );
      }
      let command = commands[0]!;
      // Consume an un-consumed operator note (ADR 0012) on the FIRST agent turn after resume —
      // whichever step it turns out to be. Worker steering only; the contract/ladder never see it.
      if (
        pendingNote !== null &&
        (command.tag === 'RUN_AGENT' || command.tag === 'RUN_AGENT_BEST_OF')
      ) {
        command = withOperatorNote(command, pendingNote);
        pendingNote = null;
        log.info('operator note appended to the next agent prompt', {});
      }
      log.debug('perform command', { command: command.tag, state: state.tag });

      // Best-of-N (issue #85): the Driver performs the WHOLE tournament here — it appends its own
      // CANDIDATE_RAN/CANDIDATE_SELECTED markers write-ahead (advancing seq) and feeds back ONE
      // AGENT_RAN for the winner, so the reducer is unchanged. Kept in this seam (not `perform`) so it
      // can read the log for resume + advance seq exactly like the Baseline checkpoint path.
      const performed: Performed =
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
          : await perform(command, deps, ladder, llmMeter, baseline, runId, provenance);
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

      // Bounded stuck self-recovery (improvement plan 4.2) is a pure reducer policy — surface each
      // spend LOUDLY here so an unattended operator can see the run saved itself (and how often).
      const remediatedTo = remediationsTotal(next);
      if (remediatedTo !== undefined && remediatedTo > (remediationsTotal(state) ?? remediatedTo)) {
        log.warn('stuck auto-remediation applied — retrying instead of aborting', {
          used: remediatedTo,
          cap: MAX_STUCK_REMEDIATIONS,
        });
      }

      state = next;
      commands = nextCommands;

      // Telemetry lifecycle beat (pure observability): one datapoint per performed-and-folded event —
      // the compile → run → verify → sign-off progression an embedder meters. Guarded and off the
      // replay log, so it can never affect the run's outcome.
      emitTelemetry({ kind: 'lifecycle', runId, event: event.tag, stateAfter: state.tag, ts: deps.clock.now() });

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
    // rather than reject — so the caller always gets a RunOutcome. The message is QUOTED behind a
    // lead-in, never claimed as goaly's own words: this catch wraps CHECKPOINT_AND_ADVANCE, a
    // --phased between-phase checkpoint that runs AFTER worker turns, so the exception text can
    // carry tree-authored content (see `src/orchestrator/reason-quote.ts`).
    log.error('driver error (fail-closed → ABORTED)', { reason: errorMessage(e) });
    const extras = await buildOutcomeExtras(deps);
    const outcome: RunOutcome = {
      status: 'ABORTED',
      reason: driverErrorReason(errorMessage(e)),
      iterations: iterationCount(state),
      contractHash: contractHash ?? null,
      runId,
      ...(extras.usage !== undefined ? { usage: extras.usage } : {}),
      ...(extras.sessionId !== undefined ? { sessionId: extras.sessionId } : {}),
    };
    emitRunFinished(outcome);
    return outcome;
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
  emitRunFinished(finalOutcome);
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
 * Append an un-consumed operator note (ADR 0012) to an agent turn's prompt. Steering is WORKER
 * guidance only: it decorates the prompt the reducer already built — never the frozen contract,
 * the ladder, or the approver's inputs — so both keys still gate DONE unchanged.
 */
function withOperatorNote(command: Command, note: string): Command {
  if (command.tag !== 'RUN_AGENT' && command.tag !== 'RUN_AGENT_BEST_OF') return command;
  return { ...command, prompt: `${command.prompt}\n\n# Operator note (added at resume)\n${note}` };
}
