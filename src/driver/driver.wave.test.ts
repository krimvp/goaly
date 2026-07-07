import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import { asRunId } from '../domain/ids';
import {
  FakeApprover,
  FakeCompiler,
  FakeHarness,
  FakePlanGate,
  FakePlanner,
  FakeSealGate,
  FakeVerifier,
  FakeWorkspace,
  InMemoryRunLog,
  ManualBudgetMeter,
  ManualClock,
  approve,
  makeConfig,
  makeFakeContract,
  makeFakePlan,
  passVerdict,
} from '../testing/fakes';

describe('driver — RUN_WAVE fail-closed (EXPERIMENTAL parallel waves)', () => {
  it('a wave with NO runner configured downgrades EVERY member to sequential and the run still finishes', async () => {
    // A grouped, parallel-enabled plan… but the deps carry no `wave` seam (an embedder that never
    // wired one). The wave must degrade to the classic sequential phased run — never crash, never
    // skip a phase, never green anything unverified.
    const plan = makeFakePlan({
      phases: [
        { goal: 'member A', group: 1 },
        { goal: 'member B', group: 1 },
      ],
    });
    const config = makeConfig({ phased: true, parallelPhases: true, autonomous: true });
    const workspace = new FakeWorkspace('0000000');
    const runlog = new InMemoryRunLog();
    const deps: DriverDeps = {
      planner: new FakePlanner(plan),
      planGate: new FakePlanGate(),
      compiler: new FakeCompiler(makeFakeContract()),
      seal: new FakeSealGate(),
      // Three sequential worker turns: fallback phase A, fallback phase B, then acceptance.
      harness: new FakeHarness(
        [{ postHash: '0000aaa' }, { postHash: '0000bbb' }, { postHash: '0000ccc' }],
        workspace,
      ),
      makeLadder: () => new FakeVerifier([passVerdict()]),
      approver: new FakeApprover([approve(), approve(), approve()]),
      workspace,
      clock: new ManualClock(),
      budget: new ManualBudgetMeter(false),
      runlog,
      // no `wave` — the fail-closed path under test
    };

    const outcome = await drive(deps, config, asRunId('run-wave-noseam'));

    expect(outcome.status).toBe('DONE');
    const stored = await runlog.read();
    const wave = stored?.entries.find((e) => e.event.tag === 'WAVE_RAN');
    expect(wave?.event.tag).toBe('WAVE_RAN');
    if (wave?.event.tag === 'WAVE_RAN') {
      expect(wave.event.outcomes.map((o) => o.kind)).toEqual(['unmerged', 'unmerged']);
      if (wave.event.outcomes[0]!.kind === 'unmerged') {
        expect(wave.event.outcomes[0]!.reason).toContain('wave fan-out unavailable');
      }
    }
    // Both members + acceptance ran the classic sequential path: three agent turns in the log.
    const turns = stored?.entries.filter((e) => e.event.tag === 'AGENT_RAN') ?? [];
    expect(turns).toHaveLength(3);
  });
});
