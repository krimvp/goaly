import type { OrchestratorEvent, BudgetSnapshot, HarnessRunResult } from '../domain/events';
import type { CompiledContract } from '../domain/contract';
import type { DiffHash, SessionId } from '../domain/ids';
import { coerceSessionId } from '../domain/ids';
import type { Verifier } from '../verify/verifier';
import type { HarnessAdapter } from '../harness/adapter';
import type { Workspace, WorktreeHost, Worktree } from '../workspace/workspace';
import type { BudgetMeter } from './budget';
import { noopLogger, type Logger } from '../log/logger';
import { errorMessage } from '../util/errors';
import type { AgentEventSink } from '../agent-cli/stream';

/**
 * One best-of-N candidate's recorded result (issue #85). Exactly the data the pure {@link selectWinner}
 * ranks on — `pass` (frozen-ladder boolean), `budget` (cost), `index` (stable tie-break) — plus the
 * `tree` to promote and the `run` re-fed as the winner's AGENT_RAN. Reconstructable from a CANDIDATE_RAN
 * marker on `--resume`, which is why a completed candidate is never re-run.
 */
export type CandidateResult = {
  readonly index: number;
  readonly pass: boolean;
  readonly tree: DiffHash;
  readonly budget: BudgetSnapshot;
  readonly run: HarnessRunResult;
};

/**
 * The pure tournament rule (issue #85, locked decision #2). Rank candidates by, in order:
 *  (a) frozen-ladder boolean pass — a passing candidate beats ANY failing one;
 *  (b) lower token cost (from the candidate's BudgetSnapshot; unknown spend sorts as most-expensive);
 *  (c) lowest candidate index (stable).
 * If all K fail, the winner is the least-cost failing candidate (the iteration is a normal red that
 * loops through decide() unchanged). NO second scorer that could disagree with the frozen ladder.
 * Pure + total over the recorded set; throws ONLY on an empty set, which the Driver guards upstream.
 */
export function selectWinner(candidates: readonly CandidateResult[]): CandidateResult {
  if (candidates.length === 0) {
    throw new Error('selectWinner: empty candidate set (the Driver must guard this)');
  }
  return [...candidates].sort(compareCandidates)[0]!;
}

/** A spend that cannot be read sorts as most-expensive so it loses every cost tie-break. */
function costOf(c: CandidateResult): number {
  return c.budget.tokensSpent ?? Number.POSITIVE_INFINITY;
}

/** Strict-weak ordering for {@link selectWinner}: pass desc, then cost asc, then index asc (stable). */
function compareCandidates(a: CandidateResult, b: CandidateResult): number {
  if (a.pass !== b.pass) return a.pass ? -1 : 1; // a passing candidate sorts first
  const costDelta = costOf(a) - costOf(b);
  if (costDelta !== 0) return costDelta;
  return a.index - b.index;
}

/** What the tournament feeds back as the winner's AGENT_RAN payload (same shape the Driver builds). */
export type BestOfWinner = {
  readonly run: HarnessRunResult;
  readonly tree: DiffHash;
  readonly budget: BudgetSnapshot;
};

/** Append a write-ahead marker event; the Driver supplies this to persist before state advances. */
export type AppendMarker = (event: OrchestratorEvent) => Promise<void>;

export type BestOfDeps = {
  contract: CompiledContract;
  ladder: Verifier;
  harness: HarnessAdapter;
  worktrees: WorktreeHost;
  budget: BudgetMeter;
  /** Persist a marker (CANDIDATE_RAN / CANDIDATE_SELECTED) write-ahead before state advances. */
  appendMarker: AppendMarker;
  logger?: Logger;
  onStreamEvent?: AgentEventSink;
  /** Marker events already logged for THIS iteration (resume): completed candidates + a selection. */
  prior?: { candidates: readonly CandidateResult[]; selected: boolean };
};

