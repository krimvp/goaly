import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeDeps } from './compose';
import { drive } from '../driver/driver';
import { makeConfig } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import { asRunId } from '../domain/ids';
import { runProcess } from '../util/spawn';

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
        { text: '{"command":"true","rubric":"is it done"}', tokensUsed: 800 },
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
    expect(usage?.compiler).toEqual({ tokens: 800, calls: 1, unknownCalls: 0 });
    expect(usage?.verifier).toEqual({ tokens: 1200, calls: 1, unknownCalls: 0 });
    expect(usage?.approver).toEqual({ tokens: 400, calls: 1, unknownCalls: 0 });
    expect(usage?.llm.tokens).toBe(2400);
    expect(usage?.total.tokens).toBe(2400);

    // The compiler's 800 LLM tokens are recorded into the budget BEFORE the agent runs, so the
    // --budget-tokens cap governs total spend (harness + LLM steps), not just the harness.
    const stored = await deps.runlog.read();
    const ran = stored?.entries.find((e) => e.event.tag === 'AGENT_RAN');
    expect(ran?.event.tag).toBe('AGENT_RAN');
    if (ran?.event.tag === 'AGENT_RAN') {
      expect(ran.event.budget.tokensSpent).toBe(800);
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
      { text: '{"command":"true","rubric":"is it done"}', tokensUsed: 800 },
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
    expect(resumed.usage?.total.tokens).toBe(2400);
  });
});
