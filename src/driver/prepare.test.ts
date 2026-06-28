import { describe, it, expect } from 'vitest';
import { prepareWorkspace } from './prepare';
import { makeFakeContract, FakeWorkspace, recordingLogger } from '../testing/fakes';
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

  it('exit 127 (command not found) adds an actionable hint about the missing toolchain', async () => {
    const ws = new ScriptedWorkspace([
      { exitCode: 127, stdout: '', stderr: '/bin/sh: 1: rustup: not found' },
    ]);
    const contract = makeFakeContract({
      setup: 'rustup component add clippy rustfmt',
      rungs: [{ kind: 'deterministic', command: 'cargo test' }],
    });
    const result = await prepareWorkspace({ workspace: ws }, contract);
    expect(result.prepared.status).toBe('setup-failed');
    if (result.prepared.status === 'setup-failed') {
      expect(result.prepared.detail).toContain('rustup: not found');
      expect(result.prepared.detail).toContain('not installed');
      expect(result.prepared.detail).toContain('--no-setup');
    }
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

describe('prepareWorkspace — authored setup is best-effort (Fix A)', () => {
  it('an AUTHORED setup that fails degrades to proceed with a threaded setupHint (not setup-failed)', async () => {
    // setup fails (from-scratch: no go.mod yet), then the pre-flight rung is red (honest) → proceed.
    const ws = new ScriptedWorkspace([
      { exitCode: 1, stdout: '', stderr: 'go.mod file not found in current directory' },
      { exitCode: 1, stdout: '', stderr: 'build failed' },
    ]);
    const contract = makeFakeContract({
      setup: 'go mod download',
      rungs: [{ kind: 'deterministic', command: 'go build ./...' }],
    });
    const { logger, records } = recordingLogger();
    const result = await prepareWorkspace({ workspace: ws, setupAuthored: true, logger }, contract);

    expect(result.prepared.status).toBe('proceed');
    expect(result.setupRan).toBe(true);
    if (result.prepared.status === 'proceed') {
      expect(result.prepared.setupHint).toContain('go mod download');
      expect(result.prepared.setupHint).toContain('scaffolding');
    }
    // It logged loudly (warn), not silently.
    expect(records.some((r) => r.level === 'warn' && /authored setup/i.test(r.msg))).toBe(true);
  });

  it('a USER setup (setupAuthored:false) that fails is still a fatal setup-failed (regression)', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: '', stderr: 'cannot resolve deps' }]);
    const contract = makeFakeContract({
      setup: 'npm ci',
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
    });
    const result = await prepareWorkspace({ workspace: ws, setupAuthored: false }, contract);
    expect(result.prepared.status).toBe('setup-failed');
    expect(ws.commands).toEqual(['npm ci']); // short-circuited before pre-flight
  });

  it('omitting setupAuthored defaults to fatal (fail-closed) on a failed setup', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: '', stderr: 'boom' }]);
    const contract = makeFakeContract({ setup: 'npm ci' });
    const result = await prepareWorkspace({ workspace: ws }, contract); // no setupAuthored
    expect(result.prepared.status).toBe('setup-failed');
  });

  it('an AUTHORED setup that SUCCEEDS proceeds with no setupHint', async () => {
    const ws = new ScriptedWorkspace([ok, ok]);
    const contract = makeFakeContract({
      setup: 'go mod download',
      rungs: [{ kind: 'deterministic', command: 'go build ./...' }],
    });
    const result = await prepareWorkspace({ workspace: ws, setupAuthored: true }, contract);
    expect(result.prepared.status).toBe('proceed');
    if (result.prepared.status === 'proceed') expect(result.prepared.setupHint).toBeUndefined();
  });
});

