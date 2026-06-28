import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { composeDeps, makeLlmProvider, buildLadder } from './compose';
import { codexCodec } from '../agent-cli/codex-codec';
import { droidCodec } from '../agent-cli/droid-codec';
import { piCodec } from '../agent-cli/pi-codec';
import { makeConfig, InMemoryLogFs } from '../testing/fakes';
import { asRunId, DiffHash } from '../domain/ids';
import { freezeContract } from '../util/hash';
import { FakeLlm } from '../llm/provider';
import type { Workspace, CommandResult } from '../workspace/workspace';

describe('LLM provider completion argv (read-only)', () => {
  it('codex runs --sandbox read-only with the model before the prompt positional', () => {
    expect(codexCodec.readonlyArgs({ prompt: 'judge this', model: 'gpt-x', stream: false })).toEqual([
      'exec', '--sandbox', 'read-only', '--model', 'gpt-x', 'judge this', '--json',
    ]);
  });

  it('codex omits --model when none is set', () => {
    expect(codexCodec.readonlyArgs({ prompt: 'p', model: undefined, stream: false })).toEqual([
      'exec', '--sandbox', 'read-only', 'p', '--json',
    ]);
  });

  it('droid never passes --auto (the exec default cannot edit the tree)', () => {
    const args = droidCodec.readonlyArgs({ prompt: 'p', model: 'm1', stream: false });
    expect(args).toEqual(['exec', '--output-format', 'json', '--model', 'm1', 'p']);
    expect(args).not.toContain('--auto');
  });

  it('pi runs read-only tools only (no edit/write/bash), model before the prompt positional', () => {
    const args = piCodec.readonlyArgs({ prompt: 'judge this', model: 'anthropic/claude-opus-4-8', stream: false });
    expect(args).toEqual([
      '--print', '--mode', 'json', '--tools', 'read,grep,find,ls', '--model', 'anthropic/claude-opus-4-8', 'judge this',
    ]);
    expect(args).not.toContain('edit');
    expect(args).not.toContain('write');
  });

  it('pi omits --model when none is set', () => {
    expect(piCodec.readonlyArgs({ prompt: 'p', model: undefined, stream: false })).toEqual([
      '--print', '--mode', 'json', '--tools', 'read,grep,find,ls', 'p',
    ]);
  });
});

describe('makeLlmProvider', () => {
  it('names the provider after the chosen CLI', () => {
    expect(makeLlmProvider('claude', undefined).name).toBe('cli:claude');
    expect(makeLlmProvider('codex', undefined).name).toBe('cli:codex');
    expect(makeLlmProvider('droid', undefined).name).toBe('cli:droid');
    expect(makeLlmProvider('pi', undefined).name).toBe('cli:pi');
  });
});

describe('composeDeps — phased wiring (issue #48)', () => {
  const opts = (over: Record<string, unknown> = {}) => ({
    harness: 'fake' as const,
    workspaceRoot: '/tmp/x',
    runId: asRunId('run-1'),
    llm: new FakeLlm(['{}']),
    noLogConsole: true,
    logFs: new InMemoryLogFs(),
    ...over,
  });

  it('wires a planner + plan Seal only when config.phased is true', () => {
    const phased = composeDeps(makeConfig({ phased: true }), opts());
    expect(phased.planner).toBeDefined();
    expect(phased.planGate).toBeDefined();

    const classic = composeDeps(makeConfig(), opts());
    expect(classic.planner).toBeUndefined();
    expect(classic.planGate).toBeUndefined();
  });

  it('--autonomous selects the auto plan Seal; default selects the human gate', () => {
    const auto = composeDeps(makeConfig({ phased: true, autonomous: true }), opts());
    expect(auto.planGate?.constructor.name).toBe('AutoPlanGate');
    const human = composeDeps(makeConfig({ phased: true }), opts());
    expect(human.planGate?.constructor.name).toBe('HumanPlanGate');
  });

  it('--plan-file selects the StaticPlanner; otherwise the AgentPlanner authors the plan', () => {
    const staticP = composeDeps(makeConfig({ phased: true }), opts({ planFile: 'plan.json' }));
    expect(staticP.planner?.constructor.name).toBe('StaticPlanner');
    const agentP = composeDeps(makeConfig({ phased: true }), opts());
    expect(agentP.planner?.constructor.name).toBe('AgentPlanner');
  });
});

describe('composeDeps — --explain observer wiring (issue #8)', () => {
  const opts = (over: Record<string, unknown> = {}) => ({
    harness: 'fake' as const,
    workspaceRoot: '/tmp/x',
    runId: asRunId('run-explain'),
    llm: new FakeLlm(['a summary']),
    noLogConsole: true,
    logFs: new InMemoryLogFs(),
    ...over,
  });

  it('builds an observer ONLY when --explain is set (off by default)', () => {
    expect(composeDeps(makeConfig(), opts()).observer).toBeUndefined();
    expect(composeDeps(makeConfig(), opts({ explain: true })).observer).toBeDefined();
  });

  it('an injected observer takes precedence over building one', () => {
    const injected = { onEvent: async () => {}, onOutcome: async () => {} };
    const deps = composeDeps(makeConfig(), opts({ explain: true, observer: injected }));
    expect(deps.observer).toBe(injected);
  });

  it('the built observer narrates through the injected provider + explainWrite sink', async () => {
    const lines: string[] = [];
    const llm = new FakeLlm(['the run finished cleanly']);
    const deps = composeDeps(
      makeConfig(),
      opts({ explain: true, llm, explainWrite: (s: string) => lines.push(s) }),
    );
    await deps.observer!.onOutcome({
      status: 'DONE',
      iterations: 2,
      contractHash: null,
      runId: asRunId('run-explain'),
    });
    // The provider was prompted and the summary reached the capturing writer (full compose wiring).
    expect(llm.requests).toHaveLength(1);
    expect(lines).toEqual(['[explain] the run finished cleanly\n']);
  });
});

