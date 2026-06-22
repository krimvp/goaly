import { describe, it, expect } from 'vitest';
import { independenceWarnings } from './independence';
import { resolveModels } from './models';

describe('independenceWarnings (C3)', () => {
  it('warns on the default cascade: --model X collapses judge, approver, and worker', () => {
    const resolved = resolveModels({ model: 'claude-x' });
    const w = independenceWarnings(resolved, 'claude-code', 'claude');
    expect(w).toHaveLength(2);
    expect(w.join(' ')).toContain('judge');
    expect(w.join(' ')).toContain('coding agent');
    expect(w.join(' ')).toContain('claude-x');
  });

  it('warns on pure defaults (every model undefined → one vendor)', () => {
    const w = independenceWarnings(resolveModels({}), 'claude-code', 'claude');
    expect(w.length).toBeGreaterThan(0);
  });

  it('is silent once the approver is given its own model', () => {
    const resolved = resolveModels({ model: 'claude-x', approverModel: 'other-model' });
    expect(independenceWarnings(resolved, 'claude-code', 'claude')).toEqual([]);
  });

  it('does not warn about the worker when the harness vendor differs from the llm-provider', () => {
    // codex harness + claude llm-provider: the approver is a different vendor than the worker, so
    // only the judge↔approver concern can apply.
    const resolved = resolveModels({ model: 'm' });
    const w = independenceWarnings(resolved, 'codex', 'claude');
    expect(w.some((s) => s.includes('coding agent'))).toBe(false);
    expect(w.some((s) => s.includes('judge'))).toBe(true);
  });

  it('keeps the judge↔approver warning when only the judge model is separated', () => {
    const resolved = resolveModels({ model: 'm', judgeModel: 'j' });
    const w = independenceWarnings(resolved, 'claude-code', 'claude');
    // judge ('j') != approver ('m') now, so no judge↔approver warning; worker↔approver still holds.
    expect(w.some((s) => s.includes('judge'))).toBe(false);
    expect(w.some((s) => s.includes('coding agent'))).toBe(true);
  });
});
