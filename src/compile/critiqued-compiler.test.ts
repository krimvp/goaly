import { describe, it, expect } from 'vitest';
import { CritiquedCompiler, CONTRACT_REDTEAM_LENSES } from './critiqued-compiler';
import { FakeCompiler, makeFakeContract } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import { RunConfig } from '../domain/config';

const generateConfig = RunConfig.parse({ goal: 'build the widget', verifier: { kind: 'generate' } });
const existingConfig = RunConfig.parse({
  goal: 'build the widget',
  verifier: { kind: 'existing', ref: 'npm test' },
});

const pass = JSON.stringify({ verdict: 'pass', findings: [] });
const critical = (claim: string, fix?: string): string =>
  JSON.stringify({
    verdict: 'revise',
    findings: [{ severity: 'critical', claim, ...(fix !== undefined ? { fix } : {}) }],
  });
const minorOnly = JSON.stringify({
  verdict: 'revise',
  findings: [{ severity: 'minor', claim: 'label could be clearer' }],
});

describe('CritiquedCompiler', () => {
  it('passes the contract through untouched (identical contractHash) when no critic finds a critical issue', async () => {
    const contract = makeFakeContract();
    const inner = new FakeCompiler(contract);
    const llm = new FakeLlm([pass, minorOnly]);
    const compiler = new CritiquedCompiler({ inner, llm, critics: 2, rounds: 1 });

    const result = await compiler.compile(generateConfig);

    expect(result.contractHash).toBe(contract.contractHash);
    expect(inner.feedbacks).toEqual([undefined]); // exactly one authoring attempt
    expect(llm.requests).toHaveLength(2); // the panel ran
  });

  it('re-compiles with the findings as feedback on a critical finding, bounded by rounds', async () => {
    const first = makeFakeContract({ rungs: [{ kind: 'deterministic', command: 'true' }] });
    const second = makeFakeContract({ rungs: [{ kind: 'deterministic', command: 'npm test' }] });
    const inner = new FakeCompiler([first, second]);
    // Round 1: both critics find the vacuous command; round 2 would need more responses (clamps to last).
    const llm = new FakeLlm([
      critical('the verify command is vacuous', 'run the real test suite'),
      critical('the verify command is vacuous', 'run the real test suite'),
      pass,
      pass,
    ]);
    const compiler = new CritiquedCompiler({ inner, llm, critics: 2, rounds: 2 });

    const result = await compiler.compile(generateConfig);

    expect(result.contractHash).toBe(second.contractHash);
    expect(inner.feedbacks).toHaveLength(2);
    expect(inner.feedbacks[1]).toContain('Adversarial review found 1 critical issue');
    expect(inner.feedbacks[1]).toContain('the verify command is vacuous');
    expect(inner.feedbacks[1]).toContain('run the real test suite');
    // Round 2 panel saw the re-authored contract and passed it: 2 + 2 critic calls total.
    expect(llm.requests).toHaveLength(4);
  });

  it('stops after `rounds` critique rounds and passes the last contract through (Seal still gates)', async () => {
    const contract = makeFakeContract();
    const inner = new FakeCompiler(contract);
    const llm = new FakeLlm([critical('still gameable')]); // clamps: every critic call finds it
    const compiler = new CritiquedCompiler({ inner, llm, critics: 1, rounds: 2 });

    const result = await compiler.compile(generateConfig);

    // 1 initial compile + 2 bounded re-authoring rounds; the last contract passes through.
    expect(inner.feedbacks).toHaveLength(3);
    expect(result.contractHash).toBe(contract.contractHash);
    expect(llm.requests).toHaveLength(2); // one critic per round, never a third round
  });

  it('composes the human Seal feedback with the panel findings on a revise round', async () => {
    const inner = new FakeCompiler(makeFakeContract());
    const llm = new FakeLlm([critical('rubric mismatch'), pass]);
    const compiler = new CritiquedCompiler({ inner, llm, critics: 1, rounds: 2 });

    await compiler.compile(generateConfig, 'please cover the CLI too');

    expect(inner.feedbacks[0]).toBe('please cover the CLI too');
    expect(inner.feedbacks[1]).toContain('please cover the CLI too');
    expect(inner.feedbacks[1]).toContain('rubric mismatch');
  });

  it('passes through when the whole panel errors or returns garbage (advisory fail-open)', async () => {
    const contract = makeFakeContract();
    const inner = new FakeCompiler(contract);
    const llm = new FakeLlm(['no json here']);
    const compiler = new CritiquedCompiler({ inner, llm, critics: 2, rounds: 1 });

    const result = await compiler.compile(generateConfig);

    expect(result.contractHash).toBe(contract.contractHash);
    expect(inner.feedbacks).toHaveLength(1); // never re-authored on a broken panel
  });

  it('skips the critique entirely for an existing (user-supplied) verifier', async () => {
    const contract = makeFakeContract();
    const inner = new FakeCompiler(contract);
    const llm = new FakeLlm([critical('should never be consulted')]);
    const compiler = new CritiquedCompiler({ inner, llm, critics: 2, rounds: 1 });

    const result = await compiler.compile(existingConfig);

    expect(result.contractHash).toBe(contract.contractHash);
    expect(llm.requests).toHaveLength(0);
  });

  it('cycles the red-team lenses across the panel and fences authored file content', async () => {
    const contract = makeFakeContract({
      generatedFiles: [{ path: 'verify/widget.test.ts', sha256: 'a'.repeat(64) }],
    });
    const inner = new FakeCompiler(contract);
    const llm = new FakeLlm([pass]);
    const compiler = new CritiquedCompiler({
      inner,
      llm,
      critics: 2,
      rounds: 1,
      readFile: async () => 'expect(1).toBe(1)',
    });

    await compiler.compile(generateConfig);

    expect(llm.requests[0]?.prompt).toContain(CONTRACT_REDTEAM_LENSES[0]);
    expect(llm.requests[1]?.prompt).toContain(CONTRACT_REDTEAM_LENSES[1]);
    const prompt = llm.requests[0]?.prompt ?? '';
    expect(prompt).toContain('verify/widget.test.ts');
    expect(prompt).toContain('expect(1).toBe(1)');
    // The authored content rides inside an untrusted fence.
    expect(prompt).toContain('<<UNTRUSTED AUTHORED FILE');
  });

  it('shows the workspace facts to the red-team panel when provided', async () => {
    const inner = new FakeCompiler(makeFakeContract());
    const llm = new FakeLlm([pass]);
    const compiler = new CritiquedCompiler({
      inner,
      llm,
      critics: 1,
      rounds: 1,
      facts: 'WORKSPACE FACTS: Node package with "type": "module".',
    });

    await compiler.compile(generateConfig);

    expect(llm.requests[0]?.prompt).toContain('WORKSPACE FACTS');
    expect(llm.requests[0]?.prompt).toContain('"type": "module"');
  });

  it('drops an unreadable authored file from the prompt without failing the critique', async () => {
    const contract = makeFakeContract({
      generatedFiles: [{ path: 'verify/gone.test.ts', sha256: 'b'.repeat(64) }],
    });
    const inner = new FakeCompiler(contract);
    const llm = new FakeLlm([pass]);
    const compiler = new CritiquedCompiler({
      inner,
      llm,
      critics: 1,
      rounds: 1,
      readFile: async () => {
        throw new Error('ENOENT');
      },
    });

    const result = await compiler.compile(generateConfig);

    expect(result.contractHash).toBe(contract.contractHash);
    expect(llm.requests[0]?.prompt).toContain('(unreadable)');
  });
});