export type BestOfInput = {
  prompt: string;
  sessionId: SessionId | undefined;
  candidates: number;
  /** 1-based loop iteration this candidate set belongs to (the markers' `iteration`). */
  iteration: number;
  /** The baseline tree the K worktrees are checked out at (the current diff baseline ref/SHA). */
  baseline: string;
  /** The baseline tree as a branded DiffHash — a fail-closed candidate's safe no-op tree. */
  baselineHash: DiffHash;
};

/**
 * Run the whole best-of-N tournament (issue #85, locked decision #3) — entirely Driver-side, so NONE
 * of it touches the pure reducer. For each not-yet-logged candidate index: create an isolated worktree
 * off the baseline tree, run the harness + score the frozen ladder there, append a CANDIDATE_RAN marker
 * write-ahead, and tear the worktree down (try/finally on EVERY exit path). Already-logged candidates
 * (resume) are read back from `prior`, never re-run. Then select deterministically, append
 * CANDIDATE_SELECTED, PROMOTE the winner's tree into the canonical workspace, and return the winner's
 * AGENT_RAN payload. Fail-closed (invariant #4): a candidate that throws/times out scores a hard red
 * and can't win on merit; the function only throws if even promotion fails (the Driver maps that to a
 * fail-closed crashed AGENT_RAN, never a rejection).
 */
export async function runBestOf(deps: BestOfDeps, input: BestOfInput): Promise<BestOfWinner> {
  const log = deps.logger ?? noopLogger;
  const prior = deps.prior ?? { candidates: [], selected: false };
  const done = new Map(prior.candidates.map((c) => [c.index, c]));

  const pending: Promise<CandidateResult>[] = [];
  for (let index = 0; index < input.candidates; index++) {
    if (done.has(index)) continue; // logged on a prior run — read back, never re-run (invariant #7)
    pending.push(runCandidate(deps, input, index, log));
  }
  // Fan the not-yet-logged candidates out concurrently (locked decision #3: Promise.all).
  const fresh = await Promise.all(pending);

  const results: CandidateResult[] = [...prior.candidates];
  for (const r of fresh) {
    // Append the marker write-ahead AS each candidate completes (resume reconstructs it).
    await appendCandidateRan(deps.appendMarker, input.iteration, r);
    results.push(r);
  }

  results.sort((a, b) => a.index - b.index);
  const winner = selectWinner(results);
  log.info('best-of-N selected', {
    iteration: input.iteration,
    candidates: results.length,
    winner: winner.index,
    pass: winner.pass,
  });

  // Selection marker BEFORE promotion + the winner's AGENT_RAN (resume knows the choice was made).
  await deps.appendMarker({
    tag: 'CANDIDATE_SELECTED',
    iteration: input.iteration,
    winner: winner.index,
    tree: winner.tree,
  });
  await deps.worktrees.promoteTree(winner.tree);
  // The winner's AGENT_RAN carries the CUMULATIVE budget snapshot (all K candidates' spend recorded),
  // so `exceeded` correctly reflects total tournament spend for stuck/budget detection (invariant #8).
  return { run: winner.run, tree: winner.tree, budget: deps.budget.snapshot() };
}

/** Persist one CANDIDATE_RAN marker (write-ahead) for a freshly-completed candidate. */
async function appendCandidateRan(
  append: AppendMarker,
  iteration: number,
  c: CandidateResult,
): Promise<void> {
  await append({
    tag: 'CANDIDATE_RAN',
    iteration,
    index: c.index,
    tree: c.tree,
    budget: c.budget,
    pass: c.pass,
    run: c.run,
  });
}

/**
 * Run ONE candidate in its own isolated worktree (issue #85). Create the worktree off the baseline,
 * run the harness in it, snapshot its post-tree, score the frozen ladder against it, and tear the
 * worktree down on EVERY exit path (try/finally). Fail-closed (invariant #4): any throw — worktree
 * creation, harness, or ladder — becomes a hard-red candidate (a crashed run, `pass: false`) that
 * cannot win on merit, never an unhandled rejection.
 */
