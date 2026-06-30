import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId, DiffHash, SessionId } from '../domain/ids';
import type { RunConfig } from '../domain/config';
import type { Verdict } from '../domain/verdict';
import type { HarnessRunResult } from '../domain/events';
import type { Workspace } from '../workspace/workspace';
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

const runId = RunId.parse('run-best');
const contract = makeFakeContract({ goal: 'best-of-N goal' });

/**
 * Per-candidate token cost is carried on the harness run's `tokensUsed` — the IO-free fakes fan out in
 * a deterministic FIFO order (each `addWorktree`/`run` resolves on a microtask with no real yield), so a
 * per-call counter maps 1:1 to the candidate index. The candidate's OWN cost (not the shared meter) is
 * what the tournament ranks on, so this is the single source of the cost tie-break.
 */
class TokenHarness implements HarnessAdapter {
  readonly name = 'token-fake';
  #i = 0;
  constructor(private readonly costs: number[]) {}
  async run(): Promise<HarnessRunResult> {
    const tokensUsed = this.costs[this.#i] ?? 0;
    this.#i += 1;
    return { output: '', sessionId: SessionId.parse('cand-session'), status: 'completed', tokensUsed };
  }
}

/**
 * Verifier keyed on the candidate worktree's diffHash so concurrency order never changes the result:
 * the tournament scores each scope, and pass/fail is read purely from that scope's hash.
 */
class HashVerifier implements Verifier {
  constructor(private readonly passByHash: Map<string, boolean>) {}
  async verify(workspace: Workspace): Promise<Verdict> {
    const hash = await workspace.diffHash();
    const pass = this.passByHash.get(hash) ?? false;
    return { pass, confidence: 1, detail: pass ? 'pass' : 'fail' };
  }
}

function wireBestOf(opts: {
  candidates: number;
  candidateHashes: string[];
  passByHash: Map<string, boolean>;
  costs?: number[];
  worktrees?: FakeWorktreeHost;
  workspace?: FakeWorkspace;
  runlog?: InMemoryRunLog;
  approvals?: ReturnType<typeof approve>[];
}): { deps: DriverDeps; worktrees: FakeWorktreeHost; runlog: InMemoryRunLog } {
  const workspace = opts.workspace ?? new FakeWorkspace('aaaaaaa', 'canonical diff');
  const worktrees = opts.worktrees ?? new FakeWorktreeHost(opts.candidateHashes, workspace);
  const runlog = opts.runlog ?? new InMemoryRunLog();
  const ladder = new HashVerifier(opts.passByHash);
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new TokenHarness(opts.costs ?? []),
    makeLadder: () => ladder,
    approver: new FakeApprover(opts.approvals ?? [approve()]),
    workspace,
    worktrees,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
  return { deps, worktrees, runlog };
}

describe('drive() — best-of-N tournament (issue #85)', () => {
  it('reducer folds exactly one AGENT_RAN and the winner tree is promoted', async () => {
    // 3 candidates: hashes c1(fail) c2(pass) c3(pass), c2 cheaper than c3 → c2 wins.
    const passByHash = new Map([
      ['0000c01', false],
      ['0000c02', true],
      ['0000c03', true],
    ]);
    const { deps, worktrees, runlog } = wireBestOf({
      candidates: 3,
      candidateHashes: ['0000c01', '0000c02', '0000c03'],
      passByHash,
      costs: [500, 100, 300], // candidate 1 cheapest passing
    });

    const config = makeConfig({ goal: 'best-of-N goal', candidates: 3, maxIterations: 1 });
    const outcome = await drive(deps, config, runId);

    expect(outcome.status).toBe('DONE');
    expect(outcome.iterations).toBe(1);

    const stored = (await runlog.read())!;
    // Exactly ONE AGENT_RAN folded by the reducer.
    expect(stored.entries.filter((e) => e.event.tag === 'AGENT_RAN')).toHaveLength(1);
    // Three CANDIDATE_RAN markers + one CANDIDATE_SELECTED were written write-ahead.
    expect(stored.entries.filter((e) => e.event.tag === 'CANDIDATE_RAN')).toHaveLength(3);
    expect(stored.entries.filter((e) => e.event.tag === 'CANDIDATE_SELECTED')).toHaveLength(1);

    // The winning tree (c2) was promoted into the canonical workspace, and ALL worktrees torn down.
    expect(worktrees.promoted).toEqual(['0000c02']);
    expect(worktrees.added).toHaveLength(3);
    expect(worktrees.removed).toHaveLength(3);
    expect(worktrees.live.size).toBe(0);

    const selected = stored.entries.find((e) => e.event.tag === 'CANDIDATE_SELECTED');
    expect(selected!.event).toMatchObject({ winner: 1, tree: '0000c02' });
    const agentRan = stored.entries.find((e) => e.event.tag === 'AGENT_RAN')!;
    expect((agentRan.event as { diffHash: string }).diffHash).toBe('0000c02');
  });

  it('all K fail → a normal red iteration (least-cost failing candidate, loops to FAILED at cap)', async () => {
    const passByHash = new Map([
      ['0000d01', false],
      ['0000d02', false],
    ]);
    const { deps, worktrees, runlog } = wireBestOf({
      candidates: 2,
      candidateHashes: ['0000d01', '0000d02'],
      passByHash,
      costs: [400, 100], // candidate 1 (index 1) cheaper
    });

    const config = makeConfig({ goal: 'best-of-N goal', candidates: 2, maxIterations: 1 });
    const outcome = await drive(deps, config, runId);

    // No green ever — the iteration is red and the run FAILS at the cap (a normal red loop).
    expect(outcome.status).toBe('FAILED');
    const stored = (await runlog.read())!;
    const selected = stored.entries.find((e) => e.event.tag === 'CANDIDATE_SELECTED')!;
    expect((selected.event as { winner: number }).winner).toBe(1); // least-cost failing
    expect(worktrees.promoted).toEqual(['0000d02']);
    expect(worktrees.live.size).toBe(0);
  });

  it('a worktree-creation error scores that candidate a hard red — it cannot win on merit', async () => {
    const passByHash = new Map([
      ['0000e02', true], // the surviving candidate passes
    ]);
    const canonical = new FakeWorkspace('aaaaaaa', 'canonical diff');
    const worktrees = new FakeWorktreeHost(['0000e01', '0000e02'], canonical);
    worktrees.throwAddAt(0); // candidate 0 throws on worktree creation
    const { deps, runlog } = wireBestOf({
      candidates: 2,
      candidateHashes: ['0000e01', '0000e02'],
      passByHash,
      worktrees,
      workspace: canonical,
    });

    const config = makeConfig({ goal: 'best-of-N goal', candidates: 2, maxIterations: 1 });
    const outcome = await drive(deps, config, runId);

    expect(outcome.status).toBe('DONE');
    const stored = (await runlog.read())!;
    const selected = stored.entries.find((e) => e.event.tag === 'CANDIDATE_SELECTED')!;
    expect((selected.event as { winner: number }).winner).toBe(1); // the passing survivor, not the crash
    // A crashed candidate is still recorded (write-ahead) as a hard red.
    const crashed = stored.entries.find(
      (e) => e.event.tag === 'CANDIDATE_RAN' && (e.event as { index: number }).index === 0,
    )!;
    expect((crashed.event as { pass: boolean }).pass).toBe(false);
  });

  it('tears down EVERY worktree even when a candidate harness throws mid-run (try/finally)', async () => {
    const passByHash = new Map([['0000ba2', true]]);
    const canonical = new FakeWorkspace('aaaaaaa', 'diff');
    const worktrees = new FakeWorktreeHost(['0000ba1', '0000ba2'], canonical);
    // A harness that throws on the FIRST candidate (after its worktree was already created), succeeds
    // on the second — the thrown candidate must still be torn down (the finally path).
    let calls = 0;
    const harness = {
      name: 'throwing',
      async run() {
        calls += 1;
        if (calls === 1) throw new Error('harness exploded for candidate 0');
        return { output: '', sessionId: SessionId.parse('s'), status: 'completed' as const };
      },
    };
    const deps: DriverDeps = {
      compiler: new FakeCompiler(contract),
      seal: new FakeSealGate({ kind: 'approve' }),
      harness,
      makeLadder: () => new HashVerifier(passByHash),
      approver: new FakeApprover([approve()]),
      workspace: canonical,
      worktrees,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog: new InMemoryRunLog(),
    };

    const outcome = await drive(
      deps,
      makeConfig({ goal: 'best-of-N goal', candidates: 2, maxIterations: 1 }),
      runId,
    );

    expect(outcome.status).toBe('DONE'); // candidate 1 (the survivor) wins
    // Both worktrees were created AND both torn down on every exit path — none left live.
    expect(worktrees.added).toHaveLength(2);
    expect(worktrees.removed).toHaveLength(2);
    expect(worktrees.live.size).toBe(0);
  });

  it('refuses to start fail-closed on an unborn HEAD (the worktree floor)', async () => {
    const worktrees = new FakeWorktreeHost(['0000f01']);
    worktrees.setHeadResolves(false);
    const { deps } = wireBestOf({
      candidates: 2,
      candidateHashes: ['0000f01'],
      passByHash: new Map(),
      worktrees,
    });

    const outcome = await drive(deps, makeConfig({ goal: 'g', candidates: 2 }), runId);
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('committed HEAD');
    // No tournament ran.
    expect(worktrees.added).toHaveLength(0);
  });

  it('refuses to start when --candidates > 1 but no worktree host is wired', async () => {
    const { deps } = wireBestOf({
      candidates: 2,
      candidateHashes: [],
      passByHash: new Map(),
    });
    const noHost: DriverDeps = { ...deps };
    delete (noHost as { worktrees?: unknown }).worktrees;
    const outcome = await drive(noHost, makeConfig({ goal: 'g', candidates: 2 }), runId);
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('worktree host');
  });
});

describe('drive() — N=1 is byte-for-byte the classic single attempt', () => {
  it('emits RUN_AGENT, writes no best-of markers', async () => {
    const passByHash = new Map<string, boolean>();
    const workspace = new FakeWorkspace('0000000', 'diff');
    const runlog = new InMemoryRunLog();
    const deps: DriverDeps = {
      compiler: new FakeCompiler(contract),
      seal: new FakeSealGate({ kind: 'approve' }),
      harness: {
        name: 'fake',
        async run() {
          return { output: '', sessionId: SessionId.parse('s1'), status: 'completed' };
        },
      },
      makeLadder: () => new HashVerifier(passByHash.set('0000abc', true)),
      approver: new FakeApprover([approve()]),
      workspace,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog,
    };
    // Make the post-run hash match a passing entry.
    workspace.setHash('0000abc');
    const outcome = await drive(deps, makeConfig({ goal: 'best-of-N goal', candidates: 1 }), runId);
    expect(outcome.status).toBe('DONE');
    const stored = (await runlog.read())!;
    expect(stored.entries.some((e) => e.event.tag === 'CANDIDATE_RAN')).toBe(false);
    expect(stored.entries.some((e) => e.event.tag === 'CANDIDATE_SELECTED')).toBe(false);
    expect(stored.entries.filter((e) => e.event.tag === 'AGENT_RAN')).toHaveLength(1);
  });
});

/** Helper: a DiffHash from a short label (mirrors the production branding). */
export const dhash = (s: string): DiffHash => DiffHash.parse(s.padStart(7, '0'));
