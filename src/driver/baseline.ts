import type { OrchestratorEvent, Command } from '../domain/events';
import type { ContractHash, RunId } from '../domain/ids';
import type { DiffHash } from '../domain/ids';
import type { Workspace } from '../workspace/workspace';
import type { Clock } from './clock';
import type { RunLog } from '../runlog/runlog';
import { noopLogger, type Logger } from '../log/logger';
import { errorMessage } from '../util/errors';

/** The narrow capability slice {@link recordCheckpoint} / {@link Baseline} need (no full DriverDeps). */
export type CheckpointDeps = {
  workspace: Workspace;
  runlog: RunLog;
  clock: Clock;
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
 * continuation iteration (issue #49, via {@link Baseline}) so the next iteration's judge sees only its
 * own delta. The reducer is untouched: a `CHECKPOINTED` event is a baseline marker, never fed to
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
 * Owns the run's two diff baselines and the delta-verify checkpoint policy — the one place that
 * answers "which diff does each key see, and when do we snapshot". Lifting it out of the Driver loop
 * keeps that concern in a single deep module instead of smeared across the main loop and `perform`.
 *
 * Two baselines, both driver-side effect state (never the pure reducer):
 *  - the JUDGE/active baseline lives in the {@link Workspace} (advanced by `checkpoint()`); the judge
 *    rung reads it implicitly via `workspace.diff()`, so this module only has to *advance* it.
 *  - the APPROVER/cumulative baseline is held here: under `--delta-verify` the terminal Sign-off
 *    approver must review the WHOLE change (the cumulative guard, issue #49), not the shrunken
 *    per-iteration delta — so its diff is pinned to the run's START baseline, advancing only at
 *    `--phased` phase boundaries.
 *
 * `--delta-verify` is read here once (driver wiring) and never reaches the reducer.
 */
export class Baseline {
  readonly #deps: CheckpointDeps;
  readonly #deltaVerify: boolean;
  /** The cumulative baseline the Sign-off approver's diff is pinned to (run start → phase boundaries). */
  #approver: string;

  constructor(deps: CheckpointDeps, deltaVerify: boolean, runStartBaseline: string) {
    this.#deps = deps;
    this.#deltaVerify = deltaVerify;
    this.#approver = runStartBaseline;
  }

  /**
   * The diff the Sign-off approver reviews. Under `--delta-verify` it is pinned to the cumulative
   * baseline (so the approver sees the whole change even while internal checkpoints shrank the judge's
   * active baseline); otherwise it is the workspace's default active-baseline diff — behavior unchanged.
   */
  approverDiff(): Promise<string> {
    return this.#deps.workspace.diff(this.#deltaVerify ? this.#approver : undefined);
  }

  /**
   * Re-point both baselines from a resumed log fold (issue #47/#49): the active (judge) baseline to the
   * last internal checkpoint, and the cumulative (approver) baseline to the current phase's start.
   * Null ⇒ keep what the constructor captured (a classic run, or no phase advanced yet).
   */
  hydrateResume(resumed: { baseline: string | null; phaseBaseline: string | null }): void {
    if (resumed.baseline !== null) this.#deps.workspace.setBaseline(resumed.baseline);
    if (resumed.phaseBaseline !== null) this.#approver = resumed.phaseBaseline;
  }

  /**
   * Advance the baselines after a reducer transition has been applied and persisted:
   *  - at a `--phased` PHASE boundary, move the cumulative (approver) baseline to the phase's start
   *    tree, so from the next phase on Sign-off reviews that phase's whole change;
   *  - under `--delta-verify`, after a CONTINUATION iteration (a ladder fail or a Sign-off veto that
   *    loops back to `RUN_AGENT`), take an internal checkpoint so the next iteration's judge sees only
   *    its own delta. The cumulative keys are untouched: the deterministic rungs always run on the full
   *    working tree, and the approver stays pinned to the cumulative baseline above.
   * Per-iteration checkpoints never advance the approver baseline — only phase boundaries do — which is
   * what keeps the approver cumulative WITHIN a phase. Returns the (possibly advanced) `seq`.
   * Fail-closed (invariant #4): a failed checkpoint rolls the active baseline back so the judge falls
   * back to the larger cumulative diff (never an empty "nothing to review") and a resume frames it the same.
   */
  async onTransition(p: {
    event: OrchestratorEvent;
    nextCommand: Command | undefined;
    seq: number;
    runId: RunId;
    contractHash: ContractHash | null;
    nextTag: string;
  }): Promise<number> {
    if (p.event.tag === 'PHASE_ADVANCED') this.#approver = p.event.tree;

    const isContinuation =
      this.#deltaVerify &&
      (p.event.tag === 'VERIFIED' || p.event.tag === 'SIGNOFF_DECIDED') &&
      p.nextCommand?.tag === 'RUN_AGENT';
    if (!isContinuation) return p.seq;

    // Snapshot the active baseline BEFORE checkpointing: `checkpoint()` advances it in-memory before the
    // CHECKPOINTED marker is appended, so if that append throws we must roll back — otherwise the live
    // judge keeps seeing the delta while the unlogged advance silently diverges from what `--resume`
    // reconstructs.
    const prior = this.#deps.workspace.currentBaseline();
    try {
      const cp = await recordCheckpoint(this.#deps, p.runId, p.seq, p.contractHash, p.nextTag);
      return cp.seq;
    } catch (e) {
      this.#deps.workspace.setBaseline(prior);
      (this.#deps.logger ?? noopLogger).warn(
        'delta-verify checkpoint failed; judge will see the full diff this iteration',
        { reason: errorMessage(e) },
      );
      return p.seq;
    }
  }
}
