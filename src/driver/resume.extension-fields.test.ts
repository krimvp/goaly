import { describe, it, expect } from 'vitest';
import { resume, hasExtension } from './resume';
import { drive, type DriverDeps } from './driver';
import { RunId } from '../domain/ids';
import { OrchestratorEvent, RUN_EXTENSION_FIELDS, type RunExtension } from '../domain/events';
import { extendedRunConfig } from '../runlog/replay';
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
  failVerdict,
  approve,
} from '../testing/fakes';

/**
 * `hasExtension()` decides whether a `--resume` writes a RUN_EXTENDED marker at all. A HAND-WRITTEN
 * field list there rots the moment a field is added to the schema: the override is dropped on the
 * floor while the CLI still reports it as accepted (replay then folds the STORED config, so the run
 * silently keeps the old value). `candidates` was exactly that — `goaly --resume <id> --candidates 4`,
 * or a `--note` that is purely a delegation directive ("try 4 parallel attempts", which
 * `collectResumeExtension` strips to `note: undefined` + `candidates: N`), produced NO marker.
 *
 * So the predicate is derived from the SCHEMA, and this file fails if a field is not covered.
 */

const runId = RunId.parse('run-extend-fields');
const contract = makeFakeContract({ goal: 'extend me' });

/**
 * One minimal non-empty value per RunExtension field. The mapped type is over `Required<RunExtension>`,
 * so ADDING A FIELD TO THE SCHEMA fails the typecheck here until it gets a sample — and the key
 * equality assertion below fails the test run for the same reason.
 */
const SAMPLES: { [K in keyof Required<RunExtension>]: NonNullable<RunExtension[K]> } = {
  maxIterations: 7,
  budgetTokens: 100_000,
  budgetWallMs: 60_000,
  stuck: { noDiff: true },
  candidates: 4,
  note: 'focus on the parser edge case',
};

describe('hasExtension() covers every field the RunExtension schema carries', () => {
  it('the sample table and the schema agree on the field set', () => {
    expect([...RUN_EXTENSION_FIELDS].sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  it.each(RUN_EXTENSION_FIELDS)('a resume carrying only `%s` is an extension', (field) => {
    const extension = { [field]: SAMPLES[field] } as RunExtension;
    // It is a valid marker payload…
    expect(() => OrchestratorEvent.parse({ tag: 'RUN_EXTENDED', ...extension })).not.toThrow();
    // …so it must produce one.
    expect(hasExtension(extension)).toBe(true);
  });

  it('an empty extension — including an empty nested override — stays a no-op resume', () => {
    expect(hasExtension({})).toBe(false);
    expect(hasExtension({ stuck: {} })).toBe(false);
  });
});

/** Drive a fresh run to FAILED at maxIterations=1, returning its log. */
async function failAtCap(): Promise<InMemoryRunLog> {
  const workspace = new FakeWorkspace('0000000');
  const runlog = new InMemoryRunLog();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: '0000001' }], workspace),
    makeLadder: () => new FakeVerifier([failVerdict('still red')]),
    approver: new FakeApprover([]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
  const outcome = await drive(deps, makeConfig({ goal: 'extend me', maxIterations: 1 }), runId);
  expect(outcome.status).toBe('FAILED');
  return runlog;
}

describe('resume() persists a candidates-only extension (ADR 0012)', () => {
  it('writes the marker write-ahead and the fold adopts the new fan-out', async () => {
    const runlog = await failAtCap();
    const workspace = new FakeWorkspace('0000001');
    const deps: DriverDeps = {
      compiler: new FakeCompiler(new Error('compile must not run on resume')),
      seal: new FakeSealGate({ kind: 'reject', reason: 'gate must not run on resume' }),
      harness: new FakeHarness([], workspace),
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([approve()]),
      workspace,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog,
    };

    await resume(deps, makeConfig({ goal: 'extend me' }), runId, { candidates: 4 });

    const stored = await runlog.read();
    const marker = stored!.entries.find((e) => e.event.tag === 'RUN_EXTENDED');
    expect(marker).toBeDefined();
    expect(marker!.event.tag === 'RUN_EXTENDED' && marker!.event.candidates).toBe(4);
    // …and every later replay/inspection folds the raised fan-out, not the stored header's.
    expect(extendedRunConfig(stored!.header.config, stored!.entries).candidates).toBe(4);
  });
});