describe('buildLadder — verify timeout threading', () => {
  /** A workspace that records the opts passed to `run`. */
  function spyWorkspace(): {
    workspace: Workspace;
    calls: Array<{ command: string; opts?: { timeoutMs?: number } }>;
  } {
    const calls: Array<{ command: string; opts?: { timeoutMs?: number } }> = [];
    const result: CommandResult = { exitCode: 0, stdout: '', stderr: '' };
    const workspace: Workspace = {
      async diffHash() {
        return DiffHash.parse('0'.repeat(40));
      },
      async diff() {
        return '';
      },
      async checkpoint() {
        return DiffHash.parse('0'.repeat(40));
      },
      setBaseline() {},
      currentBaseline() {
        return 'HEAD';
      },
      async run(command, opts) {
        calls.push(opts !== undefined ? { command, opts } : { command });
        return result;
      },
      async fileHash() {
        return null;
      },
      async isEmptyOfSource() {
        return false;
      },
    };
    return { workspace, calls };
  }

  it('passes verifyTimeoutMs down into each deterministic rung', async () => {
    const contract = freezeContract({
      goal: 'g',
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      rubric: 'r',
      generatedFiles: [],
    });
    const ladder = buildLadder(contract, new FakeLlm([]), 45000);
    const { workspace, calls } = spyWorkspace();

    await ladder.verify(workspace, 'g', 'r');

    expect(calls).toEqual([{ command: 'npm test', opts: { timeoutMs: 45000 } }]);
  });

  it('omits the timeout when none is configured', async () => {
    const contract = freezeContract({
      goal: 'g',
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      rubric: 'r',
      generatedFiles: [],
    });
    const ladder = buildLadder(contract, new FakeLlm([]));
    const { workspace, calls } = spyWorkspace();

    await ladder.verify(workspace, 'g', 'r');

    expect(calls).toEqual([{ command: 'npm test' }]);
  });

  it('prepends a generated-files guard that fails closed before the command runs', async () => {
    const contract = freezeContract({
      goal: 'g',
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      rubric: 'r',
      generatedFiles: [{ path: 'authored.test.ts', sha256: 'a'.repeat(64) }],
    });
    const ladder = buildLadder(contract, new FakeLlm([]));
    const { workspace, calls } = spyWorkspace(); // fileHash() returns null → tampered/missing

    const verdict = await ladder.verify(workspace, 'g', 'r');

    // The guard short-circuits: a hard red, and the deterministic command never ran.
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain('authored.test.ts');
    expect(calls).toEqual([]);
  });

  it('runs an artifact-running smoke command as a second deterministic rung, after the main one (issue #53)', async () => {
    const contract = freezeContract({
      goal: 'g',
      rungs: [
        { kind: 'deterministic', command: 'npm test' },
        { kind: 'deterministic', command: 'node smoke.mjs', label: 'smoke' },
      ],
      rubric: '',
      generatedFiles: [],
    });
    const ladder = buildLadder(contract, new FakeLlm([]), 30000);
    const { workspace, calls } = spyWorkspace();

    await ladder.verify(workspace, 'g', 'r');

    // Both deterministic rungs run in order, each capped by the verify timeout — the smoke command
    // is just another ungameable exit-code check (runtime-agnostic), not a browser-specific seam.
    expect(calls).toEqual([
      { command: 'npm test', opts: { timeoutMs: 30000 } },
      { command: 'node smoke.mjs', opts: { timeoutMs: 30000 } },
    ]);
  });
});

describe('composeDeps — diagnostic logger wiring', () => {
  it('defaults the diagnostics file to <stateDir>/<runId>/goaly.log and writes through it', () => {
    const fs = new InMemoryLogFs();
    const runId = asRunId('run-log-1');
    const deps = composeDeps(makeConfig(), {
      harness: 'fake',
      workspaceRoot: '/repo',
      runId,
      noLogConsole: true,
      logFs: fs,
    });
    deps.logger?.info('hello');
    const expected = path.join('/repo', '.goaly', runId, 'goaly.log');
    expect(fs.files.get(expected)).toContain('hello');
    // runId is bound onto every record.
    expect(fs.files.get(expected)).toContain(runId);
  });

  it('writes no diagnostics file when noLogFile is set', () => {
    const fs = new InMemoryLogFs();
    const deps = composeDeps(makeConfig(), {
      harness: 'fake',
      workspaceRoot: '/repo',
      runId: asRunId('run-log-2'),
      noLogConsole: true,
      noLogFile: true,
      logFs: fs,
    });
    deps.logger?.info('hello');
    expect(fs.files.size).toBe(0);
  });
});
