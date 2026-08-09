import { OrchestratorEvent as OrchestratorEventSchema } from '../domain/events';
import type { Command, RunExtension } from '../domain/events';
import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { ContractHash, DiffHash, RunId } from '../domain/ids';
import type { TokenUsage } from '../domain/usage';
import type { OrchestratorState } from '../orchestrator/state';
import { initial } from '../orchestrator/step';
import { replay } from '../runlog/replay';
import { summarizeUsage } from '../runlog/usage';
import type { RunLogEntry, RunLogHeader, RunProvenance } from '../runlog/runlog';
import type { DriverDeps } from './driver';

/**
 * RESUME = replay-fold + continue (invariant #7), extracted from `driver.ts` so the Driver file
 * holds the effect loop and this module holds the reconstruction. `drive()` calls {@link resume}
 * from its bootstrap; nothing here performs an effect other than reading the log (and persisting
 * the operator's `RUN_EXTENDED` marker write-ahead, before the fold that must observe it).
 */

export type Resumed = {
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
   * The run-start review baseline recorded in the header (`--baseline` / the raised-autonomy
   * auto-pin), or null for the `HEAD` default and for logs that predate the field.
   */
  headerBaseline: string | null;
  /**
   * The prior run's TOTAL token spend folded from the log, so `drive()` can re-arm the LIVE budget
   * meter. Without this a resumed run restarted `--budget-tokens` from zero — a run resumed near
   * its cap got a whole fresh budget, and repeated resumes could overshoot it arbitrarily. Null on
   * a fresh/unreadable log. (Wall-clock deliberately restarts per process: the gap between crash
   * and resume is idle time, not spend — see ADR 0011.)
   */
  priorSpend: TokenUsage | null;
  /** Un-consumed operator note from the replay fold (ADR 0012); null when none is pending. */
  pendingNote: string | null;
  /** Header successor provenance (`--recontract`, issue #117); see {@link bootstrap} for why. */
  provenance: RunProvenance | undefined;
  /**
   * The header exactly as stored, so {@link bootstrap} can reconcile the compose-time wiring labels
   * this invocation resolved against the ones the run started with. Null when there was no log.
   */
  header: RunLogHeader | null;
};

/**
 * Reconstruct state by folding the pure reducer over the persisted event stream, then
 * continue. No completed iteration is repeated — replay applies `step` only, never `perform`.
 */
export async function resume(
  deps: DriverDeps,
  config: RunConfig,
  runId: RunId,
  extend?: RunExtension,
): Promise<Resumed> {
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
      headerBaseline: null,
      priorSpend: null,
      pendingNote: null,
      provenance: undefined,
      header: null,
    };
  }

  // Operator extension (ADR 0012): validate + persist the RUN_EXTENDED marker write-ahead FIRST,
  // so the fold below (and every later replay / `runs show` / watch) sees the same effective config.
  let entries = stored.entries;
  if (extend !== undefined && hasExtension(extend)) {
    const event = OrchestratorEventSchema.parse({ tag: 'RUN_EXTENDED', ...extend });
    // The marker never feeds the reducer, so folding a draft entry first is safe — its
    // `stateTagAfter` is derived from the fold WITH the extension applied.
    const draft: RunLogEntry[] = [
      ...entries,
      {
        runId,
        seq: entries.length + 1,
        ts: deps.clock.now(),
        contractHash: entries[entries.length - 1]?.contractHash ?? null,
        event,
        stateTagAfter: 'COMPILING', // placeholder — replaced below from the fold
      },
    ];
    const folded = replay(stored.header.config, draft);
    const entry: RunLogEntry = { ...draft[draft.length - 1]!, stateTagAfter: folded.state.tag };
    await deps.runlog.append(entry);
    entries = [...stored.entries, entry];
  }

  // Same replay-fold the read-only `runs` inspection uses — a single source of truth so an
  // inspected run's state matches exactly what resume reconstructs here.
  const { state, commands, contract, contractHash, baseline, phaseBaseline, pendingNote } = replay(
    stored.header.config,
    entries,
  );
  const priorSpend = summarizeUsage(
    entries.map((entry) => entry.event),
    stored.header.config.budget,
  ).total;
  return {
    state,
    commands,
    seq: entries.length,
    contractHash,
    contract,
    baseline,
    phaseBaseline,
    headerBaseline: stored.header.baseline ?? null,
    priorSpend,
    pendingNote,
    provenance: stored.header.provenance,
    header: stored.header,
  };
}

/** Does this extension actually carry anything to persist? An empty object is a no-op resume. */
function hasExtension(x: RunExtension): boolean {
  return (
    x.maxIterations !== undefined ||
    x.budgetTokens !== undefined ||
    x.budgetWallMs !== undefined ||
    (x.stuck !== undefined && Object.keys(x.stuck).length > 0) ||
    x.note !== undefined
  );
}

