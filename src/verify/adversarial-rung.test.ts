import { describe, it, expect } from 'vitest';
import { AdversarialReviewRung, REFUTER_LENSES } from './adversarial-rung';
import { FakeLlm, type LlmProvider, type LlmRequest, type LlmCompletion } from '../llm/provider';
import { FakeWorkspace } from '../testing/fakes';

const ws = new FakeWorkspace('abc1234', 'diff --git a/x b/x\n+added line');

const notRefuted = (confidence: number): string =>
  JSON.stringify({ refuted: false, confidence });
const refuted = (confidence: number, reason: string): string =>
  JSON.stringify({ refuted: true, confidence, reason });

describe('AdversarialReviewRung', () => {
  it('passes the green through on a strict supermajority of could-not-refute votes', async () => {
    const llm = new FakeLlm([notRefuted(0.9), notRefuted(0.8), refuted(0.7, 'suspicious stub')]);
    const rung = new AdversarialReviewRung({ llm, refuters: 3 });

    const verdict = await rung.verify(ws, 'goal', 'rubric');

    expect(verdict.pass).toBe(true);
    expect(verdict.confidence).toBeCloseTo(0.85);
  });

  it('fails the green with deduped reasons when the refuters win', async () => {
    const llm = new FakeLlm([
      refuted(0.9, 'hard-coded output'),
      refuted(0.8, 'hard-coded output'),
      notRefuted(0.5),
    ]);
    const rung = new AdversarialReviewRung({ llm, refuters: 3 });

    const verdict = await rung.verify(ws, 'goal', 'rubric');

    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain('adversarial review refuted the green');
    expect(verdict.detail).toContain('hard-coded output');
    expect(verdict.detail.match(/hard-coded output/g)).toHaveLength(1); // deduped
    expect(verdict.evaluable).not.toBe(false); // it DID evaluate — a genuine red, not an env failure
  });

  it('a tie is a red — the green needs a STRICT supermajority', async () => {
    const llm = new FakeLlm([notRefuted(0.9), refuted(0.9, 'partial implementation')]);
    const rung = new AdversarialReviewRung({ llm, refuters: 2 });

    const verdict = await rung.verify(ws, 'goal', 'rubric');

    expect(verdict.pass).toBe(false);
  });

  it('counts an unparseable refuter as a refuted vote (fail-closed, never weaker than the bar)', async () => {
    // 3 refuters: one clean not-refuted, two garbage. notRefuted(1) * 2 <= 3 ⇒ red.
    const llm = new FakeLlm([notRefuted(0.9), 'no json at all', '{"refuted": true}']); // missing reason ⇒ schema miss
    const rung = new AdversarialReviewRung({ llm, refuters: 3 });

    const verdict = await rung.verify(ws, 'goal', 'rubric');

    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain('2 refuter(s) failed to produce a valid vote');
  });

  it('a thrown refuter call counts as refuted but never discards the sibling votes', async () => {
    class ThrowSecond implements LlmProvider {
      readonly name = 'throw-second';
      #i = 0;
      async complete(_req: LlmRequest): Promise<LlmCompletion> {
        this.#i += 1;
        if (this.#i === 2) throw new Error('refuter down');
        return { text: notRefuted(0.9) };
      }
    }
    // refuters=3: two not-refuted + one throw ⇒ 2*2 > 3 ⇒ the green still stands.
    const rung = new AdversarialReviewRung({ llm: new ThrowSecond(), refuters: 3 });

    const verdict = await rung.verify(ws, 'goal', 'rubric');

    expect(verdict.pass).toBe(true);
  });

  it('zero parseable refuters is a fail-closed UNEVALUABLE red (the judge zero-samples path)', async () => {
    const llm = new FakeLlm(['garbage']);
    const rung = new AdversarialReviewRung({ llm, refuters: 3 });

    const verdict = await rung.verify(ws, 'goal', 'rubric');

    expect(verdict.pass).toBe(false);
    expect(verdict.evaluable).toBe(false);
    expect(verdict.confidence).toBe(0);
  });

  it('never returns pass on a partial parse that lacks the supermajority', async () => {
    // 5 refuters: 2 parsed not-refuted, 3 garbage ⇒ 2*2 <= 5 ⇒ red.
    const llm = new FakeLlm([notRefuted(0.9), notRefuted(0.9), 'x', 'x', 'x']);
    const rung = new AdversarialReviewRung({ llm, refuters: 5 });

    const verdict = await rung.verify(ws, 'goal', 'rubric');

    expect(verdict.pass).toBe(false);
  });

  it('cycles the refuter lenses, fences the diff, and frames refute-first', async () => {
    // A refutation first keeps the outcome mathematically open through all three votes.
    const llm = new FakeLlm([refuted(0.6, 'keep the panel open'), notRefuted(0.9), notRefuted(0.9)]);
    const rung = new AdversarialReviewRung({ llm, refuters: 3 });

    await rung.verify(ws, 'the goal text', 'the rubric text');

    expect(llm.requests).toHaveLength(3);
    // Lenses cycle on the PROMPT TAIL; the system stays panel-constant so refuters 2..3 cache-read
    // the fenced-diff prefix refuter 1 wrote.
    expect(llm.requests[0]?.prompt).toContain(REFUTER_LENSES[0]);
    expect(llm.requests[1]?.prompt).toContain(REFUTER_LENSES[1]);
    expect(llm.requests[2]?.prompt).toContain(REFUTER_LENSES[2]);
    expect(new Set(llm.requests.map((r) => r.system)).size).toBe(1);
    const shared = (llm.requests[0]?.prompt ?? '').split('REVIEW LENS')[0]!;
    expect(shared.length).toBeGreaterThan(0);
    for (const req of llm.requests) {
      expect(req.prompt.startsWith(shared)).toBe(true);
      expect(req.system).toContain('REFUTE');
      expect(req.prompt).toContain('<<UNTRUSTED DIFF');
      expect(req.prompt).toContain('the goal text');
      expect(req.prompt).toContain('the rubric text');
    }
  });

  it('early-exits a settled green: two not-refuted of three end the panel in exactly 2 calls', async () => {
    const llm = new FakeLlm([notRefuted(0.9), notRefuted(0.7), refuted(0.9, 'never consulted')]);
    const rung = new AdversarialReviewRung({ llm, refuters: 3 });

    const verdict = await rung.verify(ws, 'goal', 'rubric');

    // 2*2 > 3 — the third refuter cannot change the aggregate, so it is never called; the
    // confidence averages the votes actually cast.
    expect(verdict.pass).toBe(true);
    expect(verdict.confidence).toBeCloseTo(0.8);
    expect(llm.requests).toHaveLength(2);
  });

  it('early-exits a settled red: two refutations of three end the panel in exactly 2 calls', async () => {
    const llm = new FakeLlm([
      refuted(0.9, 'hard-coded output'),
      refuted(0.8, 'stubbed engine'),
      notRefuted(0.9),
    ]);
    const rung = new AdversarialReviewRung({ llm, refuters: 3 });

    const verdict = await rung.verify(ws, 'goal', 'rubric');

    // notRefuted can reach at most 1 of 3 — red is settled after two refutations.
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain('hard-coded output');
    expect(verdict.detail).toContain('stubbed engine');
    expect(llm.requests).toHaveLength(2);
  });

  it('samples at temperature 0 for one refuter and the diversity temperature for a panel', async () => {
    const single = new FakeLlm([notRefuted(0.9)]);
    await new AdversarialReviewRung({ llm: single, refuters: 1 }).verify(ws, 'g', 'r');
    expect(single.requests[0]?.temperature).toBe(0);

    const panel = new FakeLlm([notRefuted(0.9)]);
    await new AdversarialReviewRung({ llm: panel, refuters: 3 }).verify(ws, 'g', 'r');
    expect(panel.requests[0]?.temperature).toBe(0.5);
  });
});
