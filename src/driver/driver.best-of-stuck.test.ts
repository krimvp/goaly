import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId, SessionId } from '../domain/ids';
import type { Verdict } from '../domain/verdict';
import type { Workspace } from '../workspace/workspace';
import type { HarnessRunResult } from '../domain/events';
import type { HarnessAdapter } from '../harness/adapter';
import type { Verifier } from '../verify/verifier';
import {
  FakeApprover,
  FakeCompiler,
  FakeSealGate,
  FakeWorkspace,
  FakeWorktreeHost,
  ManualClock,
  ManualBudgetMeter,
  InMemoryRunLog,
  makeFakeContract,
  makeConfig,
  approve,
} from '../testing/fakes';

/**
 * Explicit stuck-detection-under-ties pin (issue #85 OQ3). Under best-of-N the canonical iteration
 * records ONE diffHash — the WINNER's post-tree hash (`AGENT_RAN.diffHash = winner.tree`,
 * `prevDiffHash = baselineHash`, the canonical tree at iteration start). `step.ts` derives
 * `lastNoDiff = (prevDiffHash === diffHash)`, so no-diff must fire for best-of-N exactly as for a
 * single worker when two consecutive winners resolve to the SAME tree (the canonical tree was
 * unchanged across the iteration), and must NOT fire when consecutive winners have DISTINCT trees.
 * This guards that the winner-tree diffHash flows into `stuck.ts` correctly — best-of-N's tournament
 * wrapper does not break (nor spuriously trip) stuck detection.
 */

const runId = RunId.parse('run-best-stuck');
const contract = makeFakeContract({ goal: 'best-of-N stuck goal' });

/** A no-cost harness — these K=2 runs tie on cost, so selection falls to the lowest candidate index. */
class NoopCandHarness implements HarnessAdapter {
  readonly name = 'noop-cand';
  async run(): Promise<HarnessRunResult> {
    return { output: '', sessionId: SessionId.parse('s'), status: 'completed' };
  }
}

/** Pass/fail keyed on the candidate worktree's diffHash (concurrency-order independent). */
class HashVerifier implements Verifier {
  constructor(private readonly passByHash: Map<string, boolean>) {}
  async verify(workspace: Workspace): Promise<Verdict> {
    const hash = await workspace.diffHash();
    const pass = this.passByHash.get(hash) ?? false;
    return { pass, confidence: 1, detail: pass ? 'pass' : 'fail' };
  }
}

function wire(opts: {
  candidateHashes: string[];
  passByHash: Map<string, boolean>;
}): { deps: DriverDeps; runlog: InMemoryRunLog } {
  // Canonical starts at a DISTINCT hash so iteration 1 is never a false no-diff (its winner tree
  // differs from this start). promoteTree updates this canonical hash to the winner, so iteration 2's
  // baseline is the promoted tree — exactly as a real git promote makes the canonical tree match.
  const canonical = new FakeWorkspace('aaaaaaa', 'canonical diff');
  const worktrees = new FakeWorktreeHost(opts.candidateHashes, canonical);
  const runlog = new InMemoryRunLog();
  const ladder = new HashVerifier(opts.passByHash);
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new NoopCandHarness(),
    makeLadder: () => ladder,
    approver: new FakeApprover([approve()]),
    workspace: canonical,
    worktrees,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
  return { deps, runlog };
}

describe('best-of-N — stuck detection under ties (issue #85 OQ3)', () => {
  it('two consecutive best-of-N winners with the SAME tree fire the no-diff stuck detector', async () => {
    // K=2 each iteration (so the real RUN_AGENT_BEST_OF tournament path runs). Every candidate across
    // BOTH iterations resolves to the SAME tree X, which FAILS the ladder so the run loops.
    //   iter 1: baseline aaaaaaa → winner X (a real change, NOT no-diff), promote → canonical X
    //   iter 2: baseline X       → winner X (prevDiffHash === diffHash) → no-diff fires
    // exactly as a single worker that completed a turn but made no edits. maxIterations is high so it's
    // the no-diff abort — not the iteration cap — that ends the run.
    const X = '0000abc';
    const { deps } = wire({
      candidateHashes: [X, X, X, X], // 2 iterations × 2 candidates, all the same tree
      passByHash: new Map([[X, false]]), // red ladder ⇒ the loop continues to iteration 2
    });

    const outcome = await drive(
      deps,
      makeConfig({ goal: 'best-of-N stuck goal', candidates: 2, maxIterations: 10 }),
      runId,
    );

    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('no-diff');
    // It aborted on the SECOND iteration (the no-op one), well before maxIterations (10).
    expect(outcome.iterations).toBe(2);
  });

  it('consecutive best-of-N winners with DISTINCT trees do NOT fire no-diff (it loops to the cap)', async () => {
    // K=2 each iteration; each iteration's winner tree differs from the prior canonical tree, so
    // prevDiffHash !== diffHash every time ⇒ no-diff never fires. All fail the ladder, so the run loops
    // to maxIterations and FAILS there — the complementary case proving best-of-N's winner-tree diffHash
    // does not spuriously trip no-diff. Both candidates in an iteration tie on (zero) cost, so the
    // lowest index wins: iter 1 → c1, iter 2 → c3 (each a fresh tree vs. its baseline).
    const { deps } = wire({
      candidateHashes: ['0000c01', '0000c02', '0000c03', '0000c04'],
      passByHash: new Map([
        ['0000c01', false],
        ['0000c02', false],
        ['0000c03', false],
        ['0000c04', false],
      ]),
    });

    const outcome = await drive(
      deps,
      makeConfig({ goal: 'best-of-N stuck goal', candidates: 2, maxIterations: 2 }),
      runId,
    );

    // No premature no-diff abort: it ran the full cap and FAILED there (a normal red loop).
    expect(outcome.status).toBe('FAILED');
    expect(outcome.iterations).toBe(2);
  });
});
