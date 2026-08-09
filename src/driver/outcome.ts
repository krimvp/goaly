import type { OrchestratorState } from '../orchestrator/state';
import type { RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';

/**
 * Project a TERMINAL reducer state onto the run's typed outcome. Pure and total over the three
 * terminal tags; a non-terminal tag is a driver bug, not a run failure, so it throws rather than
 * inventing an outcome (`drive()` calls it only after `isTerminal`).
 *
 * Lives outside `driver.ts` purely to keep that module under its size ratchet — it is the same
 * projection the Driver has always applied, with no behavior change.
 */
export function buildOutcome(state: OrchestratorState, runId: RunId): RunOutcome {
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
