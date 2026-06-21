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
});
