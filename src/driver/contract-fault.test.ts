import { describe, it, expect } from 'vitest';
import { classifyContractFault } from './preflight-soundness';
import { drive, type DriverDeps } from './driver';
import { summarizeUsage } from '../runlog/usage';
import { replay, resumeStreakRelief } from '../runlog/replay';
import { RunId } from '../domain/ids';
import type { RunLogEntry } from '../runlog/runlog';
import type { OrchestratorEvent } from '../domain/events';
import { nextStepHint } from '../cli/run-cmd';
import { CONTRACT_DEFECTIVE_MARKER } from '../orchestrator/stuck';
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
  failVerdict,
} from '../testing/fakes';
import { FakeLlm } from '../llm/provider';

/**
 * Issue #116 — the EFFECT half: the read-only adjudicator, its fail-closed table, and the
 * end-to-end reproduction of #114's scenario with zero real processes and zero real models.
 */

const contract = makeFakeContract({
  goal: 'add a createDatabase bootstrap',
  generatedFiles: [{ path: 'verify/db.test.ts', sha256: 'a'.repeat(64) }],
});
const SIGNATURE = 'AssertionError: expected "createDatabase" to be called at least once (verify/db.test.ts:12)';

describe('classifyContractFault — fail-CLOSED to today\'s abort', () => {
  it('a clean positive verdict is passed through, pattern and all', async () => {
    const llm = new FakeLlm([
      JSON.stringify({
        defective: true,
        reason: 'the assertion requires a call the goal never implies',
        pattern: 'asserts on an internal call the goal does not require',
      }),
    ]);
    const v = await classifyContractFault({ llm }, contract, SIGNATURE, 'diff', 3);
    expect(v.defective).toBe(true);
    expect(v.reason).toContain('never implies');
    expect(v.pattern).toBe('asserts on an internal call the goal does not require');
  });

  it('a clean negative verdict keeps today\'s abort and carries NO pattern', async () => {
    const llm = new FakeLlm([JSON.stringify({ defective: false, reason: 'satisfiable', pattern: 'x' })]);
    const v = await classifyContractFault({ llm }, contract, SIGNATURE, 'diff', 3);
    expect(v.defective).toBe(false);
    expect(v.pattern).toBeUndefined();
  });

  it.each([
    ['no JSON at all', new FakeLlm(['the contract looks fine to me'])],
    ['an empty response', new FakeLlm([''])],
    ['an empty JSON object (schema miss)', new FakeLlm(['{}'])],
    ['wrong field types', new FakeLlm([JSON.stringify({ defective: 'yes', reason: 7 })])],
    ['a valid-looking but wrongly-keyed verdict', new FakeLlm([JSON.stringify({ broken: true })])],
  ])('fails closed to defective=false on %s', async (_label, llm) => {
    const v = await classifyContractFault({ llm }, contract, SIGNATURE, 'diff', 3);
    expect(v.defective).toBe(false);
  });

  it('fails closed to defective=false when the LLM call throws', async () => {
    const llm = new (class extends FakeLlm {
      constructor() {
        super(['unused']);
      }
      override async complete(): ReturnType<FakeLlm['complete']> {
        throw new Error('network down');
      }
    })();
    const v = await classifyContractFault({ llm }, contract, SIGNATURE, 'diff', 3);
    expect(v.defective).toBe(false);
    expect(v.reason).toContain('network down');
  });

  it('tolerates prose/fences around the JSON (extractJson), like its pre-flight siblings', async () => {
    const llm = new FakeLlm(['Verdict:\n```json\n{"defective": true, "reason": "impossible"}\n```']);
    expect((await classifyContractFault({ llm }, contract, SIGNATURE, 'd', 3)).defective).toBe(true);
  });

  it('wraps BOTH model/tool-authored inputs (the signature and the diff) as untrusted', async () => {
    const llm = new FakeLlm([JSON.stringify({ defective: false })]);
    await classifyContractFault({ llm }, contract, 'SIG_MARKER', 'DIFF_MARKER', 5);
    const prompt = llm.requests[0]?.prompt ?? '';
    // Each marker must sit INSIDE an untrusted block, not loose in the instructions.
    for (const marker of ['SIG_MARKER', 'DIFF_MARKER']) {
      const before = prompt.slice(0, prompt.indexOf(marker));
      expect(before).toMatch(/<<UNTRUSTED [A-Z]+ [0-9a-f]+>>/);
    }
    expect(prompt).toContain('verify/db.test.ts');
    expect(prompt).toContain('5 ITERATIONS');
    expect(llm.requests[0]?.temperature).toBe(0);
  });
});

