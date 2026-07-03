import type { OrchestratorEvent, RunOutcome } from '../domain/events';
import type { OrchestratorState } from '../orchestrator/state';
import type { RunId } from '../domain/ids';

/**
 * A single observability datapoint the main run flow emits as it progresses. Telemetry is a PURE
 * side-channel — the same class of seam as the {@link import('../log/logger').Logger diagnostic
 * logger} and the `--explain` {@link import('../observe/observer').Observer}: it is fed lifecycle
 * facts the Driver already has, but it is NEVER read by the pure reducer, NEVER written to the
 * write-ahead replay log, and can NEVER touch the frozen contract, the verifier ladder, or the
 * two-key DONE. It exists only so an embedder can meter / trace a run (spend, phase timings, drop
 * rates) without reaching into control flow.
 *
 * The variants mirror the run's arc — one `run_started`, one `lifecycle` beat per reducer event
 * folded in the loop (compile → run → verify → sign-off → …), and one `run_finished` at the
 * terminal outcome.
 */
export type TelemetryEvent =
  | {
      /** The run began (fresh or `--resume`). Emitted once, before the first command. */
      kind: 'run_started';
      runId: RunId;
      /** Whether this invocation is resuming an existing run log. */
      resume: boolean;
      /** The Driver clock reading when the event was recorded (monotonic within a run). */
      ts: number;
    }
  | {
      /**
       * A reducer event was performed and folded — the per-step lifecycle beat. `event` is the
       * {@link OrchestratorEvent} tag that just advanced the machine; `stateAfter` is the state tag
       * the pure reducer transitioned into as a result.
       */
      kind: 'lifecycle';
      runId: RunId;
      event: OrchestratorEvent['tag'];
      stateAfter: OrchestratorState['tag'];
      ts: number;
    }
  | {
      /** The run reached a terminal outcome (DONE / FAILED / ABORTED). Emitted once, at the end. */
      kind: 'run_finished';
      runId: RunId;
      status: RunOutcome['status'];
      iterations: number;
      ts: number;
    };

/**
 * The telemetry seam: a synchronous, fire-and-forget sink for {@link TelemetryEvent}s. `record` is
 * intentionally `void` and non-async — it must never block the run loop or push work onto the
 * durability path. Implementations are expected to be fast and total, but the Driver treats every
 * sink as UNTRUSTED and guards each call, so a throwing or slow sink can never crash or wedge a run
 * (invariant #4, fail-closed observability).
 */
export interface Telemetry {
  record(event: TelemetryEvent): void;
}

/** The safe default when no telemetry is wired: discards every event. */
export const noopTelemetry: Telemetry = {
  record(): void {
    /* intentionally empty — observability is off by default */
  },
};
