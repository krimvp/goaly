import { describe, it, expect } from 'vitest';
import { LlmObserver } from './observer';
import { FakeLlm, type LlmProvider, type LlmRequest } from '../llm/provider';
import type { OrchestratorEvent, RunOutcome } from '../domain/events';
import { asRunId } from '../domain/ids';
import { makeFakeContract, passVerdict, failVerdict, veto, approve } from '../testing/fakes';

/** Collect everything the observer writes. */
function recordingWriter(): { lines: string[]; write: (s: string) => void } {
  const lines: string[] = [];
  return { lines, write: (s) => lines.push(s) };
}

const contractEvent = (): OrchestratorEvent => ({
  tag: 'CONTRACT_COMPILED',
  contract: makeFakeContract({ goal: 'add a /health endpoint', rubric: 'returns 200 OK' }),
});

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  status: 'DONE',
  iterations: 3,
  contractHash: null,
  runId: asRunId('run-x'),
  ...over,
});

describe('LlmObserver', () => {
  it('narrates the frozen contract at the CONTRACT_COMPILED checkpoint', async () => {
    const llm = new FakeLlm(['This run is done when the /health endpoint returns 200.']);
    const out = recordingWriter();
    const obs = new LlmObserver({ llm, write: out.write });

    await obs.onEvent(contractEvent());

    // It prompted the read-only provider with the contract's goal + ladder, and wrote the summary.
    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]!.prompt).toContain('add a /health endpoint');
    expect(llm.requests[0]!.prompt).toContain('deterministic command');
    expect(out.lines).toEqual(['[explain] This run is done when the /health endpoint returns 200.\n']);
  });

  it('labels each verifier-ladder run with an incrementing iteration and the pass/fail result', async () => {
    const llm = new FakeLlm(['fail summary', 'pass summary']);
    const out = recordingWriter();
    const obs = new LlmObserver({ llm, write: out.write });

    await obs.onEvent({ tag: 'VERIFIED', verdict: failVerdict('rung 2 red: 1 test failing') });
    await obs.onEvent({ tag: 'VERIFIED', verdict: passVerdict() });

    expect(llm.requests[0]!.prompt).toContain("Iteration 1's verifier ladder just FAILED");
    expect(llm.requests[0]!.prompt).toContain('rung 2 red: 1 test failing');
    expect(llm.requests[1]!.prompt).toContain("Iteration 2's verifier ladder just PASSED");
    expect(out.lines).toEqual(['[explain] fail summary\n', '[explain] pass summary\n']);
  });

  it('explains the approver Sign-off, surfacing a veto reason', async () => {
    const llm = new FakeLlm(['the approver stopped this green']);
    const out = recordingWriter();
    const obs = new LlmObserver({ llm, write: out.write });

    await obs.onEvent({ tag: 'SIGNOFF_DECIDED', approval: veto('the public API changed without a changelog') });

    expect(llm.requests[0]!.prompt).toContain('VETOED');
    expect(llm.requests[0]!.prompt).toContain('the public API changed without a changelog');
    expect(out.lines).toEqual(['[explain] the approver stopped this green\n']);
  });

  it('narrates a stuck terminal outcome and flags it as a stuck stop', async () => {
    const llm = new FakeLlm(['the loop oscillated between two diffs']);
    const out = recordingWriter();
    const obs = new LlmObserver({ llm, write: out.write });

    await obs.onOutcome(
      outcome({ status: 'ABORTED', reason: 'oscillation (STUCK_OSCILLATION): flip-flopping diffs' }),
    );

    expect(llm.requests[0]!.prompt).toContain('status ABORTED');
    expect(llm.requests[0]!.prompt).toContain('"stuck" stop');
    expect(out.lines).toEqual(['[explain] the loop oscillated between two diffs\n']);
  });

  it('stays silent (no LLM call, no output) on events that are not checkpoints', async () => {
    const llm = new FakeLlm(['should never be used']);
    const out = recordingWriter();
    const obs = new LlmObserver({ llm, write: out.write });

    await obs.onEvent({ tag: 'SEAL_DECIDED', decision: { kind: 'approve' } });

    expect(llm.requests).toHaveLength(0);
    expect(out.lines).toEqual([]);
  });

  it('fail-closed: a provider error degrades to no summary and never throws', async () => {
    const throwing: LlmProvider = {
      name: 'boom',
      async complete(_req: LlmRequest) {
        throw new Error('provider exploded');
      },
    };
    const out = recordingWriter();
    const obs = new LlmObserver({ llm: throwing, write: out.write });

    await expect(obs.onEvent(contractEvent())).resolves.toBeUndefined();
    expect(out.lines).toEqual([]);
  });

  it('fail-closed: a throwing writer never crashes the observer', async () => {
    const llm = new FakeLlm(['a summary']);
    const obs = new LlmObserver({
      llm,
      write: () => {
        throw new Error('stderr exploded');
      },
    });

    await expect(obs.onOutcome(outcome())).resolves.toBeUndefined();
  });

  it('writes nothing when the provider returns an empty/whitespace completion', async () => {
    const llm = new FakeLlm(['   \n  ']);
    const out = recordingWriter();
    const obs = new LlmObserver({ llm, write: out.write });

    await obs.onOutcome(outcome());

    expect(out.lines).toEqual([]);
  });

  it('clips a runaway completion so it can never flood the terminal', async () => {
    const llm = new FakeLlm(['x'.repeat(5000)]);
    const out = recordingWriter();
    const obs = new LlmObserver({ llm, write: out.write });

    await obs.onOutcome(outcome());

    expect(out.lines).toHaveLength(1);
    // `[explain] ` prefix + up to 800 chars (last char an ellipsis) + newline.
    expect(out.lines[0]!.length).toBeLessThanOrEqual('[explain] '.length + 800 + 1);
    expect(out.lines[0]).toContain('…');
  });
});
