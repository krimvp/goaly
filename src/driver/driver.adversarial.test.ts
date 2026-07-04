import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId } from '../domain/ids';
import { Ladder } from '../verify/ladder';
import { AdversarialReviewRung } from '../verify/adversarial-rung';
import { FakeLlm } from '../llm/provider';
import {
  FakeHarness,
  FakeVerifier,
  FakeApprover,
  FakeCompiler,
  FakeSealGate,
  FakeWorkspace,
  ManualClock,
  ManualBudgetMeter,
  InMemoryRunLog,
  makeFakeContract,
  makeConfig,
  passVerdict,
  approve,
} from '../testing/fakes';

const runId = RunId.parse('run-adv');
const contract = makeFakeContract({ goal: 'make the thing work' });

const notRefuted = JSON.stringify({ refuted: false, confidence: 0.9 });
const refuted = (reason: string): string =>
  JSON.stringify({ refuted: true, confidence: 0.9, reason });

/**
 * Full-loop e2e (fakes only, zero IO) with the REAL Ladder + AdversarialReviewRung appended after
 * a scripted frozen rung — the exact shape `buildLadder` composes under `--adversarial`.
 */
describe('drive() — adversarial refuter rung in the loop', () => {
  it('a refuted green CONTINUES (no Sign-off call — invariant #3) and a clean green reaches DONE', async () => {
    const workspace = new FakeWorkspace('0000000', 'a fake diff');
    const harness = new FakeHarness([{ postHash: '0000001' }, { postHash: '0000002' }], workspace);
    // Frozen rung: green both iterations. Refuter panel (1 vote): refutes iter 1, accepts iter 2.
    const frozenRung = new FakeVerifier([passVerdict(), passVerdict()]);
    const refuterLlm = new FakeLlm([refuted('the tests are tautological'), notRefuted]);
    const ladder = new Ladder([frozenRung, new AdversarialReviewRung({ llm: refuterLlm, refuters: 1 })]);
    const approver = new FakeApprover([approve()]);
    const runlog = new InMemoryRunLog();
    const deps: DriverDeps = {
      compiler: new FakeCompiler(contract),
      seal: new FakeSealGate({ kind: 'approve' }),
      harness,
      makeLadder: () => ladder,
      approver,
      workspace,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      sleep: async () => {},
      runlog,
    };

    const outcome = await drive(deps, makeConfig({ goal: 'make the thing work' }), runId);

    expect(outcome.status).toBe('DONE');
    expect(outcome.iterations).toBe(2);

    // Iteration 1: the frozen bar was green but the refuter killed it BEFORE Sign-off — the
    // approver was consulted exactly once, on the surviving iteration-2 green (invariant #3).
    expect(approver.inputs).toHaveLength(1);

    // The refutation reason is the next iteration's feedback, like any verifier red.
    expect(harness.prompts).toHaveLength(2);
    expect(harness.prompts[1]).toContain('the tests are tautological');

    // The bar never moved across the refuted iteration.
    const hashes = runlog.entries
      .map((e) => e.contractHash)
      .filter((h): h is NonNullable<typeof h> => h !== null);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(contract.contractHash);
  });
});
