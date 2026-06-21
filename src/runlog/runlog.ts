import { z } from 'zod';
import { RunId, ContractHash } from '../domain/ids';
import { RunConfig } from '../domain/config';
import { OrchestratorEvent } from '../domain/events';

/**
 * One-time header: the full RunConfig for the run. The frozen contract is captured in the
 * CONTRACT_COMPILED event (logged loudly), so resume reconstructs it by replay.
 */
export const RunLogHeader = z.object({
  runId: RunId,
  startedAt: z.number(),
  config: RunConfig,
});
export type RunLogHeader = z.infer<typeof RunLogHeader>;

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
