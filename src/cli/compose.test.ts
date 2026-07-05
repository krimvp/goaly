import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { composeDeps, makeLlmProvider, buildLadder } from './compose';
import { codexCodec } from '../agent-cli/codex-codec';
import { droidCodec } from '../agent-cli/droid-codec';
import { piCodec } from '../agent-cli/pi-codec';
import { makeConfig, makeFakeContract, InMemoryLogFs, passVerdict } from '../testing/fakes';
import { sha256Hex } from '../util/hash';
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

  it('an injected sealGate/planGate (ADR 0015) wins over the autonomous switch; absent ⇒ unchanged', () => {
    class MyGate {
      approveContract = async (): Promise<{ kind: 'approve' }> => ({ kind: 'approve' });
      approvePlan = async (): Promise<{ kind: 'approve' }> => ({ kind: 'approve' });
    }
    const gate = new MyGate();
    const injected = composeDeps(
      makeConfig({ phased: true, autonomous: true }),
      opts({ sealGate: gate, planGate: gate }),
    );
    expect(injected.seal).toBe(gate);
    expect(injected.planGate).toBe(gate);
    // Absent ⇒ the classic selection is untouched.
    const classic = composeDeps(makeConfig({ autonomous: true }), opts());
    expect(classic.seal.constructor.name).toBe('AutoSealGate');
    expect(composeDeps(makeConfig(), opts()).seal.constructor.name).toBe('HumanSealGate');
  });
});

describe('composeDeps — per-reviewer approver models (follow-up to issue #84)', () => {
  const baseInput = {
    goal: 'g',
    rubric: 'r',
    diff: 'diff --git a/x b/x',
    verdicts: [passVerdict('green')],
  };
  // A FakeLlm with a no-veto completion that reports tokens so we can confirm the panel's spend is
  // metered through the SHARED meter (the approver layer — no new spend category).
  const noVetoWithTokens = { text: '{"veto": false}', tokensUsed: 100 };
  const opts = (over: Record<string, unknown> = {}) => ({
    harness: 'fake' as const,
    workspaceRoot: '/tmp/x',
    runId: asRunId('run-mm'),
    noLogConsole: true,
    logFs: new InMemoryLogFs(),
    ...over,
  });

  it('builds a per-reviewer panel that defaults the quorum to the model count', async () => {
    // Three models, no --approver-quorum ⇒ the panel makes one call per model (quorum = 3). A veto
    // first keeps the outcome mathematically open so all three reviewers are actually polled.
    const vetoWithTokens = { text: '{"veto": true, "reason": "keep the panel open"}', tokensUsed: 100 };
    const llm = new FakeLlm([vetoWithTokens, noVetoWithTokens, noVetoWithTokens]);
    const deps = composeDeps(
      makeConfig(),
      opts({ llm, models: { approverModels: ['a', 'b', 'c'] } }),
    );

    const verdict = await deps.approver.review(baseInput);

    expect(verdict.veto).toBe(false);
    expect(llm.requests).toHaveLength(3);
    // All three reviewer calls are attributed to the approver layer via the shared meter.
    expect(deps.llmMeter?.take().calls).toBe(3);
  });

  it('cycles the panel when --approver-quorum exceeds the model count', async () => {
    // Interleave vetoes so the 5-vote outcome stays open until the last reviewer (no early exit).
    const vetoWithTokens = { text: '{"veto": true, "reason": "keep the panel open"}', tokensUsed: 100 };
    const llm = new FakeLlm([
      vetoWithTokens,
      noVetoWithTokens,
      vetoWithTokens,
      noVetoWithTokens,
      noVetoWithTokens,
    ]);
    const deps = composeDeps(
      makeConfig({ approver: { quorum: 5 } }),
      opts({ llm, models: { approverModels: ['a', 'b'] } }),
    );

    await deps.approver.review(baseInput);

    expect(llm.requests).toHaveLength(5);
  });

  it('without --approver-models the approver stays the single-model path (quorum 1 single call)', async () => {
    const llm = new FakeLlm([noVetoWithTokens]);
    const deps = composeDeps(makeConfig(), opts({ llm }));

    await deps.approver.review(baseInput);

    expect(llm.requests).toHaveLength(1);
    expect(llm.requests[0]?.temperature).toBe(0);
  });
});

