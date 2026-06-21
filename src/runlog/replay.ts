import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { Command } from '../domain/events';
import type { ContractHash } from '../domain/ids';
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

  for (const entry of entries) {
    if (entry.event.tag === 'CONTRACT_COMPILED') {
      contract = entry.event.contract;
      contractHash = entry.event.contract.contractHash;
    }
    [state, commands] = step(state, entry.event);
  }

  return { state, commands, contract, contractHash };
}
