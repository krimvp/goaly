import { z } from 'zod';
import { RunId, ContractHash } from '../domain/ids';
import { RunConfig } from '../domain/config';
import { OrchestratorEvent } from '../domain/events';
import { DegradedMode } from '../domain/degraded';

/**
 * SUCCESSOR-RUN provenance (issue #117): where a `--recontract` run came from.
 *
 * A frozen contract is NEVER mutated — invariant #2 in its strictest form: one run owns exactly one
 * contract for its whole life. When a contract is adjudicated DEFECTIVE (`CONTRACT_DEFECTIVE`, issue
 * #116), recovery is therefore a NEW run with a NEW `contractHash` over the SAME (kept) tree, and
 * the link between the two is recorded HERE — compose-time wiring like `harness`/`degraded`, written
 * once at run start, never fed to the reducer and never part of any contract. "The bar was wrong"
 * becomes an auditable chain of frozen contracts instead of an in-place softening.
 *
 * `recontracts` is the run's depth in that chain (1 = the first successor), carried forward from the
 * predecessor's own header so `--max-recontracts` bounds the CHAIN rather than one process.
 */
export const RunProvenance = z.object({
  /** The run this one succeeds — its tree was kept, its contract was not. */
  predecessorRunId: RunId,
  /** The frozen contract that was adjudicated defective (never reused, only recorded). */
  predecessorContractHash: ContractHash,
  /** The adjudication verdict that justified the re-contract (goaly's own read-only adjudicator). */
  verdict: z.string().min(1),
  /** 1 for the first successor in a chain; N for the N-th. Bounded by `--max-recontracts`. */
  recontracts: z.number().int().positive(),
});
export type RunProvenance = z.infer<typeof RunProvenance>;

/**
 * One-time header: the full RunConfig for the run. The frozen contract is captured in the
 * CONTRACT_COMPILED event (logged loudly), so resume reconstructs it by replay.
 *
 * `harness` records WHICH coding-agent CLI produced the run (claude / codex / droid / pi /
 * goaly-code / fake). Harness identity is a compose-time wiring concern, deliberately kept OUT of
 * `RunConfig` (it never enters the frozen contract), so it is captured here instead — the one place
 * that knows it after the run ends. It is OPTIONAL so logs written before this field existed still
 * parse (invariant #6, fail-closed on read). Read by the follow-up resume-hint (Capability A) to
 * print the harness-correct interactive-resume command.
 *
 * `baseline` records the run-start review baseline the workspace was pinned to (an explicit
 * `--baseline`, or the raised-autonomy auto-pin) — compose-time wiring like `harness`, never the
 * frozen contract. Recorded only when it differs from the `HEAD` default; `--resume` re-adopts it
 * so the pin survives a crash (at raised autonomy the agent may have committed mid-run, and falling
 * back to a MOVED HEAD would hand both keys an empty diff). Optional so older logs still parse.
 *
 * `degraded` records a typed DEGRADED-MODE label for the run (issue #125) — today only
 * `self-judged`: the coding agent, the LLM judge rung and the Sign-off approver all resolved to one
 * model, so the two keys share one distribution and a DONE from this run was not independently
 * reviewed. Compose-time wiring like `harness` (it never enters the frozen contract and never
 * reaches the reducer), written once at run start so every downstream report — the terminal summary,
 * `goaly runs show`, the UI — can label the run rather than relying on a startup WARN nobody read.
 * Absent ⇒ no degraded mode (and older logs still parse).
 */
export const RunLogHeader = z.object({
  runId: RunId,
  startedAt: z.number(),
  config: RunConfig,
  harness: z.string().min(1).optional(),
  baseline: z.string().min(1).optional(),
  degraded: DegradedMode.optional(),
  provenance: RunProvenance.optional(),
});
export type RunLogHeader = z.infer<typeof RunLogHeader>;

/**
 * Build a FRESH run's header: the one place that decides which compose-time wiring labels are
 * recorded alongside the config. The `HEAD` baseline is deliberately NOT recorded (re-adopting a
 * symbolic HEAD on resume is a no-op, and omitting it keeps old-log parity), and each absent label
 * is OMITTED rather than written as null, so a log from a run with none is byte-identical to one
 * written before the field existed.
 */
export function freshRunHeader(
  runId: RunId,
  startedAt: number,
  config: RunConfig,
  baseline: string,
  wiring: { harness?: string; degraded?: DegradedMode; provenance?: RunProvenance },
): RunLogHeader {
  return {
    runId,
    startedAt,
    config,
    ...(wiring.harness !== undefined ? { harness: wiring.harness } : {}),
    ...(baseline !== 'HEAD' ? { baseline } : {}),
    ...(wiring.degraded !== undefined ? { degraded: wiring.degraded } : {}),
    ...(wiring.provenance !== undefined ? { provenance: wiring.provenance } : {}),
  };
}

/**
 * One persisted event. The log is the source of truth for resume and is UNTRUSTED on read
 * (a corrupt entry must be rejected, not silently accepted) — hence a full Zod schema.
 * `contractHash` is null for entries before the contract is compiled; once set it must be
 * identical every loop iteration, which is what proves the bar never moved.
 */
export const RunLogEntry = z.object({
  runId: RunId,
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  contractHash: ContractHash.nullable(),
  event: OrchestratorEvent,
  stateTagAfter: z.string(),
});
export type RunLogEntry = z.infer<typeof RunLogEntry>;

/**
 * Write-ahead run log. The Driver `append`s an entry before committing to the new state;
 * because the reducer is pure, replay = fold over the event stream and resume = replay +
 * continue, with no completed iteration repeated.
 */
export interface RunLog {
  writeHeader(header: RunLogHeader): Promise<void>;
  append(entry: RunLogEntry): Promise<void>;
  /** Returns null when no run exists yet. Entries are parsed/validated by the implementation. */
  read(): Promise<{ header: RunLogHeader; entries: RunLogEntry[] } | null>;
}
