import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId } from '../domain/ids';
import { CONTRACT_DEFECTIVE_MARKER } from '../orchestrator/stuck';
import type { AdjudicatedDefect, DefectCorpus, DefectRecord } from '../defects/corpus';
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
  passVerdict,
} from '../testing/fakes';
import { FakeLlm } from '../llm/provider';

/**
 * Issue #122 — the WRITE half, end to end through the Driver: an adjudicated CONTRACT_DEFECTIVE
 * verdict is the ONLY thing that ever appends, and what it appends carries none of the worker's
 * text. Zero processes, zero real models, zero disk.
 */

/** In-memory corpus: the seam only, so the test observes exactly what the Driver hands it. */
class SpyCorpus implements DefectCorpus {
  readonly path = '<memory>';
  readonly appended: DefectRecord[] = [];
  read(): readonly DefectRecord[] {
    return this.appended;
  }
  async append(record: AdjudicatedDefect): Promise<void> {
    this.appended.push(record);
  }
  async clear(): Promise<void> {
    this.appended.length = 0;
  }
}

const contract = makeFakeContract({
  goal: 'add a createDatabase bootstrap',
  rungs: [{ kind: 'deterministic', command: 'npx --no-install vitest run verify/db.test.ts' }],
  requiredTools: ['node'],
  generatedFiles: [{ path: 'verify/db.test.ts', sha256: 'a'.repeat(64) }],
});

/** The worker's own text — it must never appear in the corpus. */
const SIGNATURE =
  'AssertionError WORKER_MARKER: expected "createDatabase" to have been called (verify/db.test.ts:12)';

type Wiring = { llm?: FakeLlm; corpus?: DefectCorpus; verdicts?: 'fail' | 'pass' };

/** #114's shape: a genuinely-changing tree that keeps failing the SAME frozen assertion. */
function wireRun(w: Wiring = {}): { deps: DriverDeps; runlog: InMemoryRunLog } {
  const workspace = new FakeWorkspace('0000000', 'diff --git a/db.ts b/db.ts WORKER_DIFF');
  const runlog = new InMemoryRunLog();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness(
      [{ postHash: '0000001' }, { postHash: '0000002' }, { postHash: '0000003' }],
      workspace,
    ),
    makeLadder: () =>
      new FakeVerifier(w.verdicts === 'pass' ? [passVerdict()] : [failVerdict(SIGNATURE)]),
    approver: new FakeApprover([]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    sleep: async () => {},
    runlog,
    ...(w.llm !== undefined ? { prepareLlm: w.llm } : {}),
    ...(w.corpus !== undefined ? { defectCorpus: w.corpus } : {}),
  };
  return { deps, runlog };
}

const config = makeConfig({ goal: 'add a createDatabase bootstrap', maxIterations: 10 });

const defectiveLlm = (): FakeLlm =>
  new FakeLlm([
    JSON.stringify({
      defective: true,
      reason: 'the WORKER_MARKER assertion can never hold: createDatabase is unreachable',
      pattern: 'asserts a call count on a spy after the spy was restored',
      assertionShape: 'call-count assertion after restoreAllMocks()',
    }),
  ]);

describe('only an adjudicated CONTRACT_DEFECTIVE verdict writes to the corpus', () => {
  it('a defective adjudication appends exactly one record, with provenance', async () => {
    const corpus = new SpyCorpus();
    const outcome = await drive(
      wireRun({ llm: defectiveLlm(), corpus }).deps,
      config,
      RunId.parse('run-defective'),
    );

    expect(outcome.reason).toContain(CONTRACT_DEFECTIVE_MARKER);
    expect(corpus.appended).toHaveLength(1);
    expect(corpus.appended[0]).toMatchObject({
      pattern: 'asserts a call count on a spy after the spy was restored',
      assertionShape: 'call-count assertion after restoreAllMocks()',
      // Derived from the FROZEN contract, never supplied.
      language: 'typescript',
      runner: 'vitest',
      contractHash: contract.contractHash,
      runId: 'run-defective',
    });
  });

  it('NO worker-supplied text reaches the record (signature, diff, harness output)', async () => {
    const corpus = new SpyCorpus();
    await drive(wireRun({ llm: defectiveLlm(), corpus }).deps, config, RunId.parse('run-clean'));
    const serialized = JSON.stringify(corpus.appended);
    for (const workerText of ['WORKER_MARKER', 'WORKER_DIFF', 'verify/db.test.ts:12']) {
      expect(serialized).not.toContain(workerText);
    }
  });

  it.each([
    [
      'the adjudicator says the bar is SOUND',
      new FakeLlm([JSON.stringify({ defective: false, reason: 'satisfiable', pattern: 'p' })]),
    ],
    ['the adjudicator answers with prose', new FakeLlm(['looks fine to me'])],
    [
      'the verdict is defective but names no generalized pattern',
      new FakeLlm([JSON.stringify({ defective: true, reason: 'unsatisfiable' })]),
    ],
  ])('writes NOTHING when %s', async (_label, llm) => {
    const corpus = new SpyCorpus();
    await drive(wireRun({ llm, corpus }).deps, config, RunId.parse('run-nothing'));
    expect(corpus.appended).toEqual([]);
  });

  it('writes nothing on a run that never adjudicates at all (a plain DONE)', async () => {
    const corpus = new SpyCorpus();
    const outcome = await drive(
      wireRun({ llm: defectiveLlm(), corpus, verdicts: 'pass' }).deps,
      config,
      RunId.parse('run-done'),
    );
    expect(outcome.status).toBe('DONE');
    expect(corpus.appended).toEqual([]);
  });

  it('a corpus that THROWS cannot break the run (advisory, fail-open)', async () => {
    const exploding: DefectCorpus = {
      path: '<explodes>',
      read: () => [],
      append: async () => {
        throw new Error('disk on fire');
      },
      clear: async () => {},
    };
    const outcome = await drive(
      wireRun({ llm: defectiveLlm(), corpus: exploding }).deps,
      config,
      RunId.parse('run-explode'),
    );
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain(CONTRACT_DEFECTIVE_MARKER);
  });

  it('the corpus is INERT for this run: the outcome is identical with and without it', async () => {
    const withCorpus = await drive(
      wireRun({ llm: defectiveLlm(), corpus: new SpyCorpus() }).deps,
      config,
      RunId.parse('run-a'),
    );
    const without = await drive(wireRun({ llm: defectiveLlm() }).deps, config, RunId.parse('run-a'));
    expect(withCorpus.status).toBe(without.status);
    expect(withCorpus.reason).toBe(without.reason);
  });

  it('the recorded assertion shape also rides the write-ahead log event', async () => {
    const { deps, runlog } = wireRun({ llm: defectiveLlm(), corpus: new SpyCorpus() });
    await drive(deps, config, RunId.parse('run-event'));
    const adjudication = runlog.entries
      .map((e) => e.event)
      .find((e) => e.tag === 'CONTRACT_ADJUDICATED');
    expect(adjudication).toMatchObject({
      defective: true,
      assertionShape: 'call-count assertion after restoreAllMocks()',
    });
  });
});
