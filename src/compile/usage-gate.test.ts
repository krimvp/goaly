import { describe, it, expect } from 'vitest';
import { FakeLlm, type LlmCompletion, type LlmProvider } from '../llm/provider';
import { classifyUsageShape, enforceUsageAssertion, type UsageShape } from './usage-gate';

class ThrowingLlm implements LlmProvider {
  readonly name = 'throwing';
  complete(): Promise<LlmCompletion> {
    return Promise.reject(new Error('provider down'));
  }
}

const BUILD_AND_USE: UsageShape = {
  buildAndUse: true,
  targetArtifact: 'World',
  reason: 'builds an engine and uses it',
};

describe('classifyUsageShape', () => {
  it('parses a clean build-and-use verdict', async () => {
    const llm = new FakeLlm([JSON.stringify(BUILD_AND_USE)]);
    const shape = await classifyUsageShape(llm, 'build a physics engine and solve problems with it', undefined);
    expect(shape.buildAndUse).toBe(true);
    expect(shape.targetArtifact).toBe('World');
  });

  it('threads the intent into the classification prompt', async () => {
    const llm = new FakeLlm([JSON.stringify(BUILD_AND_USE)]);
    await classifyUsageShape(llm, 'build X', 'the engine must power the demo');
    expect(llm.requests[0]?.prompt).toContain('build X');
    expect(llm.requests[0]?.prompt).toContain('the engine must power the demo');
    expect(llm.requests[0]?.temperature).toBe(0);
  });

  it('tolerates JSON wrapped in prose / fences', async () => {
    const llm = new FakeLlm(['Sure:\n```json\n' + JSON.stringify(BUILD_AND_USE) + '\n```\n']);
    const shape = await classifyUsageShape(llm, 'g', undefined);
    expect(shape.buildAndUse).toBe(true);
  });

  it('fail-opens to not-build-and-use on garbage output', async () => {
    const llm = new FakeLlm(['not json at all']);
    const shape = await classifyUsageShape(llm, 'g', undefined);
    expect(shape.buildAndUse).toBe(false);
  });

  it('fail-opens to not-build-and-use when the JSON does not match the schema', async () => {
    const llm = new FakeLlm([JSON.stringify({ buildAndUse: 'yes please' })]);
    const shape = await classifyUsageShape(llm, 'g', undefined);
    expect(shape.buildAndUse).toBe(false);
  });

  it('fail-opens to not-build-and-use when the provider throws', async () => {
    const shape = await classifyUsageShape(new ThrowingLlm(), 'g', undefined);
    expect(shape.buildAndUse).toBe(false);
    expect(shape.reason).toMatch(/failed/);
  });
});

describe('enforceUsageAssertion', () => {
  const files = [{ path: 'tests/test_physics.py', content: 'spy = wrap(World.step); assert spy.calls > 0' }];

  it('is a no-op when the goal is not build-and-use (even with no assertion)', () => {
    expect(() =>
      enforceUsageAssertion({
        shape: { buildAndUse: false, targetArtifact: null, reason: 'plain bugfix' },
        usageAssertion: undefined,
        files: [],
      }),
    ).not.toThrow();
  });

  it('throws when a build-and-use contract declares no usage assertion', () => {
    expect(() =>
      enforceUsageAssertion({ shape: BUILD_AND_USE, usageAssertion: undefined, files }),
    ).toThrow(/BUILD-AND-USE/);
  });

  it('throws when a declared target symbol is not referenced by any authored file (hollow)', () => {
    expect(() =>
      enforceUsageAssertion({
        shape: BUILD_AND_USE,
        usageAssertion: { targetSymbols: ['World.step', 'resolve_collision'], description: 'spy' },
        files, // content mentions World.step but NOT resolve_collision
      }),
    ).toThrow(/not referenced/);
  });

  it('accepts a build-and-use contract whose declared symbols all appear in a frozen file', () => {
    expect(() =>
      enforceUsageAssertion({
        shape: BUILD_AND_USE,
        usageAssertion: { targetSymbols: ['World.step'], description: 'spy World.step and assert calls' },
        files,
      }),
    ).not.toThrow();
  });

  it('accepts a dotted declaration whose LEAF identifier is what the file actually spies', () => {
    // Small models declare the qualified path (`World.prototype.step`) while the file (correctly)
    // spies `step` — that spy IS the declared entry point, so the gate must not reject it as hollow.
    const spied = [{ path: 'verify/spy.test.js', content: 'const orig = proto.step; proto.step = wrap(orig); assert(calls.step > 0)' }];
    expect(() =>
      enforceUsageAssertion({
        shape: BUILD_AND_USE,
        usageAssertion: { targetSymbols: ['World.prototype.step'], description: 'spy' },
        files: spied,
      }),
    ).not.toThrow();
  });

  it('the leaf match is word-bounded — "step" inside "steps" is still hollow', () => {
    const near = [{ path: 'verify/spy.test.js', content: 'let steps = 0; steps += 1;' }];
    expect(() =>
      enforceUsageAssertion({
        shape: BUILD_AND_USE,
        usageAssertion: { targetSymbols: ['World.prototype.step'], description: 'spy' },
        files: near,
      }),
    ).toThrow(/not referenced/);
  });

  it('the hollow-assertion feedback tells the model HOW to declare symbols', () => {
    expect(() =>
      enforceUsageAssertion({
        shape: BUILD_AND_USE,
        usageAssertion: { targetSymbols: ['resolve_collision'], description: 'spy' },
        files,
      }),
    ).toThrow(/literally appears in that file/);
  });
});
