import { describe, it, expect } from 'vitest';
import {
  CritiquedCompiler,
  CONTRACT_REDTEAM_LENSES,
  SATISFIABILITY_LENS,
  SATISFIABILITY_GUARDRAIL,
} from './critiqued-compiler';
import { FakeCompiler, makeFakeContract } from '../testing/fakes';
import { FakeLlm, type LlmCompletion, type LlmProvider, type LlmRequest } from '../llm/provider';
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

/**
 * Issue #118 — the FALSE-RED / satisfiability lens. Every other lens attacks a false GREEN ("could
 * a lazy worker pass this bar without meeting the goal"); this one asks the mirror question, and is
 * the ONE review step that is on by DEFAULT under `--generate`, because a false red costs the whole
 * run while the guard costs one compile-time call.
 */
describe('FALSE-RED satisfiability critic', () => {
  const withFile = (path: string) =>
    makeFakeContract({ generatedFiles: [{ path, sha256: 'c'.repeat(64) }] });

  /**
   * The #114 defect, verbatim in shape: the spy is restored BEFORE the call-count assertion runs.
   * `mockRestore()` clears `mock.calls`, so this bar reds even a perfect implementation.
   */
  const POST_RESTORE_SPY = [
    "const spy = vi.spyOn(world, 'step');",
    'runSimulation();',
    'spy.mockRestore();',
    'expect(spy).toHaveBeenCalled();',
  ].join('\n');

  /** Strict, thorough, and perfectly satisfiable: the count is captured BEFORE the restore. */
  const STRICT_BUT_SATISFIABLE = [
    "const spy = vi.spyOn(world, 'step');",
    'let calls = 0;',
    'try {',
    '  runSimulation();',
    '  calls = spy.mock.calls.length;',
    '} finally {',
    '  spy.mockRestore();',
    '}',
    'expect(calls).toBeGreaterThan(0);',
    'expect(result.energy).toBeCloseTo(42.5, 6);',
  ].join('\n');

  /**
   * A stand-in for the critic model that actually READS the authored file it is shown: it reports
   * a critical finding only when a call-count assertion follows the restore. Pinning the plumbing
   * this way (rather than a canned reply) proves the authored content reaches the critic AND that a
   * legitimately strict bar produces no finding.
   */
  class SatisfiabilityCriticStub implements LlmProvider {
    readonly name = 'satisfiability-critic-stub';
    readonly prompts: string[] = [];
    async complete(req: LlmRequest): Promise<LlmCompletion> {
      this.prompts.push(req.prompt);
      // Read ONLY the authored-file section — the lens text itself names the footgun, so a naive
      // whole-prompt scan would "find" the defect in every prompt.
      const start = req.prompt.indexOf('AUTHORED FILE');
      const end = req.prompt.indexOf('REVIEW LENS');
      const authored = start === -1 ? '' : req.prompt.slice(start, end === -1 ? undefined : end);
      const restore = authored.indexOf('mockRestore()');
      const assertion = authored.indexOf('expect(spy).toHaveBeenCalled()');
      const unsatisfiable = restore !== -1 && assertion > restore;
      if (!unsatisfiable) return { text: pass };
      return {
        text: critical(
          'expect(spy).toHaveBeenCalled() runs AFTER spy.mockRestore(), which clears mock.calls: a ' +
            'correct implementation that calls world.step still reds this bar',
          'capture spy.mock.calls.length into a local BEFORE restoring, then assert on that local',
        ),
      };
    }
  }

  it("flags the #114 defect (a post-mockRestore call-count assertion) as critical and re-authors", async () => {
    const inner = new FakeCompiler([withFile('verify/usage.test.ts'), makeFakeContract()]);
    const llm = new SatisfiabilityCriticStub();
    const compiler = new CritiquedCompiler({
      inner,
      llm,
      critics: 0, // the --adversarial panel is OFF: this is the default-on critic alone
      rounds: 1,
      satisfiability: true,
      readFile: async () => POST_RESTORE_SPY,
    });

    await compiler.compile(generateConfig);

    expect(llm.prompts).toHaveLength(1); // exactly ONE extra call
    expect(llm.prompts[0]).toContain(SATISFIABILITY_LENS);
    expect(inner.feedbacks).toHaveLength(2); // the finding drove a re-author round
    expect(inner.feedbacks[1]).toContain('clears mock.calls');
    expect(inner.feedbacks[1]).toContain('capture spy.mock.calls.length into a local');
  });

  it('tells the re-author to make the bar SATISFIABLE, never easier (and still red today)', async () => {
    const inner = new FakeCompiler([withFile('verify/usage.test.ts'), makeFakeContract()]);
    const compiler = new CritiquedCompiler({
      inner,
      llm: new SatisfiabilityCriticStub(),
      critics: 0,
      rounds: 1,
      satisfiability: true,
      readFile: async () => POST_RESTORE_SPY,
    });

    await compiler.compile(generateConfig);

    const feedback = inner.feedbacks[1] ?? '';
    expect(feedback).toContain(SATISFIABILITY_GUARDRAIL);
    expect(feedback).toContain('never make it easier');
    expect(feedback).toContain('must still FAIL on the current (unimplemented) tree');
  });

  it('does NOT flag a legitimately strict but satisfiable bar (no re-author, contract untouched)', async () => {
    const contract = withFile('verify/usage.test.ts');
    const inner = new FakeCompiler(contract);
    const llm = new SatisfiabilityCriticStub();
    const compiler = new CritiquedCompiler({
      inner,
      llm,
      critics: 0,
      rounds: 2,
      satisfiability: true,
      readFile: async () => STRICT_BUT_SATISFIABLE,
    });

    const result = await compiler.compile(generateConfig);

    expect(result.contractHash).toBe(contract.contractHash);
    expect(inner.feedbacks).toEqual([undefined]); // never re-authored
    expect(llm.prompts).toHaveLength(1); // a passing round short-circuits the remaining rounds
  });

  it('drops the findings and proceeds when the critic errors (advisory, fail-open)', async () => {
    const contract = withFile('verify/usage.test.ts');
    const inner = new FakeCompiler(contract);
    const llm: LlmProvider = {
      name: 'exploding-critic',
      complete: async () => {
        throw new Error('critic transport blew up');
      },
    };
    const compiler = new CritiquedCompiler({
      inner,
      llm,
      critics: 0,
      rounds: 1,
      satisfiability: true,
      readFile: async () => POST_RESTORE_SPY,
    });

    const result = await compiler.compile(generateConfig);

    expect(result.contractHash).toBe(contract.contractHash);
    expect(inner.feedbacks).toEqual([undefined]);
  });

  it('drops unparseable critic output and proceeds (fail-open, never an invented finding)', async () => {
    const contract = withFile('verify/usage.test.ts');
    const inner = new FakeCompiler(contract);
    const llm = new FakeLlm(['not json at all']);
    const compiler = new CritiquedCompiler({
      inner,
      llm,
      critics: 0,
      rounds: 1,
      satisfiability: true,
      readFile: async () => POST_RESTORE_SPY,
    });

    const result = await compiler.compile(generateConfig);

    expect(result.contractHash).toBe(contract.contractHash);
    expect(inner.feedbacks).toEqual([undefined]);
  });

  it('does not run at all when the contract authored no verification files', async () => {
    const inner = new FakeCompiler(makeFakeContract()); // generatedFiles: []
    const llm = new FakeLlm([critical('should never be consulted')]);
    const compiler = new CritiquedCompiler({ inner, llm, critics: 0, rounds: 1, satisfiability: true });

    await compiler.compile(generateConfig);

    expect(llm.requests).toHaveLength(0);
    expect(inner.feedbacks).toEqual([undefined]);
  });

  it('never runs for an existing (user-supplied) verifier — nothing was authored', async () => {
    const inner = new FakeCompiler(withFile('verify/usage.test.ts'));
    const llm = new FakeLlm([critical('should never be consulted')]);
    const compiler = new CritiquedCompiler({ inner, llm, critics: 0, rounds: 1, satisfiability: true });

    await compiler.compile(existingConfig);

    expect(llm.requests).toHaveLength(0);
  });

  it('rides ALONGSIDE the --adversarial panel: N panel calls plus exactly one satisfiability call', async () => {
    const inner = new FakeCompiler(withFile('verify/usage.test.ts'));
    const llm = new FakeLlm([pass]);
    const compiler = new CritiquedCompiler({
      inner,
      llm,
      critics: 2,
      rounds: 1,
      satisfiability: true,
      readFile: async () => STRICT_BUT_SATISFIABLE,
    });

    await compiler.compile(generateConfig);

    expect(llm.requests).toHaveLength(3);
    expect(llm.requests[0]?.prompt).toContain(CONTRACT_REDTEAM_LENSES[0]);
    expect(llm.requests[1]?.prompt).toContain(CONTRACT_REDTEAM_LENSES[1]);
    expect(llm.requests[2]?.prompt).toContain(SATISFIABILITY_LENS);
  });

  it('is off unless asked for: the panel alone never makes the extra call', async () => {
    const inner = new FakeCompiler(withFile('verify/usage.test.ts'));
    const llm = new FakeLlm([pass]);
    const compiler = new CritiquedCompiler({
      inner,
      llm,
      critics: 1,
      rounds: 1,
      readFile: async () => POST_RESTORE_SPY,
    });

    await compiler.compile(generateConfig);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.prompt).not.toContain(SATISFIABILITY_LENS);
  });
});

/**
 * The lens taxonomy itself: the false-red direction must be present AND must be reachable by the
 * `--adversarial` panel too (it is the 5th lens the panel cycles), not only by the solo critic.
 */
describe('CONTRACT_REDTEAM_LENSES', () => {
  it('includes the FALSE-RED / SATISFIABILITY lens as a panel lens', () => {
    expect(CONTRACT_REDTEAM_LENSES).toContain(SATISFIABILITY_LENS);
    expect(SATISFIABILITY_LENS).toContain('FALSE-RED / SATISFIABILITY');
    // It must name the exact #114 footgun, not just gesture at "flaky assertions".
    expect(SATISFIABILITY_LENS).toContain('mockRestore()');
  });

  it('cycles the false-red lens onto the 5th panel critic', async () => {
    const inner = new FakeCompiler(makeFakeContract());
    const llm = new FakeLlm([pass]);
    const compiler = new CritiquedCompiler({ inner, llm, critics: 5, rounds: 1 });

    await compiler.compile(generateConfig);

    expect(llm.requests).toHaveLength(5);
    expect(llm.requests[4]?.prompt).toContain(SATISFIABILITY_LENS);
  });
});
