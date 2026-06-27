/**
 * Slice 2 — the trajectory exporter. The expensive part of coding-agent training is labeling; goaly
 * labels every run for free. The write-ahead run log already records the per-iteration verifier-ladder
 * verdicts and the Sign-off approver decision (the TWO KEYS), and the goaly-code session store records
 * the actual tool-use trajectory (the messages). This module JOINS the two into one
 * {@link TrajectoryRecord} per run: the conversation in our exact tool schema, labeled with its
 * ladder/approver outcome.
 *
 * `passed` is the label and it is reward-hacking-resistant by construction: it is true only when the
 * run reached DONE — the frozen ladder passed AND the independent approver did not veto (invariant
 * #3). A trajectory cannot be labeled "good" by weakening the bar.
 *
 * Only goaly-code runs carry a session store (our loop owns the history); a CLI-harness run exports
 * with empty `messages` (no trajectory to learn from), which the dataset filter drops.
 */

import { join } from 'node:path';
import type { ChatMessage } from '../llm-client/schema';
import type { SessionId } from '../domain/ids';
import { FileRunLog } from '../runlog/file-runlog';
import { runDetail, type RunDetail, type RunStatus } from '../runlog/inspect';
import type { RunLogHeader, RunLogEntry } from '../runlog/runlog';
import type { SessionStore } from '../goaly-code/session-store';

/** Per-iteration label: the harness run status plus the two keys (ladder pass, approver veto). */
export type LadderOutcome = {
  iteration: number;
  /** The harness run status for this iteration (`completed` | `crashed` | `truncated` | `timeout`). */
  runStatus: string;
  /** Whether the agent changed the tree this iteration. */
  changed: boolean;
  /** The frozen verifier-ladder verdict (undefined if the iteration never reached verification). */
  ladderPassed: boolean | undefined;
  /** The Sign-off approver decision (present only when the ladder passed; true = vetoed). */
  approverVetoed: boolean | undefined;
  tokens: number | undefined;
};

/** One run as a labeled trajectory: the conversation + the ladder/approver outcome (the free label). */
export type TrajectoryRecord = {
  runId: string;
  goal: string;
  /** The frozen contract's ordered bar (the success criterion the trajectory was graded against). */
  rungs: Array<{ kind: 'deterministic' | 'judge'; label: string }>;
  status: RunStatus;
  /** THE LABEL: DONE means the frozen ladder passed AND the approver did not veto (two keys). */
  passed: boolean;
  iterations: number;
  tokens: number | undefined;
  ladder: LadderOutcome[];
  sessionId: string;
  /** The tool-use trajectory in goaly-code's exact tool schema (empty for a non-goaly-code run). */
  messages: ChatMessage[];
};

function rungLabel(r: { kind: 'deterministic' | 'judge'; command?: string; rubric?: string }): {
  kind: 'deterministic' | 'judge';
  label: string;
} {
  return r.kind === 'deterministic'
    ? { kind: 'deterministic', label: r.command ?? '' }
    : { kind: 'judge', label: (r.rubric ?? '').slice(0, 80) };
}

/** Build the labeled record from a reconstructed {@link RunDetail} + the loaded message trajectory. */
export function buildTrajectoryRecord(
  detail: RunDetail,
  sessionId: string,
  messages: ChatMessage[],
): TrajectoryRecord {
  return {
    runId: detail.runId,
    goal: detail.goal,
    rungs: (detail.contract?.rungs ?? []).map(rungLabel),
    status: detail.status,
    passed: detail.status === 'DONE',
    iterations: detail.iterations,
    tokens: detail.tokensSpent,
    ladder: detail.iterationsDetail.map((it) => ({
      iteration: it.index,
      runStatus: it.runStatus,
      changed: it.changed,
      ladderPassed: it.verdict?.pass,
      approverVetoed: it.signoff?.veto,
      tokens: it.tokensSpent,
    })),
    sessionId,
    messages,
  };
}

/** The session id of the last AGENT_RAN (the session that holds the full, grown trajectory). */
export function lastSessionId(entries: readonly RunLogEntry[]): SessionId | undefined {
  let sid: SessionId | undefined;
  for (const e of entries) if (e.event.tag === 'AGENT_RAN') sid = e.event.run.sessionId;
  return sid;
}

/**
 * Export one run as a labeled trajectory: read its write-ahead log, project it with the shared
 * `runDetail` (so the labels match exactly what the Driver computed), then load the goaly-code message
 * history for the run's session. Returns `null` when no such run exists. The log reader is injectable
 * so this is unit-testable without disk.
 */
export async function exportRunTrajectory(opts: {
  stateDir: string;
  runId: string;
  sessionStore: SessionStore;
  read?: (dir: string) => Promise<{ header: RunLogHeader; entries: RunLogEntry[] } | null>;
}): Promise<TrajectoryRecord | null> {
  const read = opts.read ?? ((dir) => new FileRunLog(dir).read());
  const stored = await read(join(opts.stateDir, opts.runId));
  if (stored === null) return null;
  const detail = runDetail(stored.header, stored.entries);
  const sid = lastSessionId(stored.entries);
  const messages = sid !== undefined ? ((await opts.sessionStore.load(sid)) ?? []) : [];
  return buildTrajectoryRecord(detail, sid ?? '', messages);
}
