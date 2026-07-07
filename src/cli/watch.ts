import { join } from 'node:path';
import { FileRunLog } from '../runlog/file-runlog';
import type { RunLogEntry } from '../runlog/runlog';
import { runLockActive } from '../runlog/lock';

/**
 * `goaly runs watch <runId>` — attach to a run from ANOTHER terminal and follow it live (operator
 * observability, ADR 0012). Strictly READ-ONLY: it polls the write-ahead log (whose reader already
 * tolerates a torn in-flight tail) and renders each new event as a human line; it never takes the
 * run lock, never mutates, and can therefore watch a run some other process is driving. Exits 0
 * when the run reaches a terminal state; exits 1 when the run is INCOMPLETE and no live process
 * holds its lock (stalled/crashed — the message names the resume command).
 */
export type WatchDeps = {
  /** Poll interval between reads. Default 500 ms. */
  pollMs?: number;
  /** Injected sleep (tests pass a no-op / scripted one). Default a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected run-activity probe (tests). Default: a live pid holds `run.lock`. */
  isActive?: (runDir: string) => Promise<boolean>;
};

const DEFAULT_POLL_MS = 500;
const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function runsWatch(
  runId: string,
  stateDir: string,
  out: (s: string) => void,
  err: (s: string) => void,
  deps: WatchDeps = {},
): Promise<number> {
  const runDir = join(stateDir, runId);
  const log = new FileRunLog(runDir);
  const sleep = deps.sleep ?? realSleep;
  const isActive = deps.isActive ?? runLockActive;
  const pollMs = deps.pollMs ?? DEFAULT_POLL_MS;

  let rendered = 0;
  let iteration = 0;
  let announced = false;

  for (;;) {
    let stored;
    try {
      stored = await log.read();
    } catch (e) {
      err(`run ${runId} is corrupt: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
    if (stored === null) {
      err(`no such run: ${runId} (looked in ${stateDir})\n`);
      return 1;
    }
    if (!announced) {
      announced = true;
      out(`watching ${runId} — goal: ${truncate(stored.header.config.goal, 100)}\n`);
    }

    const fresh = stored.entries.slice(rendered);
    rendered = stored.entries.length;
    for (const entry of fresh) {
      if (entry.event.tag === 'AGENT_RAN') iteration += 1;
      const line = renderWatchEvent(entry, iteration);
      if (line !== null) out(`${line}\n`);
    }
    // Terminal only when the LAST entry says so: a terminal tag mid-log is a superseded outcome —
    // an operator extension (RUN_EXTENDED, ADR 0012) revived the run and later entries continue it.
    const last = stored.entries[stored.entries.length - 1];
    if (last !== undefined && isTerminalTag(last.stateTagAfter)) {
      out(`run ${runId} finished: ${last.stateTagAfter}  (details: goaly runs show ${runId})\n`);
      return 0;
    }

    if (fresh.length === 0 && !(await isActive(runDir))) {
      out(
        `run ${runId} is INCOMPLETE and no live process holds its lock — it stalled or was killed.\n` +
          `Continue it with: goaly --resume ${runId}\n`,
      );
      return 1;
    }
    await sleep(pollMs);
  }
}

function isTerminalTag(tag: string): boolean {
  return tag === 'DONE' || tag === 'FAILED' || tag === 'ABORTED';
}

/**
 * One event → one human line (or null for pure plumbing markers). Timestamps are UTC and stable;
 * free-text details are truncated so a watching terminal stays readable.
 */
export function renderWatchEvent(entry: RunLogEntry, iteration: number): string | null {
  const at = fmtTime(entry.ts);
  const e = entry.event;
  switch (e.tag) {
    case 'PLAN_COMPILED':
      return `${at}  plan compiled: ${e.plan.phases.length} phases + acceptance (${e.plan.planHash})`;
    case 'PLAN_FAILED':
      return `${at}  plan FAILED: ${truncate(e.reason, 120)}`;
    case 'PLAN_SEAL_DECIDED':
      return `${at}  plan seal: ${e.decision.kind}`;
    case 'PHASE_ADVANCED':
      return `${at}  phase advanced (checkpoint taken)`;
    case 'CONTRACT_COMPILED':
      return `${at}  contract compiled: ${e.contract.rungs.length} rung(s), frozen as ${e.contract.contractHash}`;
    case 'COMPILE_FAILED':
      return `${at}  compile FAILED: ${truncate(e.reason, 120)}`;
    case 'SEAL_DECIDED':
      return `${at}  seal: ${e.decision.kind}${e.decision.kind === 'reject' ? ` — ${truncate(e.decision.reason, 80)}` : ''}`;
    case 'WORKSPACE_PREPARED':
      return `${at}  prepare: ${e.prepared.status}${e.setupRan ? ' (setup ran)' : ''}`;
    case 'AGENT_RAN': {
      const changed = e.prevDiffHash !== e.diffHash ? 'tree changed' : 'no changes';
      const tokens = e.run.tokensUsed !== undefined ? `, ${e.run.tokensUsed} tokens` : '';
      return `${at}  iter ${iteration}: agent ${e.run.status} (${changed}${tokens})`;
    }
    case 'VERIFIED': {
      const mark = e.verdict.pass ? 'PASS ✓' : 'FAIL ✗';
      return `${at}  iter ${iteration}: verify ${mark}${e.verdict.pass ? '' : ` — ${truncate(e.verdict.detail, 120)}`}`;
    }
    case 'SIGNOFF_DECIDED':
      return e.approval.veto
        ? `${at}  iter ${iteration}: sign-off VETO — ${truncate(e.approval.reason ?? '', 120)}`
        : `${at}  iter ${iteration}: sign-off approved (both keys turned)`;
    case 'CANDIDATE_RAN':
      return `${at}  iter ${e.iteration}: candidate #${e.index} ${e.pass ? 'passed' : 'failed'} the ladder`;
    case 'CANDIDATE_SELECTED':
      return `${at}  iter ${e.iteration}: candidate #${e.winner} selected`;
    case 'RUN_EXTENDED': {
      const parts = [
        ...(e.maxIterations !== undefined ? [`max-iterations→${e.maxIterations}`] : []),
        ...(e.budgetTokens !== undefined ? [`budget-tokens→${e.budgetTokens}`] : []),
        ...(e.budgetWallMs !== undefined ? [`budget-wall-ms→${e.budgetWallMs}`] : []),
        ...(e.stuck !== undefined ? ['stuck-policy overrides'] : []),
        ...(e.note !== undefined ? [`note: "${truncate(e.note, 60)}"`] : []),
      ];
      return `${at}  operator extension: ${parts.join(', ')}`;
    }
    case 'WAVE_RAN': {
      const merged = e.outcomes.filter((o) => o.kind === 'merged').length;
      const fallback = e.outcomes.length - merged;
      const tail = fallback > 0 ? `, ${fallback} downgraded to sequential` : '';
      return `${at}  wave: ${merged}/${e.outcomes.length} phase(s) merged + re-verified${tail}`;
    }
    case 'CHECKPOINTED':
      return null; // internal diff-baseline plumbing — noise for a human watcher
  }
}

/** Epoch-ms → a compact, timezone-stable `HH:MM:SS` (UTC) so watch lines stay short. */
function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