async function runCandidate(
  deps: BestOfDeps,
  input: BestOfInput,
  index: number,
  log: Logger,
): Promise<CandidateResult> {
  let worktree: Worktree | undefined;
  try {
    worktree = await deps.worktrees.addWorktree(input.baseline);
    const run = await deps.harness.run(input.prompt, input.sessionId, deps.onStreamEvent);
    // Record into the SHARED meter (the run-budget cap counts every candidate's spend), but the
    // candidate's OWN cost — its selection tie-break — is captured from THIS run alone so ranking is
    // independent of the concurrent fan-out order (the shared cumulative snapshot would race).
    deps.budget.record(run.tokensUsed, estimatedTokens(run));
    const tree = await worktree.scope.diffHash();
    const pass = await scoreLadder(deps.ladder, worktree.scope, deps.contract);
    return { index, pass, tree, budget: candidateCost(run), run };
  } catch (e) {
    log.warn('best-of-N candidate failed (scored as a hard red)', {
      iteration: input.iteration,
      index,
      reason: errorMessage(e),
    });
    return failedCandidate(input, index, e);
  } finally {
    if (worktree !== undefined) await safeRemove(deps, worktree, log);
  }
}

/** The portion of a run's count that is a local estimate (issue #24), 0 otherwise. */
function estimatedTokens(run: HarnessRunResult): number {
  return run.tokenSource === 'estimated' && run.tokensUsed !== undefined ? run.tokensUsed : 0;
}

/**
 * The candidate's OWN cost — the second-key selection tie-break (locked decision #2). Built from THIS
 * run's tokens alone (not the shared cumulative meter) so ranking is deterministic regardless of the
 * concurrent fan-out order. `exceeded` is false here: the budget cap is a RUN-level concern enforced on
 * the winner's cumulative AGENT_RAN snapshot, never a per-candidate ranking input. Unknown spend is
 * omitted, which {@link selectWinner} treats as most-expensive (it loses every cost tie-break).
 */
function candidateCost(run: HarnessRunResult): BudgetSnapshot {
  return {
    ...(run.tokensUsed !== undefined ? { tokensSpent: run.tokensUsed } : {}),
    exceeded: false,
  };
}

/**
 * Score the frozen ladder against a candidate's worktree, fail-closed (invariant #4): a ladder that
 * throws is a hard red, never a pass. Mirrors the Driver's `runVerifierFailClosed` wrapper so the
 * tournament can never green a candidate the ladder couldn't actually grade.
 */
async function scoreLadder(
  ladder: Verifier,
  scope: Workspace,
  contract: CompiledContract,
): Promise<boolean> {
  try {
    const verdict = await ladder.verify(scope, contract.goal, contract.rubric);
    return verdict.pass;
  } catch {
    return false;
  }
}

/** Synthesize a fail-closed hard-red candidate when the attempt threw (worktree/harness/ladder). */
function failedCandidate(input: BestOfInput, index: number, error: unknown): CandidateResult {
  return {
    index,
    pass: false,
    // The baseline tree (no edits applied): promoting it is a safe no-op if this red somehow wins an
    // all-fail iteration (the iteration is then a normal red that loops through decide() unchanged).
    tree: input.baselineHash,
    // Unknown cost ⇒ {@link selectWinner} sorts it as most-expensive, so a crashed candidate never
    // beats a cheaper red on cost (and never beats any passing candidate on the pass key).
    budget: { exceeded: false },
    run: {
      output: `best-of-N candidate error: ${errorMessage(error)}`,
      sessionId: input.sessionId ?? coerceSessionId(undefined, 'best-of-error'),
      status: 'crashed',
    },
  };
}

async function safeRemove(deps: BestOfDeps, worktree: Worktree, log: Logger): Promise<void> {
  try {
    await deps.worktrees.removeWorktree(worktree);
  } catch (e) {
    log.warn('best-of-N worktree teardown failed (ignored)', { reason: errorMessage(e) });
  }
}
