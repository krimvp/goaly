import { describe, it, expect } from 'vitest';
import { prepareWorkspace } from './prepare';
import { makeFakeContract, FakeWorkspace } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import type { CommandResult } from '../workspace/workspace';

/** A workspace whose `run` returns scripted results in order, recording each command it was given. */
class ScriptedWorkspace extends FakeWorkspace {
  readonly commands: string[] = [];
  readonly #results: CommandResult[];
  constructor(results: CommandResult[]) {
    super();
    this.#results = [...results];
  }
  override async run(command: string): Promise<CommandResult> {
    this.commands.push(command);
    return this.#results.shift() ?? { exitCode: 0, stdout: '', stderr: '' };
  }
}

const ok: CommandResult = { exitCode: 0, stdout: '', stderr: '' };

describe('prepareWorkspace — setup (Fix #1)', () => {
  it('runs the setup command once before pre-flight and reports setupRan', async () => {
    const ws = new ScriptedWorkspace([ok, ok]);
    const contract = makeFakeContract({ setup: 'npm ci', rungs: [{ kind: 'deterministic', command: 'npm test' }] });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('proceed');
    expect(result.setupRan).toBe(true);
    // setup runs first, then the deterministic pre-flight rung.
    expect(ws.commands).toEqual(['npm ci', 'npm test']);
  });

  it('a non-zero setup exit is a typed setup-failed (and pre-flight never runs)', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: '', stderr: 'cannot resolve deps' }]);
    const contract = makeFakeContract({ setup: 'npm ci', rungs: [{ kind: 'deterministic', command: 'npm test' }] });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('setup-failed');
    if (result.prepared.status === 'setup-failed') {
      expect(result.prepared.detail).toContain('npm ci');
      expect(result.prepared.detail).toContain('cannot resolve deps');
    }
    expect(ws.commands).toEqual(['npm ci']); // short-circuited before pre-flight
  });

  it('a setup command that throws fails closed to setup-failed', async () => {
    const ws = new (class extends FakeWorkspace {
      override async run(): Promise<CommandResult> {
        throw new Error('spawn ENOENT');
      }
    })();
    const contract = makeFakeContract({ setup: 'npm ci' });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('setup-failed');
    if (result.prepared.status === 'setup-failed') expect(result.prepared.detail).toContain('spawn ENOENT');
  });

  it('no setup command ⇒ setupRan false, goes straight to pre-flight', async () => {
    const ws = new ScriptedWorkspace([ok]);
    const contract = makeFakeContract({ rungs: [{ kind: 'deterministic', command: 'npm test' }] });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.setupRan).toBe(false);
    expect(ws.commands).toEqual(['npm test']);
  });
});

