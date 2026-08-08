import { describe, it, expect } from 'vitest';
import { ModelSelection, resolveModels } from './models';

describe('resolveModels (cascade)', () => {
  it('no flags → every seam at its tool default', () => {
    expect(resolveModels(ModelSelection.parse({}))).toEqual({
      harness: undefined, compiler: undefined, judge: undefined, approver: undefined, planner: undefined,
      critic: undefined, explain: undefined, approverModels: undefined,
    });
  });

  it('--model cascades to the harness AND every LLM step', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm' }))).toEqual({
      harness: 'm', compiler: 'm', judge: 'm', approver: 'm', planner: 'm', critic: 'm', explain: 'm',
      approverModels: undefined,
    });
  });

  it('--llm-model overrides all LLM steps but not the harness', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', llmModel: 'L' }))).toEqual({
      harness: 'm', compiler: 'L', judge: 'L', approver: 'L', planner: 'L', critic: 'L', explain: 'L',
      approverModels: undefined,
    });
  });

  it('a per-step flag overrides only that step; others fall back to --llm-model', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', llmModel: 'L', judgeModel: 'J' }))).toEqual({
      harness: 'm', compiler: 'L', judge: 'J', approver: 'L', planner: 'L', critic: 'L', explain: 'L',
      approverModels: undefined,
    });
  });

  it('a per-step flag with only --model set: others fall back to --model', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', approverModel: 'A' }))).toEqual({
      harness: 'm', compiler: 'm', judge: 'm', approver: 'A', planner: 'm', critic: 'm', explain: 'm',
      approverModels: undefined,
    });
  });

  it('--approver-models is an explicit list, never cascaded from --model/--llm-model', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', approverModels: ['a', 'b'] }))).toEqual({
      harness: 'm', compiler: 'm', judge: 'm', approver: 'm', planner: 'm', critic: 'm', explain: 'm',
      approverModels: ['a', 'b'],
    });
  });

  it('--planner-model overrides only the planner step (issue #48)', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', llmModel: 'L', plannerModel: 'P' }))).toEqual({
      harness: 'm', compiler: 'L', judge: 'L', approver: 'L', planner: 'P', critic: 'L', explain: 'L',
      approverModels: undefined,
    });
  });

  it('--critic-model overrides only the adversarial critic/refuter steps', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', llmModel: 'L', criticModel: 'C' }))).toEqual({
      harness: 'm', compiler: 'L', judge: 'L', approver: 'L', planner: 'L', critic: 'C', explain: 'L',
      approverModels: undefined,
    });
  });

  it('--explain-model overrides only the explain observer step (issue #8)', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', llmModel: 'L', explainModel: 'E' }))).toEqual({
      harness: 'm', compiler: 'L', judge: 'L', approver: 'L', planner: 'L', critic: 'L', explain: 'E',
      approverModels: undefined,
    });
  });

  it('per-step only (no --model/--llm-model) leaves the rest at tool default', () => {
    expect(resolveModels(ModelSelection.parse({ judgeModel: 'J' }))).toEqual({
      harness: undefined, compiler: undefined, judge: 'J', approver: undefined, planner: undefined,
      critic: undefined, explain: undefined, approverModels: undefined,
    });
  });
});

describe('approver independence by default (issue #125)', () => {
  it('--model does NOT cascade into the approver when the provider has its own default model', () => {
    const r = resolveModels(ModelSelection.parse({ model: 'm' }), { llmProvider: 'claude' });
    // The agent (and the judge rung, which is not the second key) still run on `m`; the Sign-off
    // approver falls back to the provider's own model, so the second key is a DIFFERENT model.
    expect(r.harness).toBe('m');
    expect(r.judge).toBe('m');
    expect(r.approver).toBeUndefined();
    expect(r.approverIndependentFrom).toBe('m');
  });

  it('every other LLM step still follows --model (only the approver is kept independent)', () => {
    const r = resolveModels(ModelSelection.parse({ model: 'm' }), { llmProvider: 'codex' });
    expect([r.compiler, r.planner, r.critic, r.explain]).toEqual(['m', 'm', 'm', 'm']);
  });

  it('an explicit --approver-model always wins (and is not announced as an auto-swap)', () => {
    const r = resolveModels(ModelSelection.parse({ model: 'm', approverModel: 'A' }), {
      llmProvider: 'claude',
    });
    expect(r.approver).toBe('A');
    expect(r.approverIndependentFrom).toBeUndefined();
  });

  it('passing the agent model as --approver-model re-collapses them explicitly (the opt-out)', () => {
    const r = resolveModels(ModelSelection.parse({ model: 'm', approverModel: 'm' }), {
      llmProvider: 'claude',
    });
    expect(r.approver).toBe('m');
    expect(r.approverIndependentFrom).toBeUndefined();
  });

  it('an explicit --approver-models panel is left alone', () => {
    const r = resolveModels(ModelSelection.parse({ model: 'm', approverModels: ['a', 'b'] }), {
      llmProvider: 'claude',
    });
    expect(r.approver).toBe('m');
    expect(r.approverModels).toEqual(['a', 'b']);
    expect(r.approverIndependentFrom).toBeUndefined();
  });

  it('--llm-model is a deliberate choice for the LLM steps and is obeyed', () => {
    const r = resolveModels(ModelSelection.parse({ model: 'm', llmModel: 'L' }), {
      llmProvider: 'claude',
    });
    expect(r.approver).toBe('L');
    expect(r.approverIndependentFrom).toBeUndefined();
  });

  it('is NON-BLOCKING when only one model is available: no --model ⇒ nothing changes', () => {
    const r = resolveModels(ModelSelection.parse({}), { llmProvider: 'claude' });
    expect(r.approver).toBeUndefined();
    expect(r.approverIndependentFrom).toBeUndefined();
  });

  it('is skipped for a provider with no default model of its own (openai would refuse to start)', () => {
    const r = resolveModels(ModelSelection.parse({ model: 'm' }), { llmProvider: 'openai' });
    expect(r.approver).toBe('m');
    expect(r.approverIndependentFrom).toBeUndefined();
  });

  it('keeps the pure cascade when no provider is given (embedders calling resolveModels directly)', () => {
    const r = resolveModels(ModelSelection.parse({ model: 'm' }));
    expect(r.approver).toBe('m');
    expect(r.approverIndependentFrom).toBeUndefined();
  });
});

describe('ModelSelection validation (fail closed at the seam)', () => {
  it('rejects an empty or whitespace-only value', () => {
    expect(ModelSelection.safeParse({ model: '' }).success).toBe(false);
    expect(ModelSelection.safeParse({ llmModel: '   ' }).success).toBe(false);
  });

  it('trims surrounding whitespace', () => {
    expect(ModelSelection.parse({ model: '  opus  ' }).model).toBe('opus');
  });

  it('accepts a non-empty --approver-models list and trims each entry', () => {
    expect(ModelSelection.parse({ approverModels: ['  a  ', 'b'] }).approverModels).toEqual(['a', 'b']);
  });

  it('rejects an empty entry in --approver-models (fail-closed)', () => {
    expect(ModelSelection.safeParse({ approverModels: ['a', '   '] }).success).toBe(false);
  });

  it('rejects an empty --approver-models list', () => {
    expect(ModelSelection.safeParse({ approverModels: [] }).success).toBe(false);
  });
});
