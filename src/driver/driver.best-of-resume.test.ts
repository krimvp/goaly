import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId, SessionId } from '../domain/ids';
import type { Verdict } from '../domain/verdict';
import type { RunLogEntry } from '../runlog/runlog';
import type { Workspace } from '../workspace/workspace';
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

const runId = RunId.parse('run-best-resume');
const contract = makeFakeContract({ goal: 'best-of-N resume goal' });

class HashVerifier implements Verifier {
  constructor(private readonly passByHash: Map<string, boolean>) {}
  async verify(workspace: Workspace): Promise<Verdict> {
    const hash = await workspace.diffHash();
    const pass = this.passByHash.get(hash) ?? false;
    return { pass, confidence: 1, detail: pass ? 'pass' : 'fail' };
  }
}

/** A harness that records every call — used to assert NO candidate is re-run beyond the missing one. */
class CountingHarness {
  readonly name = 'counting';
  calls = 0;
  constructor(private readonly tokens: number[]) {}
  async run() {
    const tokensUsed = this.tokens[this.calls] ?? 0;
    this.calls += 1;
    return { output: '', sessionId: SessionId.parse('s'), status: 'completed' as const, tokensUsed };
  }
}

/** Build a write-ahead log that crashed mid-fan-out: contract + seal + 2 of 3 CANDIDATE_RAN, no select. */
function seedCrashedLog(): InMemoryRunLog {
  const log = new InMemoryRunLog();
  log.header = { runId, startedAt: 0, config: makeConfig({ goal: 'best-of-N resume goal', candidates: 3, maxIterations: 1 }) };
  const entry = (seq: number, event: RunLogEntry['event'], stateTagAfter: string): RunLogEntry => ({
    runId,
    seq,
    ts: seq,
    contractHash: contract.contractHash,
    event,
    stateTagAfter,
  });
  log.entries = [
    entry(1, { tag: 'CONTRACT_COMPILED', contract }, 'AWAIT_SEAL'),
    entry(2, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }, 'RUNNING_AGENT'),
    // Candidate 0 ran (passing tree c0) and candidate 1 ran (failing tree c1) — then a crash, before
    // any CANDIDATE_SELECTED was written.
    entry(
      3,
      {
        tag: 'CANDIDATE_RAN',
        iteration: 1,
        index: 0,
        tree: '0000c00' as never,
        budget: { tokensSpent: 200, exceeded: false },
        pass: true,
        run: { output: '', sessionId: SessionId.parse('s'), status: 'completed' },
      },
      'RUNNING_AGENT',
    ),
    entry(
      4,
      {
        tag: 'CANDIDATE_RAN',
        iteration: 1,
        index: 1,
        tree: '0000c01' as never,
        budget: { tokensSpent: 50, exceeded: false },
        pass: false,
        run: { output: '', sessionId: SessionId.parse('s'), status: 'completed' },
      },
      'RUNNING_AGENT',
    ),
  ];
  return log;
}

describe('best-of-N resume — crash mid-fan-out (issue #85, invariant #7)', () => {
  it('re-runs only the not-yet-logged candidate, re-selects the same winner, promotes once', async () => {
    const log = seedCrashedLog();

    // The canonical workspace; the winner's tree is promoted onto it post-selection.
    const canonical = new FakeWorkspace('aaaaaaa', 'diff');
    // Only candidate index 2 is re-run (the others are read back from their markers); its worktree gets
    // a FAILING tree hash so the recorded candidate 0 (pass, cost 200) stays the deterministic winner.
    const host = new FakeWorktreeHost(['0000c02'], canonical);
    const harness = new CountingHarness([9999]); // candidate 2's (large) cost; it must not out-rank c0

    const passByHash = new Map<string, boolean>([
      ['0000c00', true], // candidate 0 (recorded) — the winner's promoted tree must pass the verifier
      ['0000c02', false], // candidate 2 (re-run) fails
    ]);

    const deps: DriverDeps = {
      compiler: new FakeCompiler(new Error('compile must not run on resume')),
      seal: new FakeSealGate({ kind: 'reject', reason: 'seal must not run on resume' }),
      harness,
      makeLadder: () => new HashVerifier(passByHash),
      approver: new FakeApprover([approve()]),
      workspace: canonical,
      worktrees: host,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog: log,
    };

    const outcome = await drive(
      deps,
      makeConfig({ goal: 'best-of-N resume goal', candidates: 3, maxIterations: 1 }),
      runId,
      { resume: true },
    );

    // Only candidate 2 was (re-)run — candidates 0 and 1 were read back from their markers.
    expect(harness.calls).toBe(1);
    expect(host.added).toHaveLength(1);

    // Deterministic re-selection: candidate 0 (the only passing candidate) wins; its tree is promoted
    // exactly once, and the verifier then greens on it → DONE.
    expect(host.promoted).toEqual(['0000c00']);
    expect(outcome.status).toBe('DONE');

    const stored = (await log.read())!;
    // The previously-logged CANDIDATE_RAN markers are NOT duplicated (only index 2 is appended now).
    const ran = stored.entries.filter((e) => e.event.tag === 'CANDIDATE_RAN');
    const indices = ran
      .map((e) => (e.event as { iteration: number; index: number }))
      .filter((e) => e.iteration === 1)
      .map((e) => e.index)
      .sort();
    expect(indices).toEqual([0, 1, 2]);
    // Exactly one CANDIDATE_SELECTED and one AGENT_RAN for the iteration.
    expect(stored.entries.filter((e) => e.event.tag === 'CANDIDATE_SELECTED')).toHaveLength(1);
    expect(stored.entries.filter((e) => e.event.tag === 'AGENT_RAN')).toHaveLength(1);
    // No tree was double-applied: a single promote of the winner.
    expect(host.promoted).toHaveLength(1);
  });
});
