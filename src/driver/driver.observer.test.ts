import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import type { Observer } from '../observe/observer';
import type { OrchestratorEvent, RunOutcome } from '../domain/events';
import { asRunId } from '../domain/ids';
import {
  FakeCompiler,
  FakeSealGate,
  FakeVerifier,
  FakeApprover,
  FakeHarness,
  FakeWorkspace,
  ManualClock,
  ManualBudgetMeter,
  InMemoryRunLog,
  makeFakeContract,
  makeConfig,
  passVerdict,
  failVerdict,
  approve,
  veto,
} from '../testing/fakes';

/** An observer that records the checkpoints it is fired at, so we can assert the Driver's wiring. */
class RecordingObserver implements Observer {
  readonly events: OrchestratorEvent['tag'][] = [];
  readonly outcomes: RunOutcome[] = [];
  async onEvent(event: OrchestratorEvent): Promise<void> {
    this.events.push(event.tag);
  }
  async onOutcome(outcome: RunOutcome): Promise<void> {
    this.outcomes.push(outcome);
  }
}

function makeDeps(over: Partial<DriverDeps> = {}): { deps: DriverDeps; ws: FakeWorkspace } {
  const ws = new FakeWorkspace('aaaaaaa');
  const deps: DriverDeps = {
    compiler: new FakeCompiler(makeFakeContract()),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: 'bbbbbbb' }, { postHash: 'ccccccc' }]),
    makeLadder: () => new FakeVerifier([passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace: ws,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(),
    runlog: new InMemoryRunLog(),
    ...over,
  };
  return { deps, ws };
}

describe('drive() + --explain observer', () => {
  it('fires the observer at the contract, verifier, and sign-off checkpoints, then the outcome', async () => {
    const observer = new RecordingObserver();
    const { deps } = makeDeps({ observer });

    const outcome = await drive(deps, makeConfig({ autonomous: true }), asRunId('run-obs-1'));

    expect(outcome.status).toBe('DONE');
    // The contract freeze, the (passing) ladder run, and the approver Sign-off all reached the observer.
    expect(observer.events).toContain('CONTRACT_COMPILED');
    expect(observer.events).toContain('VERIFIED');
    expect(observer.events).toContain('SIGNOFF_DECIDED');
    // …and the terminal outcome was narrated exactly once, with the real outcome the caller got.
    expect(observer.outcomes).toHaveLength(1);
    expect(observer.outcomes[0]!.status).toBe('DONE');
  });

  it('narrates a stuck ABORTED outcome at the outcome checkpoint', async () => {
    const observer = new RecordingObserver();
    // A workspace that never changes hash → the agent makes no diff, tripping the no-diff stuck
    // detector into an ABORTED stop (a "stuck" outcome the observer is meant to explain).
    const { deps } = makeDeps({
      observer,
      harness: new FakeHarness([{}, {}, {}, {}, {}]),
      makeLadder: () => new FakeVerifier([failVerdict('same error every time')]),
      approver: new FakeApprover([veto('still failing')]),
    });

    const outcome = await drive(deps, makeConfig({ autonomous: true, maxIterations: 10 }), asRunId('run-obs-2'));

    expect(outcome.status).toBe('ABORTED');
    expect(observer.outcomes).toHaveLength(1);
    // The observer is handed the very outcome the caller gets, carrying the stuck reason.
    expect(observer.outcomes[0]!.reason).toBe(outcome.reason);
    expect(observer.outcomes[0]!.reason).toMatch(/no-diff|oscillation|repeat-failure|budget|STUCK_/);
  });

  it('a throwing observer never makes drive() reject (fail-closed, off the control flow)', async () => {
    const exploding: Observer = {
      async onEvent() {
        throw new Error('observer boom');
      },
      async onOutcome() {
        throw new Error('observer boom');
      },
    };
    const { deps } = makeDeps({ observer: exploding });

    const outcome = await drive(deps, makeConfig({ autonomous: true }), asRunId('run-obs-3'));
    expect(outcome.status).toBe('DONE');
  });

  it('writes nothing extra to the replay log — narration is never persisted', async () => {
    const observer = new RecordingObserver();
    const runlog = new InMemoryRunLog();
    const { deps } = makeDeps({ observer, runlog });

    await drive(deps, makeConfig({ autonomous: true }), asRunId('run-obs-4'));

    // Every persisted entry is an OrchestratorEvent — the observer adds none.
    expect(runlog.entries.length).toBeGreaterThan(0);
    for (const entry of runlog.entries) {
      expect(entry.event).toHaveProperty('tag');
    }
  });
});
