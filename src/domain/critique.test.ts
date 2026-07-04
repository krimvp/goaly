import { describe, it, expect } from 'vitest';
import {
  CritiqueOutput,
  RefuterVote,
  criticalFindings,
  renderCritiqueFeedback,
} from './critique';

describe('CritiqueOutput schema', () => {
  it('accepts a pass with no findings', () => {
    const parsed = CritiqueOutput.parse({ verdict: 'pass' });
    expect(parsed.findings).toEqual([]);
  });

  it('accepts a revise carrying findings', () => {
    const parsed = CritiqueOutput.parse({
      verdict: 'revise',
      findings: [{ severity: 'critical', claim: 'the command is vacuous' }],
    });
    expect(parsed.findings).toHaveLength(1);
  });

  it('rejects a revise with zero findings (coherence refine)', () => {
    const result = CritiqueOutput.safeParse({ verdict: 'revise', findings: [] });
    expect(result.success).toBe(false);
  });

  it('rejects a finding with an empty claim', () => {
    const result = CritiqueOutput.safeParse({
      verdict: 'revise',
      findings: [{ severity: 'critical', claim: '' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('RefuterVote schema', () => {
  it('accepts a not-refuted vote without a reason', () => {
    expect(RefuterVote.parse({ refuted: false, confidence: 0.8 }).refuted).toBe(false);
  });

  it('accepts a refutation with a reason', () => {
    const vote = RefuterVote.parse({ refuted: true, confidence: 0.9, reason: 'hard-coded output' });
    expect(vote.reason).toBe('hard-coded output');
  });

  it('rejects a refutation without a reason (coherence refine)', () => {
    expect(RefuterVote.safeParse({ refuted: true, confidence: 0.9 }).success).toBe(false);
    expect(RefuterVote.safeParse({ refuted: true, confidence: 0.9, reason: '' }).success).toBe(false);
  });

  it('rejects confidence outside [0,1]', () => {
    expect(RefuterVote.safeParse({ refuted: false, confidence: 1.2 }).success).toBe(false);
  });
});

describe('criticalFindings', () => {
  it('collects only critical findings, deduped by claim, in stable order', () => {
    const outputs: CritiqueOutput[] = [
      {
        verdict: 'revise',
        findings: [
          { severity: 'critical', claim: 'A' },
          { severity: 'minor', claim: 'B' },
        ],
      },
      {
        verdict: 'revise',
        findings: [
          { severity: 'critical', claim: 'A' },
          { severity: 'critical', claim: 'C' },
        ],
      },
      { verdict: 'pass', findings: [] },
    ];
    expect(criticalFindings(outputs).map((f) => f.claim)).toEqual(['A', 'C']);
  });
});

describe('renderCritiqueFeedback', () => {
  it('renders deterministically with lens and fix', () => {
    const text = renderCritiqueFeedback([
      { severity: 'critical', lens: 'GAMING', claim: 'command always exits 0', fix: 'assert output' },
      { severity: 'critical', claim: 'rubric never mentions the goal' },
    ]);
    expect(text).toBe(
      [
        'Adversarial review found 2 critical issues with the previous attempt:',
        '1. [GAMING] command always exits 0 Fix: assert output',
        '2. rubric never mentions the goal',
      ].join('\n'),
    );
  });

  it('uses singular phrasing for one finding', () => {
    const text = renderCritiqueFeedback([{ severity: 'critical', claim: 'X' }]);
    expect(text).toContain('1 critical issue with');
  });
});
