import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from '../driver/driver';
import type { Telemetry, TelemetryEvent } from './telemetry';
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
  approve,
} from '../testing/fakes';

/**
 * The verification's own telemetry fake/stub: a recording double that captures every event the
 * main run flow emits. It never touches a real sink, the network, or the filesystem — it exists
 * only so the test can assert that `drive()` actually routes through the telemetry seam rather than
 * through some parallel reimplementation that leaves the telemetry module as dead code.
 */
class RecordingTelemetry implements Telemetry {
  readonly events: TelemetryEvent[] = [];
  record(event: TelemetryEvent): void {
    this.events.push(event);
  }
}

/** Wire drive() with in-memory fakes for every seam (this run reaches DONE), plus the telemetry double. */
function makeDeps(telemetry: Telemetry): DriverDeps {
  return {
    compiler: new FakeCompiler(makeFakeContract()),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness: new FakeHarness([{ postHash: 'bbbbbbb' }, { postHash: 'ccccccc' }]),
    makeLadder: () => new FakeVerifier([passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace: new FakeWorkspace('aaaaaaa'),
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(),
    runlog: new InMemoryRunLog(),
    telemetry,
  };
}

describe('telemetry is wired into the main run flow', () => {
  it('drive() emits telemetry through the injected seam across a full run', async () => {
    const telemetry = new RecordingTelemetry();

    const outcome = await drive(makeDeps(telemetry), makeConfig({ autonomous: true }), asRunId('run-telemetry-1'));

    // The run completes normally through the loop (compile -> run -> verify -> sign-off -> outcome)...
    expect(outcome.status).toBe('DONE');
    // ...and the main flow actually went THROUGH the telemetry seam. Telemetry that is never wired
    // into drive(), or a parallel reimplementation that bypasses deps.telemetry, records zero calls
    // and fails here.
    expect(telemetry.events.length).toBeGreaterThanOrEqual(2);
  });

  it('telemetry is fail-closed: a throwing sink never makes drive() reject (invariant #4)', async () => {
    const exploding: Telemetry = {
      record(): void {
        throw new Error('telemetry sink boom');
      },
    };

    const outcome = await drive(makeDeps(exploding), makeConfig({ autonomous: true }), asRunId('run-telemetry-2'));

    // Observability must never take down a run: a throwing telemetry sink is swallowed, run still DONE.
    expect(outcome.status).toBe('DONE');
  });
});
