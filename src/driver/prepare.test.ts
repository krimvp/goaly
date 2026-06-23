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
