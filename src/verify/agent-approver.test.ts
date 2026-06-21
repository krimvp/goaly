import { describe, it, expect } from 'vitest';
import { AgentApprover } from './agent-approver';
import { FakeLlm } from '../llm/provider';
import { ApprovalVerdict } from '../domain/verdict';
import type { ApprovalInput } from '../domain/events';
import { passVerdict, failVerdict } from '../testing/fakes';

const baseInput: ApprovalInput = {
  goal: 'add a working widget',
  rubric: 'the widget must render and have tests',
  diff: 'diff --git a/widget.ts b/widget.ts',
  verdicts: [passVerdict('all green')],
};

describe('AgentApprover', () => {
  it('does not veto on a clean {veto:false}', async () => {
    const llm = new FakeLlm(['{"veto": false}']);
    const approver = new AgentApprover({ llm });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(false);
    expect(ApprovalVerdict.safeParse(verdict).success).toBe(true);
  });

  it('vetoes with the model reason on {veto:true, reason}', async () => {
    const llm = new FakeLlm(['{"veto": true, "reason": "tests are empty tautologies"}']);
    const approver = new AgentApprover({ llm });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(true);
    expect(verdict.reason).toBe('tests are empty tautologies');
    expect(ApprovalVerdict.safeParse(verdict).success).toBe(true);
  });

  it('fail-closes to a veto when the response is garbage', async () => {
    const llm = new FakeLlm(['not json at all, just rambling text']);
    const approver = new AgentApprover({ llm });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(true);
    expect(verdict.reason).toBeDefined();
    expect(verdict.reason?.length ?? 0).toBeGreaterThan(0);
    expect(verdict.reason).toContain('could not produce a valid verdict');
  });

  it('coerces {veto:true} with no reason into a veto with a non-empty reason', async () => {
    const llm = new FakeLlm(['{"veto": true}']);
    const approver = new AgentApprover({ llm });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(true);
    expect(verdict.reason).toBeDefined();
    expect(verdict.reason?.length ?? 0).toBeGreaterThan(0);
    expect(ApprovalVerdict.safeParse(verdict).success).toBe(true);
  });

  it('coerces {veto:true, reason:""} (empty reason) into a veto with a non-empty reason', async () => {
    const llm = new FakeLlm(['{"veto": true, "reason": ""}']);
    const approver = new AgentApprover({ llm });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(true);
    expect(verdict.reason?.length ?? 0).toBeGreaterThan(0);
    expect(ApprovalVerdict.safeParse(verdict).success).toBe(true);
  });

  it('tolerates code fences and surrounding prose around the JSON', async () => {
    const llm = new FakeLlm([
      'Here is my verdict:\n```json\n{"veto": true, "reason": "partial solution"}\n```\nThanks.',
    ]);
    const approver = new AgentApprover({ llm });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(true);
    expect(verdict.reason).toBe('partial solution');
  });

  it('tolerates braces inside string values when extracting JSON', async () => {
    const llm = new FakeLlm(['{"veto": true, "reason": "missing close brace } in output"}']);
    const approver = new AgentApprover({ llm });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(true);
    expect(verdict.reason).toBe('missing close brace } in output');
  });

  it('fail-closes when the llm call throws', async () => {
    const llm = new FakeLlm([]);
    const approver = new AgentApprover({ llm });

    const verdict = await approver.review(baseInput);

    expect(verdict.veto).toBe(true);
    expect(verdict.reason).toContain('could not produce a valid verdict');
  });

  it('calls the llm once with temperature 0 and a system prompt', async () => {
    const llm = new FakeLlm(['{"veto": false}']);
    const approver = new AgentApprover({ llm });

    await approver.review(baseInput);

    expect(llm.requests).toHaveLength(1);
    const req = llm.requests[0];
    expect(req?.temperature).toBe(0);
    expect(req?.system).toBeDefined();
    expect(req?.system?.length ?? 0).toBeGreaterThan(0);
  });

  it('includes goal, rubric, diff and verdict summary in the prompt', async () => {
    const llm = new FakeLlm(['{"veto": false}']);
    const approver = new AgentApprover({ llm });
    const input: ApprovalInput = {
      goal: 'UNIQUE_GOAL_TOKEN',
      rubric: 'UNIQUE_RUBRIC_TOKEN',
      diff: 'UNIQUE_DIFF_TOKEN',
      verdicts: [failVerdict('UNIQUE_VERDICT_DETAIL')],
    };

    await approver.review(input);

    const prompt = llm.requests[0]?.prompt ?? '';
    expect(prompt).toContain('UNIQUE_GOAL_TOKEN');
    expect(prompt).toContain('UNIQUE_RUBRIC_TOKEN');
    expect(prompt).toContain('UNIQUE_DIFF_TOKEN');
    expect(prompt).toContain('UNIQUE_VERDICT_DETAIL');
  });
});
