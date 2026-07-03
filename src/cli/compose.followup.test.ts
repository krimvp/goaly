import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { composeDeps, STATE_DIR } from './compose';
import { drive } from '../driver/driver';
import { readRun } from '../runlog/inspect';
import { compactRun } from '../followup/compaction';
import { makeConfig } from '../testing/fakes';
import { FakeLlm } from '../llm/provider';
import { asRunId, coerceSessionId, type SessionId } from '../domain/ids';
import type { HarnessAdapter } from '../harness/adapter';
import type { HarnessRunResult } from '../domain/events';
import { runProcess } from '../util/spawn';

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'goaly-followup-'));
  await runProcess('git', ['-C', dir, 'init', '-q']);
  await runProcess('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
  await runProcess('git', ['-C', dir, 'config', 'user.name', 'tester']);
  await writeFile(path.join(dir, 'README.md'), '# fixture\n');
  await runProcess('git', ['-C', dir, 'add', '-A']);
  await runProcess('git', ['-C', dir, 'commit', '-qm', 'init']);
  return dir;
}

/** A harness that records the session id it was handed on its first call (to prove inheritance). */
class SessionRecordingHarness implements HarnessAdapter {
  readonly name = 'session-recording';
  readonly seen: (SessionId | undefined)[] = [];
  async run(_prompt: string, sessionId?: SessionId): Promise<HarnessRunResult> {
    this.seen.push(sessionId);
    const id = sessionId ?? coerceSessionId('minted-session', 'minted-session');
    return { output: 'ok', sessionId: id, status: 'completed' };
  }
}

describe('follow-up as a new verifiable goal (Capability C — compose + drive)', () => {
  let dir: string | null = null;
  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('weaves the prior-run compaction into the follow-up compiler feedback and reaches DONE', async () => {
    dir = await initRepo();
    const stateDir = path.join(dir, STATE_DIR);

    // --- prior run to DONE (a plain existing-verifier run) ---
    const priorId = asRunId('run-prior-followup');
    const priorConfig = makeConfig({
      goal: 'establish the baseline behavior',
      verifier: { kind: 'existing', ref: 'true' },
      autonomous: true,
    });
    const priorOutcome = await drive(
      composeDeps(priorConfig, {
        harness: 'fake',
        workspaceRoot: dir,
        runId: priorId,
        noLogConsole: true,
        llm: new FakeLlm(['{"veto": false}']),
      }),
      priorConfig,
      priorId,
    );
    expect(priorOutcome.status).toBe('DONE');

    // --- build the compaction from the recovered prior detail ---
    const prior = await readRun(stateDir, priorId);
    expect(prior?.ok).toBe(true);
    if (prior === null || !prior.ok) throw new Error('prior run not readable');
    const seed = compactRun(prior.detail);

    // --- follow-up run: generate so the compiler authors with the seed as feedback ---
    const followId = asRunId('run-follow');
    const followConfig = makeConfig({
      goal: 'now also handle empty input',
      verifier: { kind: 'generate', intent: 'add a check' },
      rubric: 'empty input is handled',
      autonomous: true,
      judge: { quorum: 1 },
    });
    const followLlm = new FakeLlm([
      '{"command":"printf ok","rubric":"empty input is handled"}', // compiler authors the new bar
      '{"buildAndUse":false,"targetArtifact":null,"reason":"n/a"}', // usage-gate shape classification
      '{"pass":true,"confidence":1,"failing_criteria":[]}', // judge rung
      '{"veto":false}', // Sign-off approver
    ]);
    const followOutcome = await drive(
      composeDeps(followConfig, {
        harness: 'fake',
        workspaceRoot: dir,
        runId: followId,
        noLogConsole: true,
        followupSeed: seed,
        llm: followLlm,
      }),
      followConfig,
      followId,
    );

    // The new run compiled its OWN frozen contract and reached a terminal state.
    expect(followOutcome.status).toBe('DONE');
    expect(followOutcome.contractHash).not.toBeNull();
    // It is a DIFFERENT contract than the prior run's (a fresh freeze, not a reuse).
    expect(followOutcome.contractHash).not.toBe(priorOutcome.contractHash);

    // The compaction was present in the authoring feedback (the compiler is the first LLM call).
    const compilePrompt = followLlm.requests[0]?.prompt ?? '';
    expect(compilePrompt).toContain(`Prior run context (run ${priorId})`);
    expect(compilePrompt).toContain('establish the baseline behavior');
  });

  it('seeds the first agent turn with the inherited session id (Capability C — --inherit-session)', async () => {
    dir = await initRepo();
    const harness = new SessionRecordingHarness();
    const config = makeConfig({
      goal: 'continue with memory',
      verifier: { kind: 'existing', ref: 'true' },
      autonomous: true,
      seedSessionId: 'prior-real-session' as never,
    });
    const runId = asRunId('run-inherit');
    const base = composeDeps(config, {
      harness: 'fake',
      workspaceRoot: dir,
      runId,
      noLogConsole: true,
      llm: new FakeLlm(['{"veto": false}']),
    });
    const outcome = await drive({ ...base, harness }, config, runId);

    expect(outcome.status).toBe('DONE');
    // The FIRST agent turn resumed the inherited session (instead of a fresh, undefined one).
    expect(harness.seen[0]).toBe('prior-real-session');
  });
});
