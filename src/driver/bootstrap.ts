/**
 * The Driver's pre-loop IO — fresh-run header write, or the `--resume` fold + re-hydration — in one
 * place. Split out of `driver.ts`; `drive()` calls {@link bootstrap} inside its guarded try/catch so
 * every throw here resolves to a typed ABORTED. `step()` and the reducer's Zod choke point stay in
 * `driver.ts`; this module only prepares the state the loop starts from.
 */
import type { Command } from '../domain/events';
import type { RunConfig } from '../domain/config';
import type { ContractHash, RunId } from '../domain/ids';
import type { Verifier } from '../verify/verifier';
import { freshRunHeader, type RunProvenance } from '../runlog/runlog';
import { isTerminal, type OrchestratorState } from '../orchestrator/state';
import { initial } from '../orchestrator/step';
import type { Logger } from '../log/logger';
import type { DriverDeps, DriveOptions } from './deps';
import type { Baseline } from './baseline';
import { reconcileDegraded } from './degraded-header';
import { resume } from './resume';

export type Bootstrapped = {
  state: OrchestratorState;
  commands: Command[];
  seq: number;
  contractHash: ContractHash | null;
  ladder: Verifier | null;
  /** Un-consumed operator note (ADR 0012) to append to the NEXT agent turn's prompt; null if none. */
  pendingNote: string | null;
  /**
   * The successor provenance this run ACTUALLY has (issue #117): `options` on a fresh run, re-read
   * from the header on `--resume` (see {@link bootstrap}). Everything after bootstrap must use THIS,
   * never `options.provenance`, or a resumed successor loses its pre-flight negative control.
   */
  provenance: RunProvenance | undefined;
};

/**
 * The pre-loop IO in one guarded place: on `--resume`, fold the log, rebuild the ladder, re-point the
 * baselines, re-arm the budget meter with prior spend, and RE-ADOPT the successor provenance from the
 * header; on a fresh run, write the header. Called inside `drive()`'s bootstrap try/catch so any throw
 * here (corrupt log, disk full) resolves to a typed ABORTED rather than a rejection out of `drive()`.
 *
 * Successor provenance (issue #117) can ONLY arrive from a fresh `--from-run … --recontract` (the CLI
 * rejects `--from-run` with `--resume`), but it IS in the header — so, like the `baseline` pin below,
 * a resume reads it back from there. Without that, a resumed re-contract reached `PREPARE_WORKSPACE`
 * with no provenance and the GREEN negative control (what keeps a re-contract from becoming a
 * weakening channel) returned early without running anything and without saying so.
 */
export async function bootstrap(
  deps: DriverDeps,
  config: RunConfig,
  runId: RunId,
  options: DriveOptions,
  baseline: Baseline,
  log: Logger,
): Promise<Bootstrapped> {
  if (options.resume !== true) {
    const [state, commands] = initial(config);
    // The run-start review baseline (an explicit `--baseline` or the raised-autonomy auto-pin,
    // applied by compose before drive()) and the compose-time wiring labels (harness, degraded
    // mode) ride into the header — `freshRunHeader` owns which of them are recorded.
    const startedAt = deps.clock.now();
    const runStartBaseline = deps.workspace.currentBaseline();
    await deps.runlog.writeHeader(freshRunHeader(runId, startedAt, config, runStartBaseline, options));
    const fresh = { seq: 0, contractHash: null, ladder: null, pendingNote: null };
    return { state, commands, ...fresh, provenance: options.provenance };
  }

  const resumed = await resume(deps, config, runId, options.extend);
  // Keep the run's degraded-mode label truthful across resumes (issue #125). Recorded as an APPENDED
  // marker, so it advances `seq` like any other write-ahead entry — never as a header rewrite.
  const escalations = await reconcileDegraded(
    deps.runlog,
    resumed.header,
    options.degraded,
    log,
    {
      runId,
      seq: resumed.seq,
      contractHash: resumed.contractHash,
      stateTag: resumed.state.tag,
      now: deps.clock.now(),
    },
  );
  // An extension that did not un-terminate the run (e.g. a note on a stuck abort whose tripping
  // detector was not raised) is loud, not silent — the outcome will still be the terminal one.
  if (options.extend !== undefined && isTerminal(resumed.state)) {
    log.warn('resume extension did not un-terminate the run — the terminal outcome stands', {
      state: resumed.state.tag,
    });
  }
  // Re-adopt the run-start review baseline recorded in the header (an explicit `--baseline` or the
  // raised-autonomy auto-pin) when nothing else owns it this invocation: a re-passed `--baseline`
  // has already moved the workspace off its `HEAD` default (compose wins), and a logged checkpoint
  // is re-pointed by `hydrateResume` right below (the fold wins). Without this, resuming a run
  // whose agent had committed at raised autonomy fell back to the MOVED HEAD — an empty diff for
  // both keys, the exact failure the pin exists to prevent.
  if (resumed.headerBaseline !== null && deps.workspace.currentBaseline() === 'HEAD') {
    baseline.adoptRunStart(resumed.headerBaseline);
    log.info('resume: re-adopted the run-start review baseline from the run log', {
      baseline: resumed.headerBaseline,
    });
  }
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
  // Re-adopt the successor provenance the header recorded (issue #117). An `options` provenance still
  // wins (the log is the FALLBACK, not an override), though the CLI can never supply one on a resume.
  // Logged loudly — the re-contract negative control is a real gate, so its wiring is never silent.
  const provenance = options.provenance ?? resumed.provenance;
  if (options.provenance === undefined && resumed.provenance !== undefined) {
    log.info('resume: re-adopted the successor (--recontract) provenance from the run log header', {
      predecessorRunId: resumed.provenance.predecessorRunId,
      recontracts: resumed.provenance.recontracts,
    });
  }
  return {
    state: resumed.state,
    commands: resumed.commands,
    seq: resumed.seq + escalations,
    contractHash: resumed.contractHash,
    ladder: resumed.contract !== null ? deps.makeLadder(resumed.contract) : null,
    pendingNote: resumed.pendingNote,
    provenance,
  };
}
