import { describe, it, expect } from 'vitest';
import { SystemBudgetMeter } from './budget';
import { ManualClock } from '../testing/fakes';

describe('SystemBudgetMeter', () => {
  it('token cap: not exceeded below, exceeded at the threshold boundary (>=)', () => {
    const meter = new SystemBudgetMeter({ tokens: 100 }, new ManualClock(0));
    meter.record(50);
    expect(meter.snapshot().exceeded).toBe(false);
    meter.record(50); // total exactly 100 == cap
    expect(meter.snapshot().exceeded).toBe(true);
    expect(meter.snapshot().tokensSpent).toBe(100);
  });

  it('wall-clock cap fires only once the clock advances to/past the limit', () => {
    const clock = new ManualClock(0);
    const meter = new SystemBudgetMeter({ wallClockMs: 1000 }, clock);
    expect(meter.snapshot().exceeded).toBe(false);
    clock.advance(999);
    expect(meter.snapshot().exceeded).toBe(false);
    clock.advance(1); // now exactly at the cap
    expect(meter.snapshot().exceeded).toBe(true);
  });

  it('either cap alone trips exceeded (disjunction)', () => {
    const meter = new SystemBudgetMeter({ tokens: 10, wallClockMs: 1_000_000 }, new ManualClock(0));
    meter.record(10);
    expect(meter.snapshot().exceeded).toBe(true);
  });

  it('record(undefined) and record(0) do not accumulate; a positive amount does', () => {
    const meter = new SystemBudgetMeter({ tokens: 5 }, new ManualClock(0));
    meter.record(undefined);
    meter.record(0);
    expect(meter.snapshot().tokensSpent).toBe(0);
    expect(meter.snapshot().exceeded).toBe(false);
    meter.record(5);
    expect(meter.snapshot().exceeded).toBe(true);
  });

  it('tracks the estimated portion of spend, clamped, and omits it when nothing was estimated', () => {
    const meter = new SystemBudgetMeter({}, new ManualClock(0));
    meter.record(100); // reported → estimates nothing
    expect(meter.snapshot().tokensEstimated).toBeUndefined();
    meter.record(60, 60); // a fully estimated call
    meter.record(40, 999); // estimate clamped to the call's tokens
    const snap = meter.snapshot();
    expect(snap.tokensSpent).toBe(200);
    expect(snap.tokensEstimated).toBe(100);
  });

  it('with no caps configured, never exceeded regardless of spend or elapsed time', () => {
    const clock = new ManualClock(0);
    const meter = new SystemBudgetMeter({}, clock);
    meter.record(1_000_000);
    clock.advance(1_000_000);
    expect(meter.snapshot().exceeded).toBe(false);
  });
});
