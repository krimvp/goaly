import { describe, it, expect } from 'vitest';
import { ModelSelection, resolveModels } from './models';

describe('resolveModels (cascade)', () => {
  it('no flags → every seam at its tool default', () => {
    expect(resolveModels(ModelSelection.parse({}))).toEqual({
      harness: undefined, compiler: undefined, judge: undefined, approver: undefined, planner: undefined,
    });
  });

  it('--model cascades to the harness AND every LLM step', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm' }))).toEqual({
      harness: 'm', compiler: 'm', judge: 'm', approver: 'm', planner: 'm',
    });
  });

  it('--llm-model overrides all LLM steps but not the harness', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', llmModel: 'L' }))).toEqual({
      harness: 'm', compiler: 'L', judge: 'L', approver: 'L', planner: 'L',
    });
  });

  it('a per-step flag overrides only that step; others fall back to --llm-model', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', llmModel: 'L', judgeModel: 'J' }))).toEqual({
      harness: 'm', compiler: 'L', judge: 'J', approver: 'L', planner: 'L',
    });
  });

  it('a per-step flag with only --model set: others fall back to --model', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', approverModel: 'A' }))).toEqual({
      harness: 'm', compiler: 'm', judge: 'm', approver: 'A', planner: 'm',
    });
  });

  it('--planner-model overrides only the planner step', () => {
    expect(resolveModels(ModelSelection.parse({ model: 'm', plannerModel: 'P' }))).toEqual({
      harness: 'm', compiler: 'm', judge: 'm', approver: 'm', planner: 'P',
    });
  });

  it('per-step only (no --model/--llm-model) leaves the rest at tool default', () => {
    expect(resolveModels(ModelSelection.parse({ judgeModel: 'J' }))).toEqual({
      harness: undefined, compiler: undefined, judge: 'J', approver: undefined, planner: undefined,
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
});