describe('prepareWorkspace — pre-flight (Fix #2)', () => {
  // The pre-flight soundness classification is language-agnostic: a failing deterministic rung is
  // handed to the LLM, which decides broken-frozen-verifier (→ contract-unsound) vs honest-red
  // (→ proceed). These tests drive that decision with a scripted FakeLlm rather than text/exit-code
  // heuristics, so they hold for pytest, cargo, go test, tsc — any runner.
  const generatedFiles = [{ path: 'verify/x.test.ts', sha256: 'a'.repeat(64) }];
  /** A FakeLlm whose single response is the classifier's JSON verdict. */
  const soundnessLlm = (brokenVerification: boolean, reason = 'because') =>
    new FakeLlm([JSON.stringify({ brokenVerification, reason })]);

  it('the LLM judges a red an honest red (impl missing) → proceed', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: '', stderr: 'src/parser.ts: not implemented' }]);
    const contract = makeFakeContract({ rungs: [{ kind: 'deterministic', command: 'npm test' }], generatedFiles });
    const result = await prepareWorkspace({ workspace: ws, llm: soundnessLlm(false) }, contract);
    expect(result.prepared.status).toBe('proceed');
  });

  it('the LLM judges the frozen verification broken → contract-unsound', async () => {
    const ws = new ScriptedWorkspace([
      { exitCode: 2, stdout: '', stderr: "verify/x.test.ts(3,5): error TS2339: Property 'not' does not exist" },
    ]);
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'npm run typecheck' }],
      generatedFiles,
    });
    const result = await prepareWorkspace(
      { workspace: ws, llm: soundnessLlm(true, 'TS2339 in the authored test — it cannot compile') },
      contract,
    );
    expect(result.prepared.status).toBe('contract-unsound');
    if (result.prepared.status === 'contract-unsound') {
      expect(result.prepared.detail).toContain('cannot compile'); // the LLM's reason
      expect(result.prepared.detail).toContain('verify/x.test.ts'); // the raw verifier output
    }
  });

  // Regression (issue: `--verifier generate` + pytest aborts at pre-flight with 0 iterations). pytest
  // echoes the authored test file's path on EVERY run — session header + every traceback frame — so a
  // healthy honest red (the implementation files don't exist yet) names the authored file too. The old
  // substring heuristic wrongly rejected that as CONTRACT_UNSOUND; the LLM reads it as the expected red.
  it('a pytest honest red that NAMES the authored test file proceeds (issue regression)', async () => {
    const honestRed = [
      'test_pi_verification.py FFFFF                                            [100%]',
      'test_pi_verification.py:8: in test_pi_1',
      '    pytest.fail("pi_1.py not found")',
      'E   Failed: pi_1.py not found',
      'FAILED test_pi_verification.py::test_pi_1 - Failed: pi_1.py not found',
    ].join('\n');
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: honestRed, stderr: '' }]);
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'python3 -m pytest test_pi_verification.py' }],
      generatedFiles: [{ path: 'test_pi_verification.py', sha256: 'a'.repeat(64) }],
    });
    const result = await prepareWorkspace({ workspace: ws, llm: soundnessLlm(false) }, contract);
    expect(result.prepared.status).toBe('proceed');
  });

  it('a red with NO authored verification files proceeds without consulting the LLM', async () => {
    const ws = new ScriptedWorkspace([ok, { exitCode: 1, stdout: '', stderr: 'some failure' }]);
    const contract = makeFakeContract({
      setup: 'npm ci', // ⇒ pre-flight runs (needsPreparation) even with no generatedFiles
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
    }); // no generatedFiles
    const llm = soundnessLlm(true); // would say "broken" — but must never be called
    const result = await prepareWorkspace({ workspace: ws, llm }, contract);
    expect(result.prepared.status).toBe('proceed');
    expect(llm.requests).toEqual([]); // classifier was not consulted
  });

  it('a red with no LLM wired proceeds (cannot classify ⇒ honest red assumed)', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: '', stderr: 'verify/x.test.ts boom' }]);
    const contract = makeFakeContract({ rungs: [{ kind: 'deterministic', command: 'npm test' }], generatedFiles });
    const result = await prepareWorkspace({ workspace: ws }, contract); // no llm
    expect(result.prepared.status).toBe('proceed');
  });

  it('a classifier LLM that errors fails OPEN to proceed (runtime ladder is the real backstop)', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 2, stdout: '', stderr: 'verify/x.test.ts boom' }]);
    const contract = makeFakeContract({ rungs: [{ kind: 'deterministic', command: 'npm test' }], generatedFiles });
    const throwingLlm = new (class extends FakeLlm {
      constructor() {
        super(['unused']);
      }
      override async complete(): ReturnType<FakeLlm['complete']> {
        throw new Error('provider exploded');
      }
    })();
    const result = await prepareWorkspace({ workspace: ws, llm: throwingLlm }, contract);
    expect(result.prepared.status).toBe('proceed');
  });

  it('an unparseable classifier response fails OPEN to proceed', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 2, stdout: '', stderr: 'verify/x.test.ts boom' }]);
    const contract = makeFakeContract({ rungs: [{ kind: 'deterministic', command: 'npm test' }], generatedFiles });
    const result = await prepareWorkspace({ workspace: ws, llm: new FakeLlm(['not json at all']) }, contract);
    expect(result.prepared.status).toBe('proceed');
  });

  it('all deterministic rungs already passing ⇒ proceed', async () => {
    const ws = new ScriptedWorkspace([ok]);
    const contract = makeFakeContract({ rungs: [{ kind: 'deterministic', command: 'true' }] });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('proceed');
  });

  it('a pre-flight infrastructure error is advisory only → proceed (the real ladder runs fail-closed)', async () => {
    // No setup, so the first (and only) workspace.run is the pre-flight rung — make it throw.
    const ws = new (class extends FakeWorkspace {
      override async run(): Promise<CommandResult> {
        throw new Error('git index lock held');
      }
    })();
    const contract = makeFakeContract({ rungs: [{ kind: 'deterministic', command: 'npm test' }] });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('proceed');
  });

  it('judge rungs are NOT run at pre-flight (no LLM tokens spent)', async () => {
    const ws = new ScriptedWorkspace([ok]);
    const contract = makeFakeContract({
      rungs: [
        { kind: 'deterministic', command: 'npm test' },
        { kind: 'judge', rubric: 'looks good', quorum: 1, confidenceFloor: 0.5 },
      ],
      rubric: 'looks good',
    });
    await prepareWorkspace({ workspace: ws }, contract);
    expect(ws.commands).toEqual(['npm test']); // only the deterministic rung ran
  });
});
