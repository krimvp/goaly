import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompiledContract } from '../domain/contract';
import type { ContractHash, RunId } from '../domain/ids';
import type { HarnessRunResult } from '../domain/events';
import type { UsageReport } from '../domain/usage';
import type { Verdict, ApprovalVerdict, GateDecision } from '../domain/verdict';
import { iterationCount, type OrchestratorState } from '../orchestrator/state';
import { errorMessage } from '../util/errors';
import { FileRunLog } from './file-runlog';
import type { RunLogHeader, RunLogEntry } from './runlog';
import { replay } from './replay';
import { summarizeUsage } from './usage';

/**
 * READ-ONLY run-log inspection (issue #14). Everything here is a pure projection over the
 * already-parsed event stream — no mutation, no re-running. The run's *state* (status,
 * iterations, frozen contract) comes from the shared {@link replay} fold so it matches exactly
 * what the Driver computed; the per-iteration / Gate timeline is read straight off the events.
 */

/** A run's outcome: the three terminal verdicts, or INCOMPLETE for a run that never finished. */
export type RunStatus = 'DONE' | 'FAILED' | 'ABORTED' | 'INCOMPLETE';

/** One row of `goaly runs list`. */
export type RunSummary = {
  readonly runId: RunId;
  readonly goal: string;
  readonly status: RunStatus;
  /** The raw final state tag (e.g. RUNNING_AGENT) — distinguishes INCOMPLETE runs. */
  readonly stateTag: OrchestratorState['tag'];
  readonly iterations: number;
  /** Cumulative tokens spent (undefined when no run reported usage). */
  readonly tokensSpent: number | undefined;
  readonly startedAt: number;
  /** Timestamp of the last persisted entry (undefined when only the header was written). */
  readonly endedAt: number | undefined;
  readonly contractHash: ContractHash | null;
};

/** One iteration of the loop, reconstructed from the event timeline. */
export type IterationDetail = {
  /** 1-based iteration number. */
  readonly index: number;
  readonly runStatus: HarnessRunResult['status'];
  /** Whether the agent run changed the working tree (prev vs post diff hash). */
  readonly changed: boolean;
  readonly tokensSpent: number | undefined;
  /** The frozen verifier-ladder verdict for this iteration (undefined if not reached). */
  verdict: Verdict | undefined;
  /** The Gate-B approver verdict (present only when the ladder passed). */
  gateB: ApprovalVerdict | undefined;
};

/** The full `goaly runs show <id>` report. */
export type RunDetail = {
  readonly runId: RunId;
  readonly goal: string;
  readonly status: RunStatus;
  readonly stateTag: OrchestratorState['tag'];
  /** Terminal failure / abort reason (e.g. a stuck detector), when the run ended in one. */
  readonly reason: string | undefined;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly iterations: number;
  readonly tokensSpent: number | undefined;
  /** Per-layer token spend (harness vs. the LLM steps), folded from the event log (issue #17). */
  readonly usage: UsageReport;
  /** The frozen success contract (its hash is `contract.contractHash`); null before compile. */
  readonly contract: CompiledContract | null;
  readonly contractHash: ContractHash | null;
  /** Any failed compile attempts (reasons), in order. */
  readonly compileFailures: readonly string[];
  /** Gate A decisions in order (revise rounds, then a final approve/reject). */
  readonly gateA: readonly GateDecision[];
  readonly iterationsDetail: readonly IterationDetail[];
};

/** A `runs list` row: a parsed summary, or a corrupt-log flag (fail-closed, never silent). */
export type RunListItem =
  | { readonly ok: true; readonly summary: RunSummary }
  | { readonly ok: false; readonly runId: string; readonly error: string };

/** The result of `runs show <id>`: a detail, or a corrupt-log flag. `null` = no such run. */
export type RunReadResult =
  | { readonly ok: true; readonly detail: RunDetail }
  | { readonly ok: false; readonly runId: string; readonly error: string };

// ---- pure projections -----------------------------------------------------

export function runSummary(header: RunLogHeader, entries: readonly RunLogEntry[]): RunSummary {
  const { state, contractHash } = replay(header.config, entries);
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  return {
    runId: header.runId,
    goal: header.config.goal,
    status: statusOf(state),
    stateTag: state.tag,
    iterations: iterationCount(state),
    tokensSpent: lastTokensSpent(entries),
    startedAt: header.startedAt,
    endedAt: last?.ts,
    contractHash,
  };
}

