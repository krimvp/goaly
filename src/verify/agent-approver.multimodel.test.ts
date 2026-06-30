import { describe, it, expect } from 'vitest';
import { AgentApprover } from './agent-approver';
import { FakeLlm } from '../llm/provider';
import type { LlmProvider, LlmRequest, LlmCompletion } from '../llm/provider';
import type { ApprovalInput } from '../domain/events';
import { passVerdict } from '../testing/fakes';

const baseInput: ApprovalInput = {
  goal: 'add a working widget',
  rubric: 'the widget must render and have tests',
  diff: 'diff --git a/widget.ts b/widget.ts',
  verdicts: [passVerdict('all green')],
};

const noVeto = '{"veto": false}';
const veto = (reason: string): string => JSON.stringify({ veto: true, reason });

/** A distinctly-named provider so a test can assert WHICH provider a reviewer called. */
class NamedFake implements LlmProvider {
  readonly requests: LlmRequest[] = [];
  readonly #inner: FakeLlm;
  constructor(
    readonly name: string,
    responses: (string | LlmCompletion)[],
  ) {
    this.#inner = new FakeLlm(responses);
  }
  async complete(req: LlmRequest): Promise<LlmCompletion> {
    this.requests.push(req);
    return this.#inner.complete(req);
  }
}

/** A provider that always throws on `complete` (the per-reviewer fail-closed path). */
class ThrowingProvider implements LlmProvider {
  readonly name: string;
  callCount = 0;
  constructor(name: string) {
    this.name = name;
  }
  async complete(): Promise<LlmCompletion> {
    this.callCount += 1;
    throw new Error('provider exploded');
  }
}

describe('AgentApprover — per-reviewer model independence (reviewers list)', () => {
  it('a panel of 3 distinct providers calls each provider exactly once', async () => {
    const a = new NamedFake('model-a', [noVeto]);
    const b = new NamedFake('model-b', [noVeto]);
    const c = new NamedFake('model-c', [noVeto]);
    // quorum defaults to reviewers.length when unset.
    const approver = new AgentApprover({ llm: a, reviewers: [a, b, c] });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(false);
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
    expect(c.requests).toHaveLength(1);
  });

  it('defaults quorum to the reviewer count when no quorum is given', async () => {
    const a = new NamedFake('model-a', [noVeto]);
    const b = new NamedFake('model-b', [noVeto]);
    const approver = new AgentApprover({ llm: a, reviewers: [a, b] });

    await approver.review(baseInput);

    // Two reviewers ⇒ two calls (one per distinct provider), not one and not three.
    expect(a.requests).toHaveLength(1);
    expect(b.requests).toHaveLength(1);
  });

  it('cycles the providers when quorum exceeds the model count', async () => {
    const a = new NamedFake('model-a', [noVeto, noVeto]);
    const b = new NamedFake('model-b', [noVeto]);
    // quorum 4, two models: reviewer 0→a, 1→b, 2→a, 3→b.
    const approver = new AgentApprover({ llm: a, reviewers: [a, b], quorum: 4 });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(false);
    expect(a.requests).toHaveLength(2);
    expect(b.requests).toHaveLength(2);
  });

  it('pairs reviewer i with lens i % lenses.length, same as the single-model panel', async () => {
    const a = new NamedFake('model-a', [noVeto, noVeto]);
    const b = new NamedFake('model-b', [noVeto]);
    const approver = new AgentApprover({
      llm: a,
      reviewers: [a, b],
      quorum: 3,
      lenses: ['LENS_ALPHA', 'LENS_BETA'],
    });

    await approver.review(baseInput);

    // reviewer 0 → provider a, lens ALPHA; reviewer 1 → provider b, lens BETA; reviewer 2 → a, ALPHA.
    expect(a.requests[0]?.system).toContain('LENS_ALPHA');
    expect(b.requests[0]?.system).toContain('LENS_BETA');
    expect(a.requests[1]?.system).toContain('LENS_ALPHA');
  });

  it('a reviewer whose provider throws becomes a VETO vote (fail-closed)', async () => {
    const a = new NamedFake('model-a', [noVeto]);
    const boom = new ThrowingProvider('model-boom');
    const c = new NamedFake('model-c', [noVeto]);
    // 2 no-veto, 1 throw(=veto): 2*2 > 3 → green; the throw is contained, not propagated.
    const approver = new AgentApprover({ llm: a, reviewers: [a, boom, c] });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(false);
    expect(boom.callCount).toBe(1);
  });

  it('a throwing reviewer flips a borderline panel to veto', async () => {
    const a = new NamedFake('model-a', [noVeto]);
    const boom1 = new ThrowingProvider('boom-1');
    const boom2 = new ThrowingProvider('boom-2');
    // 1 no-veto, 2 throw(=veto): 1*2 > 3 is false → veto.
    const approver = new AgentApprover({ llm: a, reviewers: [a, boom1, boom2] });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(true);
    expect(verdict.reason).toBeDefined();
    expect(verdict.reason?.length ?? 0).toBeGreaterThan(0);
  });

  it('an explicit veto from one model is no strict majority → veto (never weaker)', async () => {
    const a = new NamedFake('model-a', [noVeto]);
    const b = new NamedFake('model-b', [veto('tests are tautological')]);
    const approver = new AgentApprover({ llm: a, reviewers: [a, b] });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(true);
    expect(verdict.reason).toContain('tests are tautological');
  });

  it('an empty reviewers list falls back to the single-llm path (back-compat)', async () => {
    const llm = new FakeLlm([noVeto]);
    const approver = new AgentApprover({ llm, reviewers: [] });

    await approver.review(baseInput);

    // No reviewers ⇒ the single-llm quorum-1 single call, byte-for-byte.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.temperature).toBe(0);
    expect(llm.requests[0]?.system).not.toContain('REVIEW LENS');
  });

  it('absent reviewers is byte-for-byte the single-llm path', async () => {
    const llm = new FakeLlm([noVeto]);
    const approver = new AgentApprover({ llm });

    await approver.review(baseInput);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.temperature).toBe(0);
  });

  it('the per-reviewer panel samples at the diversity temperature (not 0)', async () => {
    const a = new NamedFake('model-a', [noVeto]);
    const b = new NamedFake('model-b', [noVeto]);
    const approver = new AgentApprover({ llm: a, reviewers: [a, b], diversityTemperature: 0.4 });

    await approver.review(baseInput);

    expect(a.requests[0]?.temperature).toBe(0.4);
    expect(b.requests[0]?.temperature).toBe(0.4);
  });

  it('a single reviewer still runs as a real panel (not the byte-for-byte single call)', async () => {
    // One reviewer, quorum defaults to 1 — but because `reviewers` is present it's the per-reviewer
    // path: it weaves a lens and samples at the diversity temperature.
    const only = new NamedFake('only', [noVeto]);
    const approver = new AgentApprover({ llm: only, reviewers: [only], diversityTemperature: 0.5 });

    await approver.review(baseInput);

    expect(only.requests).toHaveLength(1);
    expect(only.requests[0]?.temperature).toBe(0.5);
    expect(only.requests[0]?.system).toContain('REVIEW LENS');
  });
});
