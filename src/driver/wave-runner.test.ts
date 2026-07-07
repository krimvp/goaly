import { describe, it, expect } from 'vitest';
import { DefaultWaveRunner, type ComposeChild } from './wave-runner';
import type { DriverDeps } from './driver';
import type { WavePhaseSpec } from './wave';
import type { Worktree } from '../workspace/workspace';
import type { CompiledContract } from '../domain/contract';
import {
  FakeApprover,
  FakeCompiler,
  FakeHarness,
  FakeSealGate,
  FakeVerifier,
  FakeWorkspace,
  FakeWorktreeHost,
  InMemoryRunLog,
  ManualBudgetMeter,
  ManualClock,
  approve,
  failVerdict,
  makeConfig,
  makeFakeContract,
  passVerdict,
} from '../testing/fakes';

/**
 * The whole wave with ZERO LLM calls and ZERO subprocesses: children are full `drive()` runs on
 * fakes, the host merges with the scripted fake `mergeTrees`, and the post-merge re-verify runs the
 * child contracts' deterministic rungs against the scripted canonical FakeWorkspace.
 */

const specA: WavePhaseSpec = { index: 0, config: makeConfig({ goal: 'member A', autonomous: true }) };
const specB: WavePhaseSpec = { index: 1, config: makeConfig({ goal: 'member B', autonomous: true }) };
const contractA = makeFakeContract({ goal: 'member A', rungs: [{ kind: 'deterministic', command: 'check-a' }] });
const contractB = makeFakeContract({ goal: 'member B', rungs: [{ kind: 'deterministic', command: 'check-b' }] });

