import type { Command, OrchestratorEvent } from '../domain/events';
import type { ContractHash, RunId } from '../domain/ids';
import { coerceSessionId, DiffHash } from '../domain/ids';
import type { Verifier } from '../verify/verifier';
import type { OrchestratorState } from '../orchestrator/state';
import { iterationCount } from '../orchestrator/state';
import { noopLogger } from '../log/logger';
import { errorMessage } from '../util/errors';
import { runBestOf, type CandidateResult } from './tournament';
import type { DriverDeps } from './driver';

/**
 * The performed best-of-N result fed back into the main loop: the winner's event + advanced seq. Shares
 * the optional `ladder` shape with the Driver's `Performed` so the loop handles both uniformly (best-of
 * never builds a ladder — it reuses the compile-time one — so `ladder` is always absent here).
 */
export type BestOfPerformed = { event: OrchestratorEvent; ladder?: Verifier; seq?: number };

/** Distinct sentinel tree hashes for a fail-closed best-of-N crash (kept != each other). */
const SENTINEL_PREV_HASH = DiffHash.parse('0000000');
const SENTINEL_POST_HASH = DiffHash.parse('0000001');

/**
 * The best-of-N start floor (issue #85, locked decision #8). Returns a fail-closed refusal reason, or
 * null when the run may proceed. Requires a wired {@link DriverDeps.worktrees} AND a resolvable HEAD
 * (git worktree cannot snapshot an unborn tree). Fail-closed: a host whose `headResolves` throws is
 * treated as unresolved (refuse), never an unhandled rejection.
 */
export async function bestOfFloor(deps: DriverDeps): Promise<string | null> {
  if (deps.worktrees === undefined) {
    return 'best-of-N (--candidates > 1) requires a worktree host, but none was configured';
  }
  let resolves = false;
  try {
    resolves = await deps.worktrees.headResolves();
  } catch {
    resolves = false;
  }
  if (!resolves) {
    return (
      'best-of-N (--candidates > 1) requires a committed HEAD: this repo has no resolvable HEAD ' +
      '(an unborn branch). Make an initial commit, or run with --candidates 1.'
    );
  }
  return null;
}

/**
 * Perform a whole best-of-N tournament (issue #85). Reconstruct any already-logged candidates for this
 * iteration from the run log (resume reads them back, never re-runs them), run the not-yet-logged ones
 * in isolated worktrees, append CANDIDATE_RAN/CANDIDATE_SELECTED markers write-ahead (advancing `seq`),
 * promote the winner's tree, and return ONE AGENT_RAN event for the winner. Fail-closed (invariant #4):
 * a thrown tournament (e.g. promotion fails) becomes a crashed AGENT_RAN with sentinel hashes — the
 * loop proceeds to a clean ABORTED/FAILED, never an unhandled rejection.
 */
export async function performBestOf(
  command: Extract<Command, { tag: 'RUN_AGENT_BEST_OF' }>,
  deps: DriverDeps,
  ladder: Verifier | null,
  state: OrchestratorState,
  runId: RunId,
  contractHash: ContractHash | null,
  startSeq: number,
  resumeIncomplete: 'rerun' | 'collapse',
): Promise<BestOfPerformed> {
  try {
    return await runTournament(command, deps, ladder, state, runId, contractHash, startSeq, resumeIncomplete);
  } catch (e) {
    // Fail-closed: a tournament that throws (promotion failure, host error) becomes a crashed run with
    // DISTINCT sentinel hashes so no-diff doesn't false-fire; the frozen verifier then runs and the
    // loop proceeds toward a clean ABORTED/FAILED rather than an unhandled rejection.
    (deps.logger ?? noopLogger).warn('best-of-N tournament error (fail-closed → crashed run)', {
      reason: errorMessage(e),
    });
    return {
      event: {
        tag: 'AGENT_RAN',
        run: {
          output: `best-of-N error: ${errorMessage(e)}`,
          sessionId: command.sessionId ?? coerceSessionId(undefined, 'best-of-error'),
          status: 'crashed',
        },
        prevDiffHash: SENTINEL_PREV_HASH,
        diffHash: SENTINEL_POST_HASH,
        budget: deps.budget.snapshot(),
      },
    };
  }
}