export function runDetail(header: RunLogHeader, entries: readonly RunLogEntry[]): RunDetail {
  const { state, contract, contractHash } = replay(header.config, entries);
  const last = entries.length > 0 ? entries[entries.length - 1] : undefined;
  return {
    runId: header.runId,
    goal: header.config.goal,
    status: statusOf(state),
    stateTag: state.tag,
    reason: terminalReason(state),
    startedAt: header.startedAt,
    endedAt: last?.ts,
    iterations: iterationCount(state),
    tokensSpent: lastTokensSpent(entries),
    usage: summarizeUsage(
      entries.map((e) => e.event),
      header.config.budget,
    ),
    contract,
    contractHash,
    compileFailures: collectCompileFailures(entries),
    gateA: collectGateA(entries),
    iterationsDetail: collectIterations(entries),
  };
}

function statusOf(state: OrchestratorState): RunStatus {
  if (state.tag === 'DONE' || state.tag === 'FAILED' || state.tag === 'ABORTED') return state.tag;
  return 'INCOMPLETE';
}

function terminalReason(state: OrchestratorState): string | undefined {
  return state.tag === 'FAILED' || state.tag === 'ABORTED' ? state.reason : undefined;
}

/** Cumulative tokens = the last AGENT_RAN budget snapshot that reported a count. */
function lastTokensSpent(entries: readonly RunLogEntry[]): number | undefined {
  let tokens: number | undefined;
  for (const e of entries) {
    if (e.event.tag === 'AGENT_RAN' && e.event.budget.tokensSpent !== undefined) {
      tokens = e.event.budget.tokensSpent;
    }
  }
  return tokens;
}

function collectCompileFailures(entries: readonly RunLogEntry[]): string[] {
  const out: string[] = [];
  for (const e of entries) if (e.event.tag === 'COMPILE_FAILED') out.push(e.event.reason);
  return out;
}

function collectGateA(entries: readonly RunLogEntry[]): GateDecision[] {
  const out: GateDecision[] = [];
  for (const e of entries) if (e.event.tag === 'GATE_A_DECIDED') out.push(e.event.decision);
  return out;
}

/**
 * Group the loop events into per-iteration records. Each AGENT_RAN opens an iteration; the
 * following VERIFIED is its ladder verdict and the following GATE_B_DECIDED its approver verdict.
 */
function collectIterations(entries: readonly RunLogEntry[]): IterationDetail[] {
  const out: IterationDetail[] = [];
  for (const e of entries) {
    const ev = e.event;
    if (ev.tag === 'AGENT_RAN') {
      out.push({
        index: out.length + 1,
        runStatus: ev.run.status,
        changed: ev.prevDiffHash !== ev.diffHash,
        tokensSpent: ev.budget.tokensSpent,
        verdict: undefined,
        gateB: undefined,
      });
    } else if (ev.tag === 'VERIFIED') {
      const cur = out[out.length - 1];
      if (cur !== undefined) cur.verdict = ev.verdict;
    } else if (ev.tag === 'GATE_B_DECIDED') {
      const cur = out[out.length - 1];
      if (cur !== undefined) cur.gateB = ev.approval;
    }
  }
  return out;
}

// ---- filesystem layer (read-only) -----------------------------------------

/**
 * List every run under `stateDir`, most-recent first. A directory without a header is not a run
 * (skipped); a run whose log fails to parse is FLAGGED (never silently dropped, invariant #6).
 * A missing `stateDir` is simply "no runs yet".
 */
export async function listRuns(stateDir: string): Promise<RunListItem[]> {
  let names: string[];
  try {
    const dirents = await readdir(stateDir, { withFileTypes: true });
    names = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err: unknown) {
    if (isNotFound(err)) return [];
    throw err;
  }

  const items = await Promise.all(names.map((name) => loadListItem(stateDir, name)));
  const present = items.filter((i): i is RunListItem => i !== null);

  const ok = present
    .filter((i): i is Extract<RunListItem, { ok: true }> => i.ok)
    .sort((a, b) => b.summary.startedAt - a.summary.startedAt);
  const bad = present
    .filter((i): i is Extract<RunListItem, { ok: false }> => !i.ok)
    .sort((a, b) => a.runId.localeCompare(b.runId));
  return [...ok, ...bad];
}

async function loadListItem(stateDir: string, name: string): Promise<RunListItem | null> {
  let stored;
  try {
    stored = await new FileRunLog(join(stateDir, name)).read();
  } catch (err: unknown) {
    return { ok: false, runId: name, error: errorMessage(err) };
  }
  if (stored === null) return null; // not a run directory (no header.json)
  return { ok: true, summary: runSummary(stored.header, stored.entries) };
}

/** Read one run's detail. `null` = no such run; `{ ok: false }` = the run's log is corrupt. */
export async function readRun(stateDir: string, runId: string): Promise<RunReadResult | null> {
  let stored;
  try {
    stored = await new FileRunLog(join(stateDir, runId)).read();
  } catch (err: unknown) {
    return { ok: false, runId, error: errorMessage(err) };
  }
  if (stored === null) return null;
  return { ok: true, detail: runDetail(stored.header, stored.entries) };
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
