import { describe, it, expect } from 'vitest';
import { classifyPreflightSoundness } from './preflight-soundness';
import { makeFakeContract } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';

const contract = makeFakeContract({
  goal: 'compute pi five ways',
  generatedFiles: [{ path: 'test_pi.py', sha256: 'a'.repeat(64) }],
});

describe('classifyPreflightSoundness', () => {
  it('returns broken=true when the model says the verification cannot run', async () => {
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: true, reason: 'SyntaxError in test_pi.py' })]);
    const v = await classifyPreflightSoundness({ llm }, contract, 'E SyntaxError: invalid syntax', false);
    expect(v.broken).toBe(true);
    expect(v.reason).toContain('SyntaxError');
  });

  it('returns broken=false when the model says the implementation is just missing', async () => {
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: false, reason: 'pi_1.py not created yet' })]);
    const v = await classifyPreflightSoundness({ llm }, contract, 'E Failed: pi_1.py not found', false);
    expect(v.broken).toBe(false);
  });

  it('tolerates prose/fences around the JSON (extractJson)', async () => {
    const llm = new FakeLlm(['Here is my verdict:\n```json\n{"brokenVerification": true, "reason": "x"}\n```\nDone.']);
    const v = await classifyPreflightSoundness({ llm }, contract, 'boom', false);
    expect(v.broken).toBe(true);
  });

  it('fails OPEN (broken=false) on an unparseable response', async () => {
    const v = await classifyPreflightSoundness({ llm: new FakeLlm(['no json here']) }, contract, 'boom', false);
    expect(v.broken).toBe(false);
  });

  it('fails OPEN (broken=false) when the LLM call throws', async () => {
    const llm = new (class extends FakeLlm {
      constructor() {
        super(['unused']);
      }
      override async complete(): ReturnType<FakeLlm['complete']> {
        throw new Error('network down');
      }
    })();
    const v = await classifyPreflightSoundness({ llm }, contract, 'boom', false);
    expect(v.broken).toBe(false);
    expect(v.reason).toContain('network down');
  });

  it('passes the goal, authored files, and failure output to the model', async () => {
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: false })]);
    await classifyPreflightSoundness({ llm }, contract, 'UNIQUE_FAILURE_MARKER', false);
    const req = llm.requests[0];
    expect(req?.prompt).toContain('compute pi five ways');
    expect(req?.prompt).toContain('test_pi.py');
    expect(req?.prompt).toContain('UNIQUE_FAILURE_MARKER');
    expect(req?.temperature).toBe(0);
  });

  // Fix B2: a missing dependency manifest/module the IMPLEMENTATION is expected to create (go.mod,
  // package.json, …) is agent-fixable — broken=false. A defect INSIDE the frozen authored test is
  // broken=true. The classifier is LLM-driven, so the refinement lives in the system prompt: assert
  // the prompt encodes both clauses, plus the round-trip on representative details.
  it('a "missing go.mod / package not in std" red classifies as an honest red (broken=false)', async () => {
    const detail = 'no required module provides package example.com/mine; go.mod file not found';
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: false, reason: 'go.mod not created yet' })]);
    const v = await classifyPreflightSoundness({ llm }, contract, detail, false);
    expect(v.broken).toBe(false);
  });

  it('a real syntax/import error INSIDE the authored test classifies as broken (broken=true)', async () => {
    const detail = 'test_pi.py:1: in <module>\n    import nonexistent_helper\nE   ImportError';
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: true, reason: 'ImportError in the frozen test' })]);
    const v = await classifyPreflightSoundness({ llm }, contract, detail, false);
    expect(v.broken).toBe(true);
  });

  it('the system prompt instructs that a missing dependency manifest is NOT a broken verifier (B2)', async () => {
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: false })]);
    await classifyPreflightSoundness({ llm }, contract, 'boom', false);
    const system = llm.requests[0]?.system ?? '';
    // The carve-out (agent-fixable scaffolding) and an example manifest are spelled out…
    expect(system).toContain('go.mod');
    expect(system).toMatch(/manifest/i);
    // …and the broken=true case is reserved for a defect inside the frozen verification files.
    expect(system).toMatch(/FROZEN VERIFICATION FILES/i);
  });

  // Issue #78: a from-scratch tree is no longer short-circuited upstream — the rung is run and the
  // classifier is consulted with an `emptyOfSource` signal threaded into the prompt to bias toward
  // "honest red." It must still be able to return broken=true for a defect inside the frozen files.
  it('on a from-scratch tree, injects the empty-of-source context into the prompt', async () => {
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: false })]);
    await classifyPreflightSoundness({ llm }, contract, 'boom', true);
    expect(llm.requests[0]?.prompt).toMatch(/EMPTY OF IMPLEMENTATION SOURCE/i);
  });

  it('on an existing tree, does NOT inject the empty-of-source context', async () => {
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: false })]);
    await classifyPreflightSoundness({ llm }, contract, 'boom', false);
    expect(llm.requests[0]?.prompt).not.toMatch(/EMPTY OF IMPLEMENTATION SOURCE/i);
  });

  it('a from-scratch tree can still be judged broken when the defect is inside the frozen files', async () => {
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: true, reason: 'syntax error in test_pi.py' })]);
    const v = await classifyPreflightSoundness({ llm }, contract, 'SyntaxError: ( unexpected', true);
    expect(v.broken).toBe(true);
  });
});
