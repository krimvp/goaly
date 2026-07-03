import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeDeps } from './compose';
import { drive } from '../driver/driver';
import { makeConfig } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import { asRunId, coerceSessionId, type SessionId } from '../domain/ids';
import type { HarnessAdapter } from '../harness/adapter';
import type { HarnessRunResult } from '../domain/events';
import { runProcess } from '../util/spawn';

/**
 * A harness that mimics the glm/kimi failure (follow-ons E/F): iteration 1 hits the turn cap and
 * makes NO edit (status `truncated`, no diff); iteration 2 writes the implementation and `completed`s.
 * Proves a truncated no-diff is not read as "stuck" and the run gets its next, productive iteration.
 */
class TruncateThenBuildHarness implements HarnessAdapter {
  readonly name = 'truncate-then-build';
  #call = 0;
  constructor(
    private readonly dir: string,
    private readonly implFile: string,
  ) {}
  async run(_prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    this.#call += 1;
    const id = sessionId ?? coerceSessionId('scripted-session', 'scripted-session');
    if (this.#call === 1) {
      // Hit the turn cap mid-work before producing a usable diff (glm/kimi: status=truncated changed=false).
      return { output: 'ran out of turns before finishing', sessionId: id, status: 'truncated' };
    }
    // Iteration 2: actually build the thing — a net diff that satisfies the deterministic rung.
    await writeFile(path.join(this.dir, this.implFile), 'built\n');
    return { output: 'wrote the implementation', sessionId: id, status: 'completed' };
  }
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'goaly-cli-'));
  await runProcess('git', ['-C', dir, 'init', '-q']);
  await runProcess('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await runProcess('git', ['-C', dir, 'config', 'user.name', 'tester']);
  await writeFile(path.join(dir, 'README.md'), '# fixture\n');
  await runProcess('git', ['-C', dir, 'add', '-A']);
  await runProcess('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}

describe('CLI pipeline (compose + drive) — real git workspace, faked agent/LLM', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('DONE on iteration 1 when the verifier passes and the approver does not veto', async () => {
    dir = await initRepo();
    const config = makeConfig({
      goal: 'keep it green',
      verifier: { kind: 'existing', ref: 'true' },
      autonomous: true,
    });
    const runId = asRunId('run-cli-1');
    const deps = composeDeps(config, {
      harness: 'fake',
      workspaceRoot: dir,
      runId,
      noLogConsole: true,
      llm: new FakeLlm(['{"veto": false}']),
    });

    const outcome = await drive(deps, config, runId);

    expect(outcome.status).toBe('DONE');
    expect(outcome.iterations).toBe(1);
    expect(outcome.contractHash).not.toBeNull();
  });

  it('ABORTED via no-diff (proves the .goaly state dir is excluded from the tree hash)', async () => {
    dir = await initRepo();
    const config = makeConfig({
      goal: 'impossible with a noop agent',
      verifier: { kind: 'existing', ref: 'false' },
      autonomous: true,
      maxIterations: 5,
    });
    const runId = asRunId('run-cli-2');
    const deps = composeDeps(config, {
      harness: 'fake',
      workspaceRoot: dir,
      runId,
      noLogConsole: true,
      llm: new FakeLlm(['{"veto":true,"reason":"nope"}']),
    });

    const outcome = await drive(deps, config, runId);

    // The noop agent never changes the tree; if .goaly run-log writes leaked into the hash,
    // no-diff could never fire and this would be FAILED-at-maxIterations instead.
    expect(outcome.status).toBe('ABORTED');
    expect(outcome.reason).toContain('no-diff');
  });

  it('aggregates token spend by layer — compiler, judge, approver — and harness "unknown"', async () => {
    dir = await initRepo();
    // Generate the verifier (compiler LLM call), keep a rubric (judge rung), quorum 1 so exactly
    // one judge call lands. The single shared FakeLlm answers compiler → judge → approver in order.
    const config = makeConfig({
      goal: 'reportable spend',
      verifier: { kind: 'generate', intent: 'check it' },
      rubric: 'is it done',
      autonomous: true,
      judge: { quorum: 1 },
    });
    const runId = asRunId('run-cli-usage');
    const deps = composeDeps(config, {
      harness: 'fake',
      workspaceRoot: dir,
      runId,
      noLogConsole: true,
      llm: new FakeLlm([
        { text: '{"command":"printf ok","rubric":"is it done"}', tokensUsed: 800 },
        // usage-gate shape classification (a second compile-phase call, metered under the compiler).
        { text: '{"buildAndUse":false,"targetArtifact":null,"reason":"n/a"}', tokensUsed: 100 },
        { text: '{"pass":true,"confidence":1,"failing_criteria":[]}', tokensUsed: 1200 },
        { text: '{"veto":false}', tokensUsed: 400 },
      ]),
    });

    const outcome = await drive(deps, config, runId);

    expect(outcome.status).toBe('DONE');
    const usage = outcome.usage;
    expect(usage).toBeDefined();
    // Harness is the noop fake → one call, tokens unknown (not zero).
    expect(usage?.harness).toEqual({ tokens: 0, calls: 1, unknownCalls: 1 });
    // Compiler layer = authoring (800) + the usage-gate shape classification (100).
    expect(usage?.compiler).toEqual({ tokens: 900, calls: 2, unknownCalls: 0 });
    expect(usage?.verifier).toEqual({ tokens: 1200, calls: 1, unknownCalls: 0 });
    expect(usage?.approver).toEqual({ tokens: 400, calls: 1, unknownCalls: 0 });
    expect(usage?.llm.tokens).toBe(2500);
    expect(usage?.total.tokens).toBe(2500);

    // The compiler's 900 LLM tokens (authoring + shape) are recorded into the budget BEFORE the agent
    // runs, so the --budget-tokens cap governs total spend (harness + LLM steps), not just the harness.
    const stored = await deps.runlog.read();
    const ran = stored?.entries.find((e) => e.event.tag === 'AGENT_RAN');
    expect(ran?.event.tag).toBe('AGENT_RAN');
    if (ran?.event.tag === 'AGENT_RAN') {
      expect(ran.event.budget.tokensSpent).toBe(900);
    }
  });

  it('rebuilds the same spend report from the log alone on --resume', async () => {
    dir = await initRepo();
    const config = makeConfig({
      goal: 'reportable spend',
      verifier: { kind: 'generate', intent: 'check it' },
      rubric: 'is it done',
      autonomous: true,
      judge: { quorum: 1 },
    });
    const runId = asRunId('run-cli-usage-resume');
    const llmScript = [
      { text: '{"command":"printf ok","rubric":"is it done"}', tokensUsed: 800 },
      { text: '{"buildAndUse":false,"targetArtifact":null,"reason":"n/a"}', tokensUsed: 100 },
      { text: '{"pass":true,"confidence":1,"failing_criteria":[]}', tokensUsed: 1200 },
      { text: '{"veto":false}', tokensUsed: 400 },
    ];
    const first = await drive(
      composeDeps(config, {
        harness: 'fake',
        workspaceRoot: dir,
        runId,
        noLogConsole: true,
        llm: new FakeLlm(llmScript),
      }),
      config,
      runId,
    );

    // Resume the already-completed run: no perform() runs, so the report must come from the log.
    const resumed = await drive(
      composeDeps(config, {
        harness: 'fake',
        workspaceRoot: dir,
        runId,
        noLogConsole: true,
        llm: new FakeLlm(['unused']),
      }),
      config,
      runId,
      { resume: true },
    );

    expect(resumed.status).toBe('DONE');
    expect(resumed.usage).toEqual(first.usage);
    expect(resumed.usage?.total.tokens).toBe(2500);
  });

  it('threads --baseline through to the workspace diff (issue #47)', async () => {
    dir = await initRepo();
    const firstSha = (await runProcess('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
    // Advance HEAD so there is a difference between the first commit and the working tree.
    await writeFile(path.join(dir, 'README.md'), '# fixture v2\n');
    await runProcess('git', ['-C', dir, 'commit', '-qam', 'v2']);

    const config = makeConfig({ goal: 'g', verifier: { kind: 'existing', ref: 'true' }, autonomous: true });
    // No baseline ⇒ diff() is against HEAD (the working tree is clean) ⇒ empty.
    const def = composeDeps(config, { harness: 'fake', workspaceRoot: dir, runId: asRunId('run-bl-default'), noLogConsole: true });
    expect(await def.workspace.diff()).toBe('');

    // baseline = the first commit ⇒ diff() now shows the README change introduced by v2.
    const based = composeDeps(config, {
      harness: 'fake',
      workspaceRoot: dir,
      runId: asRunId('run-bl-set'),
      noLogConsole: true,
      baseline: firstSha,
    });
    const diff = await based.workspace.diff();
    expect(diff).toContain('README.md');
    expect(diff).toContain('fixture v2');
  });

  it('from-scratch --generate --autonomous converges after a truncated no-diff iteration (A+B+E+F synergy)', async () => {
    dir = await initRepo();
    // An autonomous, self-authored from-scratch run: the compiler authors a setup + a deterministic
    // build/test rung + a judge rung. The shared FakeLlm answers, in order: compiler authoring → the
    // judge rung (iteration 2 only — iteration 1's deterministic rung is red and short-circuits the
    // ladder) → the Sign-off approver. The authored setup fails on the empty tree (no go.mod), which,
    // being COMPILER-authored, degrades to best-effort proceed (Fix A) instead of a fatal SETUP_FAILED;
    // the deterministic pre-flight is red on the from-scratch tree but proceeds rather than aborting
    // CONTRACT_UNSOUND (Fix B).
    const config = makeConfig({
      goal: 'build it from scratch',
      verifier: { kind: 'generate', intent: 'make impl.txt' },
      rubric: 'is it built',
      autonomous: true,
      judge: { quorum: 1 },
      maxIterations: 5,
    });
    const runId = asRunId('run-cli-truncate-converge');
    const base = composeDeps(config, {
      harness: 'fake',
      workspaceRoot: dir,
      runId,
      noLogConsole: true,
      llm: new FakeLlm([
        // compiler: a build/test bar (red until impl.txt exists) + a from-scratch-failing authored setup.
        '{"command":"test -f impl.txt","rubric":"is it built","setup":"test -f go.mod"}',
        // usage-gate shape classification (not build-and-use → the gate is a no-op here).
        '{"buildAndUse":false,"targetArtifact":null,"reason":"n/a"}',
        // judge rung (only reached on iteration 2, once the deterministic rung is green).
        '{"pass":true,"confidence":1,"failing_criteria":[]}',
        // Sign-off approver: the second key does not veto.
        '{"veto":false}',
      ]),
    });
    // Swap in the scripted worker: NoopHarness can't model truncated-then-build.
    const deps = { ...base, harness: new TruncateThenBuildHarness(dir, 'impl.txt') };

    const outcome = await drive(deps, config, runId);

    // Not killed in prepare (A/B), not aborted at the iteration-1 truncated no-diff (F): it took the
    // second iteration to actually build, then reached DONE within --max-iterations.
    expect(outcome.status).toBe('DONE');
    expect(outcome.iterations).toBe(2);
    expect(outcome.contractHash).not.toBeNull();

    // The log shows iteration 1 was a truncated run that changed nothing, yet the run continued.
    const stored = await deps.runlog.read();
    const firstRun = stored?.entries.find((e) => e.event.tag === 'AGENT_RAN');
    expect(firstRun?.event.tag).toBe('AGENT_RAN');
    if (firstRun?.event.tag === 'AGENT_RAN') {
      expect(firstRun.event.run.status).toBe('truncated');
    }
  });
});
