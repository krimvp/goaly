import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId, ContractHash } from '../domain/ids';
import type { RunLog } from '../runlog/runlog';
import type { RunProvenance } from '../runlog/runlog';
import type { LlmCompletion, LlmProvider, LlmRequest } from '../llm/provider';
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

/**
 * Issue #117 follow-up: a `--recontract` successor run must keep its pre-flight NEGATIVE CONTROL
 * across `--resume`.
 *
 * Successor provenance is only supplied by the FRESH CLI invocation (`--from-run … --recontract`);
 * `--resume` cannot carry it (the two flags are mutually exclusive), so a resumed successor reached
 * `PREPARE_WORKSPACE` with `provenance === undefined`, `recontractPrepareDeps` returned `{}`, and the
 * green negative control — the one thing standing between a re-contract and a weakening channel —
 * returned early without running or logging anything. Silent, and precisely on the recovery path
 * whose premise is that the on-disk implementation is already correct.
 *
 * The header records the provenance write-ahead, so the resumed run re-reads it from there.
 */

const runId = RunId.parse('run-recontract-resume');
const BAR_FILE = 'verify/db.test.js';
/** The re-authored bar, softened into a tautology — passes on any tree, asserts nothing. */
const WEAKENED = "test('createDatabase', () => { expect(true).toBe(true); });";
const PREDECESSOR_BAR = [
  'Previous frozen contract (hash abc123) — DEFECTIVE, never reused:',
  '  rubric: a database file is created on first boot',
  '  bar:',
  '    1. [deterministic] node verify/db.test.js',
].join('\n');
const DEFECT = 'the frozen check asserted on an internal _handle property the goal never implies';

const provenance: RunProvenance = {
  predecessorRunId: RunId.parse('run-predecessor'),
  predecessorContractHash: ContractHash.parse('a'.repeat(64)),
  verdict: DEFECT,
  recontracts: 1,
  predecessorBar: PREDECESSOR_BAR,
};

const contract = makeFakeContract({
  goal: 'add a createDatabase bootstrap',
  rubric: 'a database file is created on first boot',
  rungs: [{ kind: 'deterministic', command: 'node verify/db.test.js' }],
  generatedFiles: [{ path: BAR_FILE, sha256: 'a'.repeat(64) }],
});

/** Calls the bar weakened only when it is actually SHOWN a tautology (a real, fail-open classifier). */
class ReadingClassifier implements LlmProvider {
  readonly name = 'reading-classifier';
  readonly prompts: string[] = [];
  async complete(req: LlmRequest): Promise<LlmCompletion> {
    this.prompts.push(req.prompt);
    const sawTautology = req.prompt.includes('expect(true).toBe(true)');
    return {
      text: JSON.stringify({
        unsound: sawTautology,
        reason: sawTautology ? 'the re-authored file asserts a tautology' : 'nothing visibly weaker',
      }),
    };
  }
}

/** A RunLog that drops the Nth append — the write-ahead crash that forces a resume. */
function crashAfter(inner: InMemoryRunLog, failOnAppend: number): RunLog {
  let appends = 0;
  return {
    writeHeader: (h) => inner.writeHeader(h),
    append: async (e) => {
      appends += 1;
      if (appends === failOnAppend) throw new Error('disk died');
      await inner.append(e);
    },
    read: () => inner.read(),
  };
}

function makeWorkspace(): FakeWorkspace {
  const ws = new FakeWorkspace('0000abc', 'diff');
  ws.setFileContent(BAR_FILE, WEAKENED);
  return ws;
}

/**
 * Drive a fresh run whose 3rd append (WORKSPACE_PREPARED) never lands: CONTRACT_COMPILED and
 * SEAL_DECIDED persist, so the resume picks up exactly at PREPARE_WORKSPACE. No `prepareLlm` here,
 * so the control provably did NOT run before the crash.
 */
async function crashBeforePrepare(
  inner: InMemoryRunLog,
  options: { provenance?: RunProvenance },
): Promise<void> {
  const workspace = makeWorkspace();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness([], workspace),
    makeLadder: () => new FakeVerifier([]),
    approver: new FakeApprover([]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(),
    runlog: crashAfter(inner, 3),
  };
  const crashed = await drive(deps, makeConfig({ goal: contract.goal }), runId, {
    harness: 'fake',
    ...(options.provenance !== undefined ? { provenance: options.provenance } : {}),
  });
  expect(crashed.status).toBe('ABORTED');
  expect((await inner.read())?.entries).toHaveLength(2);
}

/** Resume the cut log with a classifier wired, and no provenance on the command line (as `--resume` is). */
async function resumeWithClassifier(inner: InMemoryRunLog, llm: ReadingClassifier) {
  const workspace = makeWorkspace();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(new Error('compile must not re-run on resume')),
    seal: new FakeSealGate({ kind: 'reject', reason: 'seal must not re-run on resume' }),
    harness: new FakeHarness([{ postHash: '0000abd' }], workspace),
    makeLadder: () => new FakeVerifier([passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(),
    runlog: inner,
    prepareLlm: llm,
  };
  return drive(deps, makeConfig({ goal: contract.goal }), runId, { resume: true });
}

describe('drive() — a resumed --recontract successor keeps its negative control (issue #117)', () => {
  it('re-reads the header provenance on resume and still runs the green negative control', async () => {
    const inner = new InMemoryRunLog();
    await crashBeforePrepare(inner, { provenance });
    expect((await inner.read())?.header.provenance).toEqual(provenance);

    const llm = new ReadingClassifier();
    const outcome = await resumeWithClassifier(inner, llm);

    // The control ran, and it was shown the evidence the header carries — so a softened bar is
    // caught before a single worker token is spent, exactly as on the fresh successor run.
    expect(llm.prompts).toHaveLength(1);
    expect(llm.prompts[0]).toContain(WEAKENED);
    expect(llm.prompts[0]).toContain(PREDECESSOR_BAR);
    expect(llm.prompts[0]).toContain(DEFECT);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.reason).toContain('CONTRACT_UNSOUND');
  });

  it('an ORDINARY resumed run (no header provenance) still never consults the control', async () => {
    const inner = new InMemoryRunLog();
    await crashBeforePrepare(inner, {});
    expect((await inner.read())?.header.provenance).toBeUndefined();

    const llm = new ReadingClassifier();
    const outcome = await resumeWithClassifier(inner, llm);

    expect(llm.prompts).toHaveLength(0);
    expect(outcome.status).toBe('DONE');
  });
});