/** The success path of {@link performBestOf} — throws on any failure for the wrapper to fail-close. */
async function runTournament(
  command: Extract<Command, { tag: 'RUN_AGENT_BEST_OF' }>,
  deps: DriverDeps,
  ladder: Verifier | null,
  state: OrchestratorState,
  runId: RunId,
  contractHash: ContractHash | null,
  startSeq: number,
  resumeIncomplete: 'rerun' | 'collapse',
): Promise<BestOfPerformed> {
  // The candidate set belongs to the iteration ABOUT to run: ctx.iteration counts COMPLETED runs, so
  // this is the next (1-based) iteration — the marker key resume reconstructs against.
  const iteration =
    state.tag === 'RUNNING_AGENT' ? state.ctx.iteration + 1 : iterationCount(state) + 1;
  const contract = state.tag === 'RUNNING_AGENT' ? state.ctx.contract : null;
  if (deps.worktrees === undefined || ladder === null || contract === null) {
    throw new Error('best-of-N invoked without a worktree host / ladder / contract');
  }

  const baselineRef = deps.workspace.currentBaseline();
  const baselineHash = await deps.workspace.diffHash();
  const prior = await reconstructPriorCandidates(deps, iteration);

  let seq = startSeq;
  const appendMarker = async (event: OrchestratorEvent): Promise<void> => {
    seq += 1;
    await deps.runlog.append({ runId, seq, ts: deps.clock.now(), contractHash, event, stateTagAfter: state.tag });
  };

  const winner = await runBestOf(
    {
      contract,
      ladder,
      harness: deps.harness,
      worktrees: deps.worktrees,
      budget: deps.budget,
      appendMarker,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      ...(deps.onStreamEvent !== undefined
        ? { onStreamEvent: (event) => deps.onStreamEvent?.('agent', event) }
        : {}),
      prior,
      resumeIncomplete,
    },
    {
      prompt: command.prompt,
      sessionId: command.sessionId,
      candidates: command.candidates,
      iteration,
      baseline: baselineRef,
      baselineHash,
    },
  );

  return {
    event: { tag: 'AGENT_RAN', run: winner.run, prevDiffHash: baselineHash, diffHash: winner.tree, budget: winner.budget },
    seq,
  };
}

/**
 * Reconstruct the candidates already logged for `iteration` (issue #85, invariant #7) by reading the
 * CANDIDATE_RAN markers back from the write-ahead log. On `--resume` these are NEVER re-run — they are
 * read back verbatim and re-selected deterministically. Fail-safe to "none logged" if the log can't be
 * read (the tournament then runs all K — at-least-once, never a lost iteration).
 */
async function reconstructPriorCandidates(
  deps: DriverDeps,
  iteration: number,
): Promise<{ candidates: CandidateResult[]; selected: boolean }> {
  try {
    const stored = await deps.runlog.read();
    if (stored === null) return { candidates: [], selected: false };
    const candidates: CandidateResult[] = [];
    let selected = false;
    for (const entry of stored.entries) {
      const ev = entry.event;
      if (ev.tag === 'CANDIDATE_RAN' && ev.iteration === iteration) {
        // Graded depth (issue #85): read the persisted score back so resume re-selection uses the
        // SAME graded key. A log written before graded ranking omits the fields — fall back to the
        // boolean (`pass ? rungsTotal : 0`) so old logs still re-select deterministically.
        const rungsTotal = ev.rungsTotal ?? 1;
        const rungsPassed = ev.rungsPassed ?? (ev.pass ? rungsTotal : 0);
        candidates.push({
          index: ev.index,
          pass: ev.pass,
          rungsPassed,
          rungsTotal,
          tree: ev.tree,
          budget: ev.budget,
          run: ev.run,
        });
      }
      if (ev.tag === 'CANDIDATE_SELECTED' && ev.iteration === iteration) selected = true;
    }
    return { candidates, selected };
  } catch {
    return { candidates: [], selected: false };
  }
}
