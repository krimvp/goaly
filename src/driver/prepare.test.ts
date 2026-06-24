import { describe, it, expect } from 'vitest';
import { prepareWorkspace } from './prepare';
import { makeFakeContract, FakeWorkspace } from '../testing/fakes';
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
  it('a deterministic failure rooted in src/ is an honest red → proceed', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: '', stderr: 'src/parser.ts: not implemented' }]);
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      generatedFiles: [{ path: 'verify/x.test.ts', sha256: 'a'.repeat(64) }],
    });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('proceed');
  });

  it('a deterministic failure pointing at an authored verification file is contract-unsound', async () => {
    const ws = new ScriptedWorkspace([
      { exitCode: 2, stdout: '', stderr: "verify/x.test.ts(3,5): error TS2339: Property 'not' does not exist" },
    ]);
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'npm run typecheck' }],
      generatedFiles: [{ path: 'verify/x.test.ts', sha256: 'a'.repeat(64) }],
    });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('contract-unsound');
    if (result.prepared.status === 'contract-unsound') expect(result.prepared.detail).toContain('verify/x.test.ts');
  });

  // Regression (issue: `--verifier generate` + pytest aborts at pre-flight with 0 iterations). pytest
  // echoes the authored test file's path on EVERY run — the session header and each traceback frame —
  // so a healthy honest red (the implementation files don't exist yet) names the authored file too. A
  // bare path-substring match wrongly rejected that as CONTRACT_UNSOUND. An honest assertion red must
  // proceed: only a verification that could not RUN (compile/syntax/collection error) is unsound.
  it('a pytest honest red that NAMES the authored test file is still proceed (issue regression)', async () => {
    const honestRed = [
      'python3 -m pytest test_pi_verification.py: exit 1',
      '============================= test session starts =============================',
      'collected 5 items',
      '',
      'test_pi_verification.py FFFFF                                            [100%]',
      '',
      '=================================== FAILURES ===================================',
      '_________________________________ test_pi_1 ___________________________________',
      'test_pi_verification.py:8: in test_pi_1',
      '    pytest.fail("pi_1.py not found")',
      'E   Failed: pi_1.py not found',
      '=========================== short test summary info ===========================',
      'FAILED test_pi_verification.py::test_pi_1 - Failed: pi_1.py not found',
      '============================== 5 failed in 0.04s ==============================',
    ].join('\n');
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: honestRed, stderr: '' }]);
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'python3 -m pytest test_pi_verification.py' }],
      generatedFiles: [{ path: 'test_pi_verification.py', sha256: 'a'.repeat(64) }],
    });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('proceed');
  });

  it('a pytest collection error in the authored test IS contract-unsound (fail-closed preserved)', async () => {
    const collectionError = [
      'python3 -m pytest test_pi_verification.py: exit 2',
      '============================= test session starts =============================',
      'collected 0 items / 1 error',
      '',
      '=================================== ERRORS ====================================',
      '_____________________ ERROR collecting test_pi_verification.py ________________',
      'test_pi_verification.py:3: in <module>',
      '    import not_a_real_helper',
      "E   ModuleNotFoundError: No module named 'not_a_real_helper'",
      '=========================== short test summary info ===========================',
      'ERROR test_pi_verification.py',
      '!!!!!!!!!!!!!!!!!!!! Interrupted: 1 error during collection !!!!!!!!!!!!!!!!!!!!',
    ].join('\n');
    const ws = new ScriptedWorkspace([{ exitCode: 2, stdout: collectionError, stderr: '' }]);
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'python3 -m pytest test_pi_verification.py' }],
      generatedFiles: [{ path: 'test_pi_verification.py', sha256: 'a'.repeat(64) }],
    });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('contract-unsound');
    if (result.prepared.status === 'contract-unsound')
      expect(result.prepared.detail).toContain('test_pi_verification.py');
  });

  it('a pytest SyntaxError in the authored test IS contract-unsound', async () => {
    const syntaxError = [
      'python3 -m pytest test_pi_verification.py: exit 2',
      '_____________________ ERROR collecting test_pi_verification.py ________________',
      'test_pi_verification.py:5: in <module>',
      '    def test_pi_1(:',
      'E     def test_pi_1(:',
      'E                  ^',
      'E   SyntaxError: invalid syntax',
    ].join('\n');
    const ws = new ScriptedWorkspace([{ exitCode: 2, stdout: syntaxError, stderr: '' }]);
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'python3 -m pytest test_pi_verification.py' }],
      generatedFiles: [{ path: 'test_pi_verification.py', sha256: 'a'.repeat(64) }],
    });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('contract-unsound');
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
