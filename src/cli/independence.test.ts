import { describe, it, expect } from 'vitest';
import { independenceWarnings } from './independence';
import { resolveModels } from './models';

describe('independenceWarnings', () => {
  it('warns on the default cascade: --model X collapses judge, approver, and worker', () => {
    const resolved = resolveModels({ model: 'claude-x' });
    const w = independenceWarnings(resolved, 'claude', 'claude');
    expect(w).toHaveLength(2);
    expect(w.join(' ')).toContain('judge');
    expect(w.join(' ')).toContain('coding agent');
    expect(w.join(' ')).toContain('claude-x');
  });

  it('warns on pure defaults (every model undefined → one vendor)', () => {
    const w = independenceWarnings(resolveModels({}), 'claude', 'claude');
    expect(w.length).toBeGreaterThan(0);
  });

  it('is silent once the approver is given its own model', () => {
    const resolved = resolveModels({ model: 'claude-x', approverModel: 'other-model' });
    expect(independenceWarnings(resolved, 'claude', 'claude')).toEqual([]);
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
    const w = independenceWarnings(resolved, 'claude', 'claude');
    // judge ('j') != approver ('m') now, so no judge↔approver warning; worker↔approver still holds.
    expect(w.some((s) => s.includes('judge'))).toBe(false);
    expect(w.some((s) => s.includes('coding agent'))).toBe(true);
  });

  describe('--generate --autonomous self-judge escalation (follow-on H)', () => {
    it('escalates when worker, judge, and approver all collapse onto one model', () => {
      const resolved = resolveModels({ model: 'claude-x' });
      const w = independenceWarnings(resolved, 'claude', 'claude', { generate: true, autonomous: true });
      // The escalated warning leads and names the self-judge risk + the remedy.
      expect(w[0]).toContain('SELF-JUDGE RISK');
      expect(w[0]).toContain('--approver-model');
      expect(w[0]).toContain('claude-x');
      // The plain advisories still follow it (escalation augments, never replaces).
      expect(w.length).toBeGreaterThanOrEqual(3);
    });

    it('does NOT escalate without --generate (a user-supplied --verify-cmd is not self-authored)', () => {
      const resolved = resolveModels({ model: 'claude-x' });
      const w = independenceWarnings(resolved, 'claude', 'claude', { generate: false, autonomous: true });
      expect(w.some((s) => s.includes('SELF-JUDGE RISK'))).toBe(false);
    });

    it('does NOT escalate without --autonomous (a human reviews the frozen bar at Seal)', () => {
      const resolved = resolveModels({ model: 'claude-x' });
      const w = independenceWarnings(resolved, 'claude', 'claude', { generate: true, autonomous: false });
      expect(w.some((s) => s.includes('SELF-JUDGE RISK'))).toBe(false);
    });

    it('does NOT escalate once the approver is on its own model (the collapse is broken)', () => {
      const resolved = resolveModels({ model: 'claude-x', approverModel: 'other' });
      const w = independenceWarnings(resolved, 'claude', 'claude', { generate: true, autonomous: true });
      expect(w).toEqual([]);
    });

    it('does NOT escalate when the worker is a different vendor than the approver', () => {
      // codex harness + claude llm-provider: judge↔approver still collapse, but the worker does not —
      // so it is not the all-three self-judge case, only the judge↔approver advisory.
      const resolved = resolveModels({ model: 'm' });
      const w = independenceWarnings(resolved, 'codex', 'claude', { generate: true, autonomous: true });
      expect(w.some((s) => s.includes('SELF-JUDGE RISK'))).toBe(false);
      expect(w.some((s) => s.includes('judge'))).toBe(true);
    });
  });

  describe('--approver-quorum on one model = variance reduction (issue #84)', () => {
    it('notes a multi-vote panel that shares a model with the judge/worker', () => {
      const resolved = resolveModels({ model: 'claude-x' });
      const w = independenceWarnings(resolved, 'claude', 'claude', { approverQuorum: 3 });
      const note = w.find((s) => s.includes('VARIANCE REDUCTION'));
      expect(note).toBeDefined();
      expect(note).toContain('3-reviewer quorum');
      expect(note).toContain('--approver-model');
    });

    it('does NOT add the note at quorum 1 (the single-call approver)', () => {
      const resolved = resolveModels({ model: 'claude-x' });
      const w = independenceWarnings(resolved, 'claude', 'claude', { approverQuorum: 1 });
      expect(w.some((s) => s.includes('VARIANCE REDUCTION'))).toBe(false);
    });

    it('does NOT add the note when the panel is on its own --approver-model (already independent)', () => {
      const resolved = resolveModels({ model: 'claude-x', approverModel: 'other-model' });
      const w = independenceWarnings(resolved, 'claude', 'claude', { approverQuorum: 3 });
      expect(w.some((s) => s.includes('VARIANCE REDUCTION'))).toBe(false);
    });
  });

  describe('--approver-models per-reviewer independence (follow-up to issue #84)', () => {
    it('≥2 distinct models ⇒ no variance-reduction-only warning (the panel IS independent)', () => {
      const resolved = resolveModels({ model: 'claude-x', approverModels: ['model-a', 'model-b'] });
      const w = independenceWarnings(resolved, 'claude', 'claude', {
        approverQuorum: 3,
        approverModels: ['model-a', 'model-b'],
      });
      expect(w.some((s) => s.includes('VARIANCE REDUCTION'))).toBe(false);
    });

    it('≥2 distinct models suppress the judge↔approver and worker↔approver collapse warnings', () => {
      // Default cascade (--model claude-x) would normally collapse all three onto claude-x; a genuine
      // per-reviewer panel breaks that — no collapse warnings at all.
      const resolved = resolveModels({ model: 'claude-x', approverModels: ['a', 'b'] });
      const w = independenceWarnings(resolved, 'claude', 'claude', { approverModels: ['a', 'b'] });
      expect(w).toEqual([]);
    });

    it('≥2 distinct models suppress the --generate --autonomous self-judge escalation', () => {
      const resolved = resolveModels({ model: 'claude-x', approverModels: ['a', 'b'] });
      const w = independenceWarnings(resolved, 'claude', 'claude', {
        generate: true,
        autonomous: true,
        approverModels: ['a', 'b'],
      });
      expect(w).toEqual([]);
    });

    it('ONE model in the list ⇒ still the single-model panel, warning kept', () => {
      const resolved = resolveModels({ model: 'claude-x', approverModels: ['claude-x'] });
      const w = independenceWarnings(resolved, 'claude', 'claude', {
        approverQuorum: 3,
        approverModels: ['claude-x'],
      });
      expect(w.some((s) => s.includes('VARIANCE REDUCTION'))).toBe(true);
    });

    it('a list whose entries are all the SAME model is not independent (warning kept)', () => {
      const resolved = resolveModels({ model: 'claude-x', approverModels: ['m', 'm', 'm'] });
      const w = independenceWarnings(resolved, 'claude', 'claude', {
        approverQuorum: 3,
        approverModels: ['m', 'm', 'm'],
      });
      expect(w.some((s) => s.includes('VARIANCE REDUCTION'))).toBe(true);
    });
  });
});
