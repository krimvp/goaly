import { describe, it, expect } from 'vitest';
import { LlmTokenMeter, meterLlm, deltaToUsage } from './llm-meter';
import { FakeLlm } from '../llm/provider';

describe('LlmTokenMeter', () => {
  it('accrues reported tokens and resets on take()', () => {
    const meter = new LlmTokenMeter();
    meter.record(100);
    meter.record(50);
    expect(meter.take()).toEqual({ tokens: 150, calls: 2, unknownCalls: 0 });
    // take() resets, so the next read starts fresh.
    expect(meter.take()).toEqual({ tokens: 0, calls: 0, unknownCalls: 0 });
  });

  it('counts a call with no reported tokens as unknown, not zero', () => {
    const meter = new LlmTokenMeter();
    meter.record(undefined);
    meter.record(40);
    expect(meter.take()).toEqual({ tokens: 40, calls: 2, unknownCalls: 1 });
  });
});

describe('meterLlm', () => {
  it('feeds each completion’s usage to the meter and returns it verbatim', async () => {
    const meter = new LlmTokenMeter();
    const fake = new FakeLlm([{ text: 'a', tokensUsed: 7 }, { text: 'b', tokensUsed: 3 }]);
    const metered = meterLlm(fake, meter);

    expect(metered.name).toBe(fake.name);
    expect(await metered.complete({ prompt: 'x' })).toEqual({ text: 'a', tokensUsed: 7 });
    expect(await metered.complete({ prompt: 'y' })).toEqual({ text: 'b', tokensUsed: 3 });
    expect(meter.take()).toEqual({ tokens: 10, calls: 2, unknownCalls: 0 });
    // The inner provider still received both requests.
    expect(fake.requests).toHaveLength(2);
  });
});

describe('deltaToUsage', () => {
  it('returns undefined when no call was made (distinguishing "no call" from "zero tokens")', () => {
    expect(deltaToUsage({ tokens: 0, calls: 0, unknownCalls: 0 })).toBeUndefined();
  });

  it('returns the usage when at least one call was made', () => {
    expect(deltaToUsage({ tokens: 12, calls: 1, unknownCalls: 0 })).toEqual({
      tokens: 12,
      calls: 1,
      unknownCalls: 0,
    });
  });
});