/** Compose one DONE-in-one-iteration child on fakes; `fail` scripts a red ladder (child FAILS). */
function childDeps(opts: {
  worktree: Worktree;
  contract: CompiledContract;
  tree: string;
  budget: ManualBudgetMeter;
  fail?: boolean;
}): DriverDeps {
  const scope = opts.worktree.scope as FakeWorkspace;
  return {
    compiler: new FakeCompiler(opts.contract),
    seal: new FakeSealGate(),
    harness: new FakeHarness([{ postHash: opts.tree, tokensUsed: 111 }], scope),
    makeLadder: () =>
      new FakeVerifier(opts.fail === true ? [failVerdict('child red')] : [passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace: scope,
    clock: new ManualClock(),
    budget: opts.budget,
    runlog: new InMemoryRunLog(),
  };
}

function runner(opts: {
  host: FakeWorktreeHost;
  canonical: FakeWorkspace;
  composeChild: ComposeChild;
}): DefaultWaveRunner {
  return new DefaultWaveRunner({
    host: opts.host,
    workspace: opts.canonical,
    workspaceRoot: '/fake/canonical',
    composeChild: opts.composeChild,
  });
}

/** Standard two-child fixture: canonical at eeeeeee; A edits to aaaa111, B to bbbb222. */
function fixture(opts: { failB?: boolean } = {}): {
  host: FakeWorktreeHost;
  canonical: FakeWorkspace;
  wave: DefaultWaveRunner;
} {
  const canonical = new FakeWorkspace('eeeeeee');
  const host = new FakeWorktreeHost([], canonical);
  const budget = new ManualBudgetMeter(false);
  const composeChild: ComposeChild = async (spec, worktree) =>
    spec.index === 0
      ? childDeps({ worktree, contract: contractA, tree: 'aaaa111', budget })
      : childDeps({ worktree, contract: contractB, tree: 'bbbb222', budget, ...(opts.failB === true ? { fail: true } : {}) });
  return { host, canonical, wave: runner({ host, canonical, composeChild }) };
}

describe('DefaultWaveRunner — cooperative parallel waves (EXPERIMENTAL)', () => {
  it('runs both children to DONE, merges in phase order, re-verifies, and checkpoints', async () => {
    const { host, canonical, wave } = fixture();
    const result = await wave.run([specA, specB]);

    expect(result.outcomes.map((o) => o.kind)).toEqual(['merged', 'merged']);
    // Merges are 3-way against the WAVE-START base, accumulating in phase order.
    expect(host.mergedCalls).toEqual([
      { base: 'eeeeeee', ours: 'eeeeeee', theirs: 'aaaa111' },
      { base: 'eeeeeee', ours: 'eeeaaaa', theirs: 'bbbb222' },
    ]);
    // The combined tree was promoted into the canonical workspace and checkpointed as the baseline.
    expect(host.promoted).toEqual(['eeebbbb']);
    expect(result.tree).toBe('eeebbbb');
    expect(await canonical.diffHash()).toBe('eeebbbb');
    // Every worktree torn down on the happy path.
    expect(host.live.size).toBe(0);
    // Child spend is surfaced for the parent's usage fold (shared budget already metered it).
    expect(result.outcomes[0]!.usage?.tokens).toBe(111);
  });

  it('a merge CONFLICT downgrades that child to unmerged; the rest still land', async () => {
    const { host, wave } = fixture();
    host.conflicts.add('eeeaaaa+bbbb222'); // B conflicts when merged onto A's result
    const result = await wave.run([specA, specB]);

    expect(result.outcomes[0]).toMatchObject({ kind: 'merged', index: 0 });
    expect(result.outcomes[1]).toMatchObject({ kind: 'unmerged', index: 1 });
    if (result.outcomes[1]!.kind === 'unmerged') {
      expect(result.outcomes[1]!.reason).toContain('merge conflict');
    }
    // Only A's tree was promoted — nothing of B was applied (fail-closed).
    expect(host.promoted).toEqual(['eeeaaaa']);
    expect(host.live.size).toBe(0);
  });

  it('a child that cannot reach DONE is unmerged with its terminal status as the reason', async () => {
    const { host, wave } = fixture({ failB: true });
    const result = await wave.run([specA, specB]);

    expect(result.outcomes[0]!.kind).toBe('merged');
    expect(result.outcomes[1]).toMatchObject({ kind: 'unmerged', index: 1 });
    if (result.outcomes[1]!.kind === 'unmerged') {
      // The fake red ladder makes the child run terminate without both keys.
      expect(result.outcomes[1]!.reason).toContain('child run');
    }
    expect(host.live.size).toBe(0);
  });

  it('a RED post-merge re-verify downgrades that child — a merge is never trusted', async () => {
    // The canonical workspace scripts the two re-verify rungs: A's `check-a` green, B's `check-b` red
    // (the semantic-conflict case: two CLEAN merges that break each other).
    const canonical = new FakeWorkspace('eeeeeee', '', [
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 1, stdout: '', stderr: 'check-b broke after the merge' },
    ]);
    const host = new FakeWorktreeHost([], canonical);
    const budget = new ManualBudgetMeter(false);
    const composeChild: ComposeChild = async (spec, worktree) =>
      spec.index === 0
        ? childDeps({ worktree, contract: contractA, tree: 'aaaa111', budget })
        : childDeps({ worktree, contract: contractB, tree: 'bbbb222', budget });
    const wave = runner({ host, canonical, composeChild });

    const result = await wave.run([specA, specB]);
    expect(result.outcomes[0]!.kind).toBe('merged');
    expect(result.outcomes[1]).toMatchObject({ kind: 'unmerged', index: 1 });
    if (result.outcomes[1]!.kind === 'unmerged') {
      expect(result.outcomes[1]!.reason).toContain('post-merge re-verify failed');
      expect(result.outcomes[1]!.reason).toContain('check-b broke after the merge');
    }
  });

  it('a composeChild failure is a fail-closed unmerged outcome, never a thrown wave', async () => {
    const canonical = new FakeWorkspace('eeeeeee');
    const host = new FakeWorktreeHost([], canonical);
    const budget = new ManualBudgetMeter(false);
    const composeChild: ComposeChild = async (spec, worktree) => {
      if (spec.index === 1) throw new Error('no deps for you');
      return childDeps({ worktree, contract: contractA, tree: 'aaaa111', budget });
    };
    const wave = runner({ host, canonical, composeChild });

    const result = await wave.run([specA, specB]);
    expect(result.outcomes[0]!.kind).toBe('merged');
    expect(result.outcomes[1]).toMatchObject({ kind: 'unmerged', index: 1 });
    if (result.outcomes[1]!.kind === 'unmerged') {
      expect(result.outcomes[1]!.reason).toContain('no deps for you');
    }
    expect(host.live.size).toBe(0);
  });
});
