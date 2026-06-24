import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';
import type { Command } from '../domain/events';
import type { ContractHash, DiffHash } from '../domain/ids';
import type { OrchestratorState } from '../orchestrator/state';
import { initial, step } from '../orchestrator/step';
import type { RunLogEntry } from './runlog';

/** The reconstructed result of folding the pure reducer over a persisted event stream. */
export type ReplayResult = {
  /** The final orchestrator state the run reached (terminal or interrupted mid-loop). */
  readonly state: OrchestratorState;
  /** The commands the reducer would emit next (empty in a terminal state). */
  readonly commands: Command[];
  /** The last (frozen) contract that was compiled, or null if compile never succeeded. */
  readonly contract: CompiledContract | null;
  /** The frozen contract's hash, mirrored for convenience (null before compile). */
  readonly contractHash: ContractHash | null;
  /**
   * The tree SHA of the most recent internal checkpoint (issue #47), or null if none was taken. The
   * Driver re-points the workspace's diff baseline at this on `--resume` so the resumed run keeps the
   * same small-diff baseline it had advanced to. Updated by BOTH the standalone CHECKPOINTED marker
   * and a phased run's PHASE_ADVANCED (which also checkpoints between phases — issue #48).
   */
  readonly baseline: DiffHash | null;
  /** The frozen plan a phased run authored (issue #48), or null on a classic single-contract run. */
  readonly plan: PhasePlan | null;
};

/**
 * Replay = a pure fold of `step` over the event stream. This is the SINGLE source of truth for
 * "what state did this run reach": the Driver's `--resume` path and the read-only `runs`
 * inspection both call it, so an inspected run's status/iterations match exactly what the Driver
 * computed (invariant #7 — resume is a replay-fold). No effect is performed, only `step`.
 */
export function replay(config: RunConfig, entries: readonly RunLogEntry[]): ReplayResult {
  let [state, commands] = initial(config);
  let contract: CompiledContract | null = null;
  let contractHash: ContractHash | null = null;
  let baseline: DiffHash | null = null;
  let plan: PhasePlan | null = null;

  for (const entry of entries) {
    // A CHECKPOINTED entry is a diff-baseline marker, NOT a reducer transition: it is never fed to
    // `step()` (the reducer stays unaffected, invariant #1). We only remember the latest tree so the
    // Driver can re-point the baseline on resume.
    if (entry.event.tag === 'CHECKPOINTED') {
      baseline = entry.event.tree;
      continue;
    }
    if (entry.event.tag === 'CONTRACT_COMPILED') {
      contract = entry.event.contract;
      contractHash = entry.event.contract.contractHash;
    }
    if (entry.event.tag === 'PLAN_COMPILED') {
      plan = entry.event.plan;
    }
    // A phased run's PHASE_ADVANCED both DRIVES the reducer (advance to the next phase) AND records
    // the checkpoint tree for baseline reconstruction on resume (issue #48) — so it is fed to step()
    // *and* updates `baseline`, unlike the pure CHECKPOINTED marker.
    if (entry.event.tag === 'PHASE_ADVANCED') {
      baseline = entry.event.tree;
    }
    [state, commands] = step(state, entry.event);
  }

  return { state, commands, contract, contractHash, baseline, plan };
}
