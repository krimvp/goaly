import { describe, it, expect } from 'vitest';
import { LlmTokenMeter, meterLlm, deltaToUsage } from './llm-meter';
import { FakeLlm } from '../llm/provider';

describe('LlmTokenMeter', () => {
  it('accrues reported tokens and resets on take()', () => {
    const meter = new LlmTokenMeter();
    meter.record(100);
    meter.record(50);
    expect(meter.take()).toEqual({
      tokens: 150,
      calls: 2,
      unknownCalls: 0,
      estimatedTokens: 0,
      breakdown: {},
    });
    // take() resets, so the next read starts fresh.
    expect(meter.take()).toEqual({
      tokens: 0,
      calls: 0,
      unknownCalls: 0,
      estimatedTokens: 0,
      breakdown: {},
    });
  });

  it('counts a call with no reported tokens as unknown, not zero', () => {
    const meter = new LlmTokenMeter();
    meter.record(undefined);
    meter.record(40);
    expect(meter.take()).toEqual({
      tokens: 40,
      calls: 2,
      unknownCalls: 1,
      estimatedTokens: 0,
      breakdown: {},
    });
  });

  it('tracks the estimated portion of a call separately (issue #24), clamped to the count', () => {
    const meter = new LlmTokenMeter();
    meter.record(100); // a reported call estimates nothing
    meter.record(60, 60); // a fully estimated call
    meter.record(40, 999); // estimate clamped to the call's tokens
    expect(meter.take()).toEqual({
      tokens: 200,
      calls: 3,
      unknownCalls: 0,
      estimatedTokens: 100,
      breakdown: {},
    });
  });

  it('accrues the per-category breakdown of reported calls (cache included)', () => {
    const meter = new LlmTokenMeter();
    meter.record(21_061, 0, { input: 3, output: 12, cacheRead: 17_773, cacheWrite: 3_273 });
    meter.record(30, 0, { input: 10, output: 20 });
    expect(meter.take()).toEqual({
      tokens: 21_091,
      calls: 2,
      unknownCalls: 0,
      estimatedTokens: 0,
      breakdown: { input: 13, output: 32, cacheRead: 17_773, cacheWrite: 3_273 },
    });
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
    expect(meter.take()).toEqual({
      tokens: 10,
      calls: 2,
      unknownCalls: 0,
      estimatedTokens: 0,
      breakdown: {},
    });
    // The inner provider still received both requests.
    expect(fake.requests).toHaveLength(2);
  });
});

describe('deltaToUsage', () => {
  it('returns undefined when no call was made (distinguishing "no call" from "zero tokens")', () => {
    expect(deltaToUsage({ tokens: 0, calls: 0, unknownCalls: 0, estimatedTokens: 0 })).toBeUndefined();
  });

  it('returns the usage when at least one call was made', () => {
    expect(deltaToUsage({ tokens: 12, calls: 1, unknownCalls: 0, estimatedTokens: 0 })).toEqual({
      tokens: 12,
      calls: 1,
      unknownCalls: 0,
    });
  });

  it('carries the estimated portion through when present (issue #24)', () => {
    expect(deltaToUsage({ tokens: 12, calls: 1, unknownCalls: 0, estimatedTokens: 12 })).toEqual({
      tokens: 12,
      calls: 1,
      unknownCalls: 0,
      estimatedTokens: 12,
    });
  });

  it('carries a non-empty breakdown through; omits an empty one', () => {
    expect(
      deltaToUsage({
        tokens: 30,
        calls: 1,
        unknownCalls: 0,
        estimatedTokens: 0,
        breakdown: { input: 10, output: 20 },
      }),
    ).toEqual({ tokens: 30, calls: 1, unknownCalls: 0, breakdown: { input: 10, output: 20 } });
    expect(
      deltaToUsage({ tokens: 30, calls: 1, unknownCalls: 0, estimatedTokens: 0, breakdown: {} }),
    ).toEqual({ tokens: 30, calls: 1, unknownCalls: 0 });
  });
});
