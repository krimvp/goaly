import { describe, it, expect } from 'vitest';
import { JudgeOutput, ApprovalVerdict, Verdict, SealDecision, isUnevaluable } from './verdict';

describe('Verdict', () => {
  it('rejects confidence outside [0,1]', () => {
    expect(() => Verdict.parse({ pass: true, confidence: 1.5, detail: '' })).toThrow();
  });

  it('accepts an optional evaluable flag and defaults it to absent', () => {
    expect(Verdict.parse({ pass: false, confidence: 1, detail: 'x' }).evaluable).toBeUndefined();
    expect(Verdict.parse({ pass: false, confidence: 1, detail: 'x', evaluable: false }).evaluable).toBe(
      false,
    );
  });
});

describe('isUnevaluable', () => {
  it('is true only for an explicit could-not-evaluate red', () => {
    expect(isUnevaluable({ pass: false, confidence: 1, detail: 'x', evaluable: false })).toBe(true);
  });

  it('is false for a normal red (evaluable omitted ⇒ evaluated-and-failed)', () => {
    expect(isUnevaluable({ pass: false, confidence: 1, detail: 'x' })).toBe(false);
  });

  it('is never true for a passing verdict, even if evaluable were false', () => {
    expect(isUnevaluable({ pass: true, confidence: 1, detail: 'x', evaluable: false })).toBe(false);
  });
});

describe('JudgeOutput', () => {
  it('accepts a passing sample with no failing criteria', () => {
    expect(() => JudgeOutput.parse({ pass: true, confidence: 0.9, failing_criteria: [] })).not.toThrow();
  });

  it('accepts a failing sample with at least one failing criterion', () => {
    expect(() =>
      JudgeOutput.parse({ pass: false, confidence: 0.8, failing_criteria: ['missing edge case'] }),
    ).not.toThrow();
  });

  it('rejects an inconsistent sample (pass but with failing criteria)', () => {
    expect(() =>
      JudgeOutput.parse({ pass: true, confidence: 0.9, failing_criteria: ['x'] }),
    ).toThrow();
  });

  it('rejects an inconsistent sample (fail but no failing criteria)', () => {
    expect(() =>
      JudgeOutput.parse({ pass: false, confidence: 0.9, failing_criteria: [] }),
    ).toThrow();
  });
});

describe('ApprovalVerdict', () => {
  it('accepts a non-veto with no reason', () => {
    expect(() => ApprovalVerdict.parse({ veto: false })).not.toThrow();
  });

  it('accepts a veto with a reason', () => {
    expect(() => ApprovalVerdict.parse({ veto: true, reason: 'empty test' })).not.toThrow();
  });

  it('rejects a veto without a reason (feedback is mandatory)', () => {
    expect(() => ApprovalVerdict.parse({ veto: true })).toThrow();
    expect(() => ApprovalVerdict.parse({ veto: true, reason: '' })).toThrow();
  });
});

describe('SealDecision', () => {
  it('parses each of the three outcomes', () => {
    expect(() => SealDecision.parse({ kind: 'approve' })).not.toThrow();
    expect(() => SealDecision.parse({ kind: 'reject', reason: 'bad bar' })).not.toThrow();
    expect(() => SealDecision.parse({ kind: 'revise', feedback: 'be stricter' })).not.toThrow();
  });

  it('requires a non-empty reason on reject and feedback on revise', () => {
    expect(() => SealDecision.parse({ kind: 'reject' })).toThrow();
    expect(() => SealDecision.parse({ kind: 'reject', reason: '' })).toThrow();
    expect(() => SealDecision.parse({ kind: 'revise' })).toThrow();
    expect(() => SealDecision.parse({ kind: 'revise', feedback: '' })).toThrow();
  });

  it('rejects the legacy flat {approved} shape (breaking change is intentional)', () => {
    expect(() => SealDecision.parse({ approved: true })).toThrow();
  });
});