// ---- end-to-end through the Driver (issue #114's scenario) -----------------

type Wiring = { llm?: FakeLlm; workspace?: FakeWorkspace; runlog?: InMemoryRunLog };

/**
 * A run that keeps producing the SAME failing verdict naming the frozen authored file, while the
 * worker keeps genuinely changing the tree — exactly #114's shape.
 */
function wireRepeatRun(w: Wiring = {}): { deps: DriverDeps; runlog: InMemoryRunLog } {
  const workspace = w.workspace ?? new FakeWorkspace('0000000', 'a fake diff');
  const runlog = w.runlog ?? new InMemoryRunLog();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness(
      [{ postHash: '0000001' }, { postHash: '0000002' }, { postHash: '0000003' }],
      workspace,
    ),
    makeLadder: () => new FakeVerifier([failVerdict(SIGNATURE)]),
    approver: new FakeApprover([]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    sleep: async () => {},
    runlog,
    ...(w.llm !== undefined ? { prepareLlm: w.llm } : {}),
  };
  return { deps, runlog };
}

const config = makeConfig({ goal: 'add a createDatabase bootstrap', maxIterations: 10 });

describe('drive() — in-loop adjudication end to end (zero processes, zero real models)', () => {
  it('a defective verdict relabels the abort as CONTRACT_DEFECTIVE', async () => {
    const llm = new FakeLlm([
      JSON.stringify({ defective: true, reason: 'createDatabase is never reachable', pattern: 'p' }),
    ]);
    const { deps, runlog } = wireRepeatRun({ llm });
    const outcome = await drive(deps, config, RunId.parse('run-defective'));

    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain(CONTRACT_DEFECTIVE_MARKER);
    expect(outcome.reason).toContain('verify/db.test.ts');
    expect(outcome.reason).toContain('createDatabase is never reachable');
    // Write-ahead: the verdict is a real, persisted, Zod-parsed event — not an in-memory decision.
    const events = runlog.entries.map((e) => e.event);
    const adjudications = events.filter((e) => e.tag === 'CONTRACT_ADJUDICATED');
    expect(adjudications).toHaveLength(1);
    expect(adjudications[0]).toMatchObject({ defective: true, pattern: 'p' });
    // Bounded: exactly ONE adjudication call for the whole run.
    expect(llm.requests).toHaveLength(1);
    // The operator is pointed at a new bar, not at --stuck-repeat-threshold.
    expect(nextStepHint(outcome)).toContain('adjudicated defective');
  });

  it('a sound verdict leaves the repeat-failure abort exactly as it was', async () => {
    const llm = new FakeLlm([JSON.stringify({ defective: false, reason: 'satisfiable' })]);
    const { deps } = wireRepeatRun({ llm });
    const adjudicated = await drive(deps, config, RunId.parse('run-sound'));

    // The control: the same run with NO adjudicator wired at all (the pre-#116 path).
    const control = await drive(wireRepeatRun().deps, config, RunId.parse('run-control'));

    expect(adjudicated.status).toBe('ABORTED');
    expect(adjudicated.reason).toBe(control.reason);
    expect(adjudicated.reason).toContain('STUCK_REPEATED_FAILURE');
    expect(adjudicated.reason).not.toContain(CONTRACT_DEFECTIVE_MARKER);
  });

  it('no adjudicator wired ⇒ a defective:false event and NOT a single LLM call', async () => {
    const { deps, runlog } = wireRepeatRun();
    const outcome = await drive(deps, config, RunId.parse('run-no-llm'));
    expect(outcome.status).toBe('ABORTED');
    const adjudications = runlog.entries.filter((e) => e.event.tag === 'CONTRACT_ADJUDICATED');
    expect(adjudications).toHaveLength(1);
    expect(adjudications[0]?.event).toMatchObject({
      tag: 'CONTRACT_ADJUDICATED',
      defective: false,
      reason: 'no adjudicator configured',
    });
  });

  it('a throwing diff is advisory-only — the adjudication still produces a valid event', async () => {
    const workspace = new (class extends FakeWorkspace {
      override async diff(): Promise<string> {
        throw new Error('diff exploded');
      }
    })('0000000', 'a fake diff');
    const llm = new FakeLlm([JSON.stringify({ defective: true, reason: 'unsatisfiable' })]);
    const outcome = await drive(
      wireRepeatRun({ llm, workspace }).deps,
      config,
      RunId.parse('run-nodiff'),
    );
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain(CONTRACT_DEFECTIVE_MARKER);
  });

  it('a throwing adjudicator falls back to today\'s abort (fail-closed, never a crash)', async () => {
    const llm = new (class extends FakeLlm {
      constructor() {
        super(['unused']);
      }
      override async complete(): ReturnType<FakeLlm['complete']> {
        throw new Error('model unavailable');
      }
    })();
    const outcome = await drive(wireRepeatRun({ llm }).deps, config, RunId.parse('run-throw'));
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('STUCK_REPEATED_FAILURE');
    expect(outcome.reason).not.toContain(CONTRACT_DEFECTIVE_MARKER);
  });
});