describe('prepareWorkspace — from-scratch tree still runs + classifies the soundness pre-flight (Fix B1, issue #78)', () => {
  const generatedFiles = [{ path: 'verify/x.test.ts', sha256: 'a'.repeat(64) }];

  it('from-scratch + red rung judged honest (impl missing) → proceed (rung run, classifier consulted)', async () => {
    // isEmptyOfSource=true no longer short-circuits: the rung still runs and the classifier decides.
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: '', stderr: 'go.mod not found' }]);
    ws.setEmptyOfSource(true);
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'go build ./...' }],
      generatedFiles,
    });
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: false, reason: 'go.mod not created yet' })]);
    const result = await prepareWorkspace({ workspace: ws, llm }, contract);
    expect(result.prepared.status).toBe('proceed');
    expect(ws.commands).toEqual(['go build ./...']); // the rung WAS run
    expect(llm.requests).toHaveLength(1); // the classifier WAS consulted
    // …and it was told this is a from-scratch tree, so it biases toward "honest red".
    expect(llm.requests[0]?.prompt).toMatch(/EMPTY OF IMPLEMENTATION SOURCE/i);
  });

  // The issue #78 regression: a from-scratch tree whose FROZEN authored verifier cannot even run/compile
  // (a defect the agent can never fix, because the file is frozen) must be caught as contract-unsound up
  // front — not loop to STUCK_REPEATED_FAILURE. The old B1 skipped the rung entirely and missed this.
  it('from-scratch + broken frozen verifier → contract-unsound (was: un-completable, issue #78)', async () => {
    const ws = new ScriptedWorkspace([
      { exitCode: 2, stdout: '', stderr: 'verify/check.sh: 1: Syntax error: "(" unexpected' },
    ]);
    ws.setEmptyOfSource(true); // a from-scratch tree — the old code would have skipped the check
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'sh verify/check.sh' }],
      generatedFiles: [{ path: 'verify/check.sh', sha256: 'a'.repeat(64) }],
    });
    const llm = new FakeLlm([
      JSON.stringify({ brokenVerification: true, reason: 'shell syntax error in the frozen verify/check.sh' }),
    ]);
    const result = await prepareWorkspace({ workspace: ws, llm }, contract);
    expect(result.prepared.status).toBe('contract-unsound');
    if (result.prepared.status === 'contract-unsound') {
      expect(result.prepared.detail).toContain('verify/check.sh'); // the raw verifier output
      expect(result.prepared.detail).toContain('frozen'); // the classifier's reason
    }
    expect(ws.commands).toEqual(['sh verify/check.sh']); // the rung WAS run before classifying
    expect(llm.requests).toHaveLength(1);
  });

  it('an EXISTING project (isEmptyOfSource false) + red rung + broken:true → still contract-unsound', async () => {
    const ws = new ScriptedWorkspace([
      { exitCode: 2, stdout: '', stderr: "verify/x.test.ts(3,5): error TS2339" },
    ]);
    ws.setEmptyOfSource(false); // explicit: a populated tree
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'npm run typecheck' }],
      generatedFiles,
    });
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: true, reason: 'TS2339 in the authored test' })]);
    const result = await prepareWorkspace({ workspace: ws, llm }, contract);
    expect(result.prepared.status).toBe('contract-unsound');
    expect(llm.requests).toHaveLength(1); // the classifier WAS consulted (not from-scratch)
  });

  it('an EXISTING project + red rung + broken:false → proceed (honest red)', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 1, stdout: '', stderr: 'src/parser.ts: not implemented' }]);
    ws.setEmptyOfSource(false);
    const contract = makeFakeContract({
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      generatedFiles,
    });
    const llm = new FakeLlm([JSON.stringify({ brokenVerification: false })]);
    const result = await prepareWorkspace({ workspace: ws, llm }, contract);
    expect(result.prepared.status).toBe('proceed');
    expect(llm.requests).toHaveLength(1);
  });
});

describe('prepareWorkspace — required-tools preflight', () => {
  const toolContract = (over: Partial<Parameters<typeof makeFakeContract>[0]> = {}) =>
    makeFakeContract({
      requiredTools: ['cargo'],
      setup: 'cargo fetch',
      rungs: [{ kind: 'deterministic', command: 'cargo test' }],
      ...over,
    });

  it('all tools present ⇒ probe runs FIRST, then setup, then pre-flight', async () => {
    // probe → empty stdout (nothing missing); setup ok; pre-flight rung ok.
    const ws = new ScriptedWorkspace([{ exitCode: 0, stdout: '', stderr: '' }, ok, ok]);
    const result = await prepareWorkspace({ workspace: ws }, toolContract());
    expect(result.prepared.status).toBe('proceed');
    expect(result.setupRan).toBe(true);
    expect(ws.commands[0]).toContain('command -v cargo'); // the probe ran first
    expect(ws.commands.slice(1)).toEqual(['cargo fetch', 'cargo test']);
  });

  it('missing tool + --install-missing-tools false ⇒ typed tools-missing, setup never runs', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 0, stdout: 'cargo\n', stderr: '' }]);
    const result = await prepareWorkspace(
      { workspace: ws, installMissingTools: false },
      toolContract(),
    );
    expect(result.prepared.status).toBe('tools-missing');
    if (result.prepared.status === 'tools-missing') {
      expect(result.prepared.detail).toContain('cargo');
      expect(result.prepared.detail).toContain('install');
    }
    expect(result.setupRan).toBe(false);
    expect(ws.commands).toHaveLength(1); // only the probe — short-circuited before setup
  });

  it('missing tool + default (install) ⇒ proceed carrying installTools, goaly setup SKIPPED', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 0, stdout: 'cargo\n', stderr: '' }]);
    const result = await prepareWorkspace({ workspace: ws }, toolContract());
    expect(result.prepared.status).toBe('proceed');
    if (result.prepared.status === 'proceed') {
      expect(result.prepared.installTools).toEqual(['cargo']);
    }
    expect(result.setupRan).toBe(false); // the agent runs setup itself; goaly's would only fail
    expect(ws.commands).toHaveLength(1); // probe only; no setup, no pre-flight on the absent toolchain
  });

  it('reports only the tools that are actually absent', async () => {
    const ws = new ScriptedWorkspace([{ exitCode: 0, stdout: 'pytest\n', stderr: '' }]);
    const result = await prepareWorkspace(
      { workspace: ws, installMissingTools: false },
      toolContract({ requiredTools: ['python', 'pytest'] }),
    );
    expect(result.prepared.status).toBe('tools-missing');
    if (result.prepared.status === 'tools-missing') {
      expect(result.prepared.detail).toContain('pytest');
      expect(result.prepared.detail).not.toContain('python,'); // python was present
    }
  });

  it('fails OPEN (proceeds) when the probe itself errors — a glitch never blocks a legit run', async () => {
    const ws = new (class extends FakeWorkspace {
      override async run(): Promise<CommandResult> {
        throw new Error('probe blew up');
      }
    })();
    const contract = makeFakeContract({ requiredTools: ['cargo'], rungs: [{ kind: 'deterministic', command: 'true' }] });
    const result = await prepareWorkspace({ workspace: ws, installMissingTools: false }, contract);
    expect(result.prepared.status).toBe('proceed'); // not tools-missing — the probe couldn't determine
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
