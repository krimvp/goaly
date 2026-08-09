import { describe, it, expect } from 'vitest';
import { approverSwapNotice, degradedMode, independenceWarnings } from './independence';
import { resolveModels } from './models';
import { DegradedMode, degradedModeDetail, degradedModeTag } from '../domain/degraded';

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

  describe('an UNRESOLVABLE approver default is never read as independence (issue #125 follow-up)', () => {
    // `--model X` + a provider with its own default model: the approver DECLINES to inherit X and is
    // left `undefined` ("the provider's own default"). goaly cannot resolve that default's id, so
    // `X !== undefined` proves nothing — if the default IS X, all three roles are one model.
    const unresolved = () => resolveModels({ model: 'claude-x' }, { llmProvider: 'claude' });

    it('warns that the judge↔approver independence is UNVERIFIED rather than staying silent', () => {
      const w = independenceWarnings(unresolved(), 'claude', 'claude');
      expect(w.length).toBeGreaterThan(0);
      const note = w.find((s) => s.includes('UNVERIFIED') && s.includes('judge'));
      expect(note).toBeDefined();
      expect(note).toContain('claude-x');
      expect(note).toContain('--approver-model');
    });

    it('warns that the coding agent↔approver independence is UNVERIFIED too', () => {
      const w = independenceWarnings(unresolved(), 'claude', 'claude');
      expect(w.some((s) => s.includes('UNVERIFIED') && s.includes('coding agent'))).toBe(true);
    });

    it('escalates the --generate --autonomous case as an UNVERIFIED self-judge risk', () => {
      const w = independenceWarnings(unresolved(), 'claude', 'claude', {
        generate: true,
        autonomous: true,
      });
      expect(w[0]).toContain('SELF-JUDGE RISK');
      expect(w[0]).toContain('UNVERIFIED');
    });

    it('says nothing about unverified independence once --approver-model names a real model', () => {
      const resolved = resolveModels(
        { model: 'claude-x', approverModel: 'other' },
        { llmProvider: 'claude' },
      );
      expect(independenceWarnings(resolved, 'claude', 'claude')).toEqual([]);
    });

    it('a genuinely independent --approver-models panel is not "unverified" either', () => {
      const resolved = resolveModels(
        { model: 'claude-x', approverModels: ['a', 'b'] },
        { llmProvider: 'claude' },
      );
      expect(independenceWarnings(resolved, 'claude', 'claude', { approverModels: ['a', 'b'] })).toEqual([]);
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

describe('degradedMode (issue #125): the typed self-judged label', () => {
  it('labels the zero-config default run (agent = judge = approver = the tool default)', () => {
    const d = degradedMode(resolveModels({}), 'claude', 'claude', {
      generate: true,
      autonomous: true,
    });
    expect(d).toEqual({ kind: 'self-judged', generate: true, autonomous: true });
    // No `model` key at all: absent means "the tool's own default model", never a guessed id.
    expect(d !== undefined && 'model' in d).toBe(false);
    expect(DegradedMode.safeParse(d).success).toBe(true);
  });

  it('names the shared model when one was selected', () => {
    const d = degradedMode(resolveModels({ model: 'claude-x' }), 'claude', 'claude', {});
    expect(d?.model).toBe('claude-x');
    // Recorded even without --generate/--autonomous: the collapse is what degrades the second key.
    expect(d).toMatchObject({ kind: 'self-judged', generate: false, autonomous: false });
  });

  it('is ABSENT once the approver runs on its own model (the second key is independent)', () => {
    const resolved = resolveModels({ model: 'claude-x', approverModel: 'other' });
    expect(degradedMode(resolved, 'claude', 'claude')).toBeUndefined();
  });

  it('labels the auto-declined approver as UNVERIFIED, not as an independent second key', () => {
    // Issue #125 part 1 leaves the approver on the provider's OWN default model, whose id goaly
    // cannot resolve. That is not evidence of independence — if the default is `claude-x`, every
    // role is one model and the old code reported nothing at all.
    const resolved = resolveModels({ model: 'claude-x' }, { llmProvider: 'claude' });
    const d = degradedMode(resolved, 'claude', 'claude', { generate: true, autonomous: true });
    expect(d).toEqual({
      kind: 'independence-unverified',
      model: 'claude-x',
      generate: true,
      autonomous: true,
    });
    expect(DegradedMode.safeParse(d).success).toBe(true);
    // It must never be confused with the VERIFIED full collapse.
    expect(d?.kind).not.toBe('self-judged');
    expect(degradedModeTag(d!)).toBe('INDEPENDENCE-UNVERIFIED');
    const detail = degradedModeDetail(d!);
    expect(detail).toContain('claude-x');
    expect(detail).toContain('--approver-model');
  });

  it('stays ABSENT when the approver default cannot collide with the worker (different vendor)', () => {
    // `--harness claude --llm-provider codex --model X`: the approver runs on codex's own default, so
    // the worker↔approver pair is genuinely independent — only the judge↔approver pair is unverified.
    const resolved = resolveModels({ model: 'claude-x' }, { llmProvider: 'codex' });
    expect(degradedMode(resolved, 'claude', 'codex')).toBeUndefined();
    expect(independenceWarnings(resolved, 'claude', 'codex').some((s) => s.includes('UNVERIFIED'))).toBe(
      true,
    );
  });

  it('is ABSENT on a PARTIAL collapse (judge↔approver only — the worker is a different vendor)', () => {
    // codex harness + claude llm-provider: the approver is not the model that wrote the code.
    const resolved = resolveModels({ model: 'm' });
    expect(independenceWarnings(resolved, 'codex', 'claude').length).toBeGreaterThan(0);
    expect(degradedMode(resolved, 'codex', 'claude')).toBeUndefined();
  });

  it('is ABSENT for a genuinely perspective-independent --approver-models panel', () => {
    const resolved = resolveModels({ model: 'm', approverModels: ['a', 'b'] });
    expect(degradedMode(resolved, 'claude', 'claude', { approverModels: ['a', 'b'] })).toBeUndefined();
  });

  it('is PRESENT for a one-model panel (variance reduction is not independence)', () => {
    const resolved = resolveModels({ model: 'm', approverModels: ['m'] });
    expect(
      degradedMode(resolved, 'claude', 'claude', { approverQuorum: 3, approverModels: ['m'] }),
    ).toMatchObject({ kind: 'self-judged', model: 'm' });
  });

  it('agrees with the startup WARN: whenever the run is degraded, the escalation fired too', () => {
    const resolved = resolveModels({ model: 'm' });
    const ctx = { generate: true, autonomous: true };
    expect(degradedMode(resolved, 'claude', 'claude', ctx)).toBeDefined();
    expect(independenceWarnings(resolved, 'claude', 'claude', ctx)[0]).toContain('SELF-JUDGE RISK');
  });

  it('renders a label that names the remedy', () => {
    const d = degradedMode(resolveModels({ model: 'm' }), 'claude', 'claude', {
      generate: true,
      autonomous: true,
    });
    expect(d).toBeDefined();
    expect(degradedModeTag(d!)).toBe('SELF-JUDGED');
    const detail = degradedModeDetail(d!);
    expect(detail).toContain('m');
    expect(detail).toContain('--generate --autonomous');
    expect(detail).toContain('--approver-model');
  });
});

/**
 * ROUND-5 REGRESSION. The REAL run path printed the issue-#125 notice unconditionally whenever the
 * approver-independence default fired: "the second key is a different model than the one that wrote
 * the code" — a verified claim, emitted sandwiched between two INDEPENDENCE-UNVERIFIED warnings and
 * a degraded-mode WARN saying the opposite. The dry-run sibling had already been corrected; the run
 * path had not, so the run's own diagnostics contradicted themselves and the most strongly-worded
 * of them was the false one.
 */
describe('approverSwapNotice — never reports UNVERIFIED independence as verified', () => {
  it('says UNVERIFIED when the approver sits on the provider default it cannot resolve', () => {
    const resolved = resolveModels({ model: 'gpt-5-mini' }, { llmProvider: 'claude' });
    const notice = approverSwapNotice(resolved, 'claude', 'claude');

    expect(notice).toBeDefined();
    expect(notice).toContain('INDEPENDENCE UNVERIFIED');
    expect(notice).toContain('DECLINED to inherit');
    expect(notice).not.toContain('is a different model than the one that wrote the code');
    expect(notice).not.toContain('kept INDEPENDENT');
    // …and it agrees with the label the very same wiring records in the run header.
    expect(degradedMode(resolved, 'claude', 'claude')?.kind).toBe('independence-unverified');
  });

  it('keeps the confirmed wording only when the pair IS established independent', () => {
    // codex harness + claude provider: the worker cannot share the approver's model at all.
    const resolved = resolveModels({ model: 'gpt-5-mini' }, { llmProvider: 'claude' });
    const notice = approverSwapNotice(resolved, 'codex', 'claude');

    expect(notice).toContain('DIFFERENT vendor family');
    expect(notice).not.toContain('INDEPENDENCE UNVERIFIED');
  });

  it('is silent when the independence default never fired', () => {
    expect(approverSwapNotice(resolveModels({}), 'claude', 'claude')).toBeUndefined();
    expect(
      approverSwapNotice(
        resolveModels({ model: 'm', approverModel: 'other' }, { llmProvider: 'claude' }),
        'claude',
        'claude',
      ),
    ).toBeUndefined();
  });
});
