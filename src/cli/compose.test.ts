import { describe, it, expect } from 'vitest';
import { makeLlmProvider, codexCompletionArgs, droidCompletionArgs } from './compose';

describe('LLM provider completion argv (read-only)', () => {
  it('codex runs --sandbox read-only with the model before the prompt positional', () => {
    expect(codexCompletionArgs('judge this', 'gpt-x')).toEqual([
      'exec', '--sandbox', 'read-only', '--model', 'gpt-x', 'judge this', '--json',
    ]);
  });

  it('codex omits --model when none is set', () => {
    expect(codexCompletionArgs('p', undefined)).toEqual([
      'exec', '--sandbox', 'read-only', 'p', '--json',
    ]);
  });

  it('droid never passes --auto (the exec default cannot edit the tree)', () => {
    const args = droidCompletionArgs('p', 'm1');
    expect(args).toEqual(['exec', '--output-format', 'json', '--model', 'm1', 'p']);
    expect(args).not.toContain('--auto');
  });
});

describe('makeLlmProvider', () => {
  it('names the provider after the chosen CLI', () => {
    expect(makeLlmProvider('claude', undefined).name).toBe('cli:claude');
    expect(makeLlmProvider('codex', undefined).name).toBe('codex');
    expect(makeLlmProvider('droid', undefined).name).toBe('droid');
  });
});
