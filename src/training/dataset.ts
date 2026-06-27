/**
 * Slice 3 (data pipeline) — rejection-sampling SFT dataset assembly. Given exported
 * {@link TrajectoryRecord}s, keep only the ones that PASSED the frozen ladder + approver (optionally
 * also minimal-diff / few-iteration), and serialize them as SFT examples in goaly-code's exact tool
 * schema. That filtered set is high-quality, automatically-labeled training data — the cheap first win
 * of the training arc. The actual fine-tune (a provider FT API or local LoRA) consumes this JSONL; it
 * is NOT run here (it needs GPU / an FT endpoint).
 *
 * Pure functions over records — no IO, no model — so the selection criteria are fully unit-testable.
 */

import type { ChatMessage } from '../llm-client/schema';
import { DEFAULT_TOOLS, toApiTools } from '../goaly-code/tools';
import type { TrajectoryRecord } from './trajectory';

/** One supervised example in the OpenAI fine-tuning shape: a full conversation + the tool schema. */
export type SftExample = {
  messages: ChatMessage[];
  tools: ReturnType<typeof toApiTools>;
};

export type SelectOptions = {
  /** Drop trajectories with no recorded messages (a non-goaly-code run). Default true. */
  requireMessages?: boolean;
  /** Keep only trajectories that converged within N iterations (minimality). Default: no cap. */
  maxIterations?: number;
};

/**
 * The rejection-sampling filter: keep PASSED trajectories (DONE = ladder pass + no veto), with a
 * trajectory to learn from, optionally bounded by iteration count. The label is the frozen oracle, so
 * a kept example cannot have won by weakening the bar.
 */
export function selectPassing(
  records: readonly TrajectoryRecord[],
  opts: SelectOptions = {},
): TrajectoryRecord[] {
  const requireMessages = opts.requireMessages !== false;
  return records.filter(
    (r) =>
      r.passed &&
      (!requireMessages || r.messages.length > 0) &&
      (opts.maxIterations === undefined || r.iterations <= opts.maxIterations),
  );
}

/** Turn one passing trajectory into a self-contained SFT example (conversation + our tool schema). */
export function toSftExample(record: TrajectoryRecord): SftExample {
  return { messages: record.messages, tools: toApiTools(DEFAULT_TOOLS) };
}

/** Serialize the selected passing trajectories as newline-delimited SFT JSON (one example per line). */
export function toSftJsonl(records: readonly TrajectoryRecord[], opts: SelectOptions = {}): string {
  const examples = selectPassing(records, opts).map((r) => JSON.stringify(toSftExample(r)));
  return examples.length === 0 ? '' : `${examples.join('\n')}\n`;
}

export type DatasetStats = {
  total: number;
  passing: number;
  selected: number;
  byStatus: Record<string, number>;
};

/** Summarize a record set: totals, how many passed, how many the filter keeps, and a status histogram. */
export function datasetStats(
  records: readonly TrajectoryRecord[],
  opts: SelectOptions = {},
): DatasetStats {
  const byStatus: Record<string, number> = {};
  for (const r of records) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    total: records.length,
    passing: records.filter((r) => r.passed).length,
    selected: selectPassing(records, opts).length,
    byStatus,
  };
}
