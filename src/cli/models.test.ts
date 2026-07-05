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