// ---- usage attribution + replay/resume ------------------------------------

describe('the adjudication is metered, replayable, and resume-safe', () => {
  it('summarizeUsage attributes the adjudicator\'s spend to the verifier layer', () => {
    const events: OrchestratorEvent[] = [
      { tag: 'CONTRACT_ADJUDICATED', defective: true, reason: 'r', llm: { tokens: 720, calls: 1, unknownCalls: 0 } },
    ];
    const usage = summarizeUsage(events, {});
    expect(usage.verifier.tokens).toBe(720);
    expect(usage.total.tokens).toBe(720);
  });

  it('replay folds the recorded verdict — the same terminal state, zero LLM calls', async () => {
    const llm = new FakeLlm([JSON.stringify({ defective: true, reason: 'unsatisfiable', pattern: 'p' })]);
    const runlog = new InMemoryRunLog();
    const outcome = await drive(wireRepeatRun({ llm, runlog }).deps, config, RunId.parse('run-replay'));
    const callsDuringRun = llm.requests.length;

    const stored = await runlog.read();
    const folded = replay(stored!.header.config, stored!.entries);
    expect(folded.state.tag).toBe('ABORTED');
    if (folded.state.tag === 'ABORTED') expect(folded.state.reason).toBe(outcome.reason);
    // The fold performed NO effect: the adjudicator was not called again.
    expect(llm.requests).toHaveLength(callsDuringRun);
  });

  it('resume relief does NOT raise the repeat threshold once a verdict is recorded (the fold hazard)', async () => {
    const llm = new FakeLlm([JSON.stringify({ defective: true, reason: 'unsatisfiable' })]);
    const runlog = new InMemoryRunLog();
    await drive(wireRepeatRun({ llm, runlog }).deps, config, RunId.parse('run-relief'));
    const stored = await runlog.read();
    const entries: RunLogEntry[] = [...stored!.entries];

    // Without the suppression the relief would raise repeatFailureThreshold, the fold would no
    // longer enter ADJUDICATING at that VERIFIED, and the next entry would be an invalid transition.
    expect(resumeStreakRelief(stored!.header.config, entries).repeatFailureThreshold).toBeUndefined();
    const folded = replay(stored!.header.config, entries);
    expect(folded.state.tag).toBe('ABORTED');
    if (folded.state.tag === 'ABORTED') {
      expect(folded.state.reason).toContain(CONTRACT_DEFECTIVE_MARKER);
      expect(folded.state.reason).not.toContain('driver error');
    }
  });
});
