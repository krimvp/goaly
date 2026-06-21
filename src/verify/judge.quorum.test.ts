import { describe, it, expect } from 'vitest';
import { JudgeVerifier } from './judge';
import { FakeLlm } from '../llm/provider';
import { FakeWorkspace } from '../testing/fakes';

const sample = (pass: boolean, confidence: number, failing: string[] = []): string =>
  JSON.stringify({ pass, confidence, failing_criteria: failing });

const ws = () => new FakeWorkspace('0000000', 'a diff');

describe('JudgeVerifier — quorum boundaries', () => {
  it('fails closed on an even-quorum 1-pass / 1-fail tie (no strict majority)', async () => {
    const llm = new FakeLlm([sample(true, 0.9), sample(false, 0.9, ['missing case'])]);
    const judge = new JudgeVerifier({ rubric: 'r', quorum: 2, confidenceFloor: 0.5, llm });
    const verdict = await judge.verify(ws(), 'goal', 'r');
    expect(verdict.pass).toBe(false);
  });

  it('passes on a 2-of-3 majority above the confidence floor', async () => {
    const llm = new FakeLlm([sample(true, 0.9), sample(true, 0.8), sample(false, 0.9, ['x'])]);
    const judge = new JudgeVerifier({ rubric: 'r', quorum: 3, confidenceFloor: 0.5, llm });
    const verdict = await judge.verify(ws(), 'goal', 'r');
    expect(verdict.pass).toBe(true);
  });

  it('fails when the majority passes but average confidence is below the floor', async () => {
    const llm = new FakeLlm([sample(true, 0.4), sample(true, 0.3), sample(true, 0.2)]);
    const judge = new JudgeVerifier({ rubric: 'r', quorum: 3, confidenceFloor: 0.66, llm });
    const verdict = await judge.verify(ws(), 'goal', 'r');
    expect(verdict.pass).toBe(false);
  });

  it('fails closed when no sample is parseable', async () => {
    const llm = new FakeLlm(['not json at all', 'still not json']);
    const judge = new JudgeVerifier({ rubric: 'r', quorum: 2, confidenceFloor: 0.5, llm });
    const verdict = await judge.verify(ws(), 'goal', 'r');
    expect(verdict.pass).toBe(false);
  });
});
