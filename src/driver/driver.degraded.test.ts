import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { RunId } from '../domain/ids';
import { RunLogHeader } from '../runlog/runlog';
import { effectiveDegraded, replay } from '../runlog/replay';
import type { DegradedMode } from '../domain/degraded';
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
  recordingLogger,
} from '../testing/fakes';

/**
 * Issue #125: a fully-collapsed model configuration is recorded as a TYPED degraded-mode flag in the
 * run-log header — the durable half of the fix, so a DONE from a self-judged run stays labelled
 * long after the startup WARN scrolled off (or was never watched, which is what `--autonomous` means).
 */

const runId = RunId.parse('run-degraded');
const contract = makeFakeContract({ goal: 'labelled goal' });

async function driveToDone(runlog: InMemoryRunLog, degraded?: DegradedMode): Promise<void> {
  const workspace = new FakeWorkspace('0000abc');
  const deps: DriverDeps = {
    compiler: new FakeCompiler(contract),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: '0000abc' }], workspace),
    makeLadder: () => new FakeVerifier([passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(false),
    runlog,
  };
  const outcome = await drive(deps, makeConfig({ goal: 'labelled goal' }), runId, {
    harness: 'claude',
    ...(degraded !== undefined ? { degraded } : {}),
  });
  // The label never gates: a self-judged run still reaches DONE through both keys.
  expect(outcome.status).toBe('DONE');
}

describe('drive() — the degraded-mode label in the run-log header (issue #125)', () => {
  it('records the typed self-judged label on a fresh run', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log, { kind: 'self-judged', generate: true, autonomous: true });
    const header = (await log.read())!.header;
    expect(header.degraded).toEqual({ kind: 'self-judged', generate: true, autonomous: true });
    // It survives the header's Zod round-trip (invariant #6: the log is parsed on read).
    expect(RunLogHeader.parse(JSON.parse(JSON.stringify(header))).degraded?.kind).toBe('self-judged');
  });

  it('omits the field entirely when the run is not degraded (old logs still parse)', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log);
    const header = (await log.read())!.header;
    expect(header.degraded).toBeUndefined();
    expect('degraded' in header).toBe(false);
  });

  it('carries the shared model when one was named', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log, {
      kind: 'self-judged',
      model: 'one-model',
      generate: false,
      autonomous: true,
    });
    expect((await log.read())!.header.degraded?.model).toBe('one-model');
  });
});

/**
 * ROUND-5 REGRESSION. The typed label was compose-time state written ONLY into a FRESH run's header
 * (`bootstrap` calls `freshRunHeader` under `if (options.resume !== true)`) and never reconciled on
 * resume — while the models actually used are re-resolved from the CURRENT invocation's flags. A
 * resume with different model flags therefore silently changed which keys ran, and the authoritative
 * record did not follow: the terminal summary printed `degraded: SELF-JUDGED` while
 * `goaly runs show <id>` still printed INDEPENDENCE-UNVERIFIED — or, worse, nothing at all. That is
 * exactly the collapse-recorded-nowhere failure issue #125 exists to prevent, on the path where the
 * log is the only artifact `runs show`, the UI header feed and any downstream consumer read.
 *
 * The record moves by APPEND (a `DEGRADED_ESCALATED` marker), never by rewriting the header — see
 * `degraded-header.test.ts` for why (a crash inside an in-place header rewrite bricks the run). So
 * these assert the DERIVED label (`effectiveDegraded` = header ∨ every marker), which is what every
 * reader reports, and that the header itself is left exactly as written.
 */
describe('drive() — the degraded label is reconciled on resume, never left stale', () => {
  const unverified: DegradedMode = {
    kind: 'independence-unverified',
    model: 'gpt-5-mini',
    generate: true,
    autonomous: true,
  };
  const selfJudged: DegradedMode = { kind: 'self-judged', generate: true, autonomous: true };

  /** Resume the seeded log with a different invocation's wiring label. */
  async function resumeWith(
    log: InMemoryRunLog,
    degraded: DegradedMode | undefined,
  ): Promise<{ msgs: string[] }> {
    const workspace = new FakeWorkspace('0000abc');
    const { logger, records } = recordingLogger();
    await drive(
      {
        compiler: new FakeCompiler(contract),
        seal: new FakeSealGate({ kind: 'approve' }),
        harness: new FakeHarness([{ postHash: '0000abc' }], workspace),
        makeLadder: () => new FakeVerifier([passVerdict()]),
        approver: new FakeApprover([approve()]),
        workspace,
        clock: new ManualClock(),
        budget: new ManualBudgetMeter(false),
        runlog: log,
        logger,
      },
      makeConfig({ goal: 'labelled goal' }),
      runId,
      { resume: true, harness: 'claude', ...(degraded !== undefined ? { degraded } : {}) },
    );
    return { msgs: records.map((r) => r.msg) };
  }

  /** The label every reader reports: the header's, escalated by every appended marker. */
  async function effective(log: InMemoryRunLog): Promise<DegradedMode | undefined> {
    const stored = (await log.read())!;
    return effectiveDegraded(stored.header.degraded, stored.entries);
  }

  it('UPGRADES the record when the resumed invocation collapses the keys further', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log, unverified);

    const { msgs } = await resumeWith(log, selfJudged);

    expect(await effective(log)).toEqual(selfJudged);
    // …by APPENDING a marker, leaving the write-once header exactly as the fresh run wrote it.
    expect((await log.read())!.header.degraded).toEqual(unverified);
    expect((await log.read())!.entries.some((e) => e.event.tag === 'DEGRADED_ESCALATED')).toBe(true);
    expect(msgs.join(' ')).toContain('key wiring differs');
  });

  it('records a label on a resume of a run that started with none', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log);
    expect((await log.read())!.header.degraded).toBeUndefined();

    await resumeWith(log, selfJudged);

    expect(await effective(log)).toEqual(selfJudged);
  });

  it('never DOWNGRADES: iterations that already ran degraded stay on the record', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log, selfJudged);

    const { msgs } = await resumeWith(log, undefined);

    expect(await effective(log)).toEqual(selfJudged);
    expect(msgs.join(' ')).toContain('key wiring differs');
  });

  it('is silent and records nothing when the resumed wiring matches', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log, selfJudged);
    const before = (await log.read())!;
    const beforeHeader = JSON.stringify(before.header);
    const beforeEntries = before.entries.length;

    const { msgs } = await resumeWith(log, selfJudged);

    const after = (await log.read())!;
    expect(JSON.stringify(after.header)).toBe(beforeHeader);
    expect(after.entries.filter((e) => e.event.tag === 'DEGRADED_ESCALATED')).toHaveLength(0);
    expect(after.entries.length).toBe(beforeEntries);
    expect(msgs.join(' ')).not.toContain('key wiring differs');
  });

  it('the appended marker never reaches the reducer (it replays to the same state)', async () => {
    const log = new InMemoryRunLog();
    await driveToDone(log, unverified);
    const beforeState = replay(makeConfig({ goal: 'labelled goal' }), (await log.read())!.entries)
      .state.tag;

    await resumeWith(log, selfJudged);

    const stored = (await log.read())!;
    expect(stored.entries.some((e) => e.event.tag === 'DEGRADED_ESCALATED')).toBe(true);
    expect(replay(makeConfig({ goal: 'labelled goal' }), stored.entries).state.tag).toBe(
      beforeState,
    );
  });
});