describe('composeDeps — makeLadder surfaces the authored bar in the judge/approver diff', () => {
  // End-to-end wiring pin for the false-veto deadlock fix: makeLadder(contract) must register the
  // frozen authored verification files on the real wired workspace so the diff the two LLM keys
  // review includes the bar — even though it's git-excluded (issue #52) from the user's git status.
  function gitInit(cwd: string): void {
    for (const args of [
      ['init', '-q'],
      ['config', 'user.email', 'test@example.com'],
      ['config', 'user.name', 'Test User'],
    ]) {
      const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    }
  }

  it('a generated contract makes its git-excluded test file visible to diff() after makeLadder', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'goaly-compose-bar-'));
    try {
      gitInit(root);
      const testContent = "import { test } from 'node:test';\ntest('ok', () => {});\n";
      await writeFile(path.join(root, 'expr.test.mjs'), testContent);
      await writeFile(path.join(root, 'expr.mjs'), 'export const evaluate = () => 42;\n');
      // Exclude the authored bar from git exactly as goaly does (issue #52).
      await mkdir(path.join(root, '.git', 'info'), { recursive: true });
      await writeFile(path.join(root, '.git', 'info', 'exclude'), '/expr.test.mjs\n');

      const deps = composeDeps(
        makeConfig(),
        {
          harness: 'fake' as const,
          workspaceRoot: root,
          runId: asRunId('run-bar'),
          llm: new FakeLlm(['{}']),
          noLogConsole: true,
          logFs: new InMemoryLogFs(),
        },
      );

      // Before makeLadder: the excluded bar is hidden (the false-veto cause).
      expect(await deps.workspace.diff()).not.toContain('expr.test.mjs');

      // makeLadder with a contract that authored the test file must surface it.
      const contract = makeFakeContract({
        generatedFiles: [{ path: 'expr.test.mjs', sha256: sha256Hex(testContent) }],
      });
      deps.makeLadder(contract);

      const diff = await deps.workspace.diff();
      expect(diff).toContain('expr.test.mjs');
      expect(diff).toContain("test('ok'"); // the CONTENT the judge needs, not just the name
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      setDiffIncludes() {},
      currentBaseline() {
        return 'HEAD';
      },
      async run(command, opts) {
        calls.push(opts !== undefined ? { command, opts } : { command });
        return result;
      },
      async readFile() {
        return null;
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

  it('appends the --adversarial refuter rung AFTER the frozen rungs; it can only fail a green', async () => {
    const contract = freezeContract({
      goal: 'g',
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      rubric: 'r',
      generatedFiles: [],
    });
    const refuterLlm = new FakeLlm([
      JSON.stringify({ refuted: true, confidence: 0.9, reason: 'hard-coded output' }),
    ]);
    const ladder = buildLadder(contract, new FakeLlm([]), undefined, {
      llm: refuterLlm,
      refuters: 3,
    });
    const { workspace, calls } = spyWorkspace(); // deterministic rung greens (exit 0)

    const verdict = await ladder.verify(workspace, 'g', 'r');

    // The frozen rung ran and passed; the appended refuter panel then refuted the green. With
    // every scripted vote a refutation, the red is settled after 2 of 3 votes (early exit).
    expect(calls).toEqual([{ command: 'npm test' }]);
    expect(refuterLlm.requests).toHaveLength(2);
    expect(verdict.pass).toBe(false);
    expect(verdict.detail).toContain('hard-coded output');
    // The frozen bar itself passed — the depth score shows the short-circuit at the refuter rung.
    expect(verdict.rungsPassed).toBe(1);
    expect(verdict.rungsTotal).toBe(2);
  });

  it('never consults the refuters when a frozen rung is already red (short-circuit)', async () => {
    const contract = freezeContract({
      goal: 'g',
      // fileHash() → null in the spy workspace, so the guard fails closed before anything runs.
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      rubric: 'r',
      generatedFiles: [{ path: 'authored.test.ts', sha256: 'a'.repeat(64) }],
    });
    const refuterLlm = new FakeLlm([]);
    const ladder = buildLadder(contract, new FakeLlm([]), undefined, {
      llm: refuterLlm,
      refuters: 3,
    });
    const { workspace } = spyWorkspace();

    const verdict = await ladder.verify(workspace, 'g', 'r');

    expect(verdict.pass).toBe(false);
    expect(refuterLlm.requests).toHaveLength(0); // refuter spend only on candidate greens
  });

  it('builds no refuter rung without the adversarial option (byte-for-byte default ladder)', async () => {
    const contract = freezeContract({
      goal: 'g',
      rungs: [{ kind: 'deterministic', command: 'npm test' }],
      rubric: 'r',
      generatedFiles: [],
    });
    const ladder = buildLadder(contract, new FakeLlm([]));
    const { workspace } = spyWorkspace();

    const verdict = await ladder.verify(workspace, 'g', 'r');

    expect(verdict.pass).toBe(true);
    expect(verdict.rungsTotal).toBe(1); // exactly the frozen rung — no appended rung
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
