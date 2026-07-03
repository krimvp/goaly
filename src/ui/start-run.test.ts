import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeUiActions, startArgv, resumeArgv, type UiActions } from './start-run';
import { SessionStore } from './sessions';
import { UiGates } from './ui-gates';
import { makeFakeContract } from '../testing/fakes';
import { sha256Hex } from '../util/hash';
import { asRunId } from '../domain/ids';

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
}

describe('argv builders (the UI request → the SAME CLI parse path)', () => {
  it('startArgv maps the request onto --flag=value tokens', () => {
    const argv = startArgv(
      {
        goal: 'do the thing',
        verifyCmd: 'npm test',
        harness: 'fake',
        autonomous: true,
        maxIterations: 3,
        model: 'm1',
      },
      '/ws',
    );
    expect(argv).toEqual([
      'run',
      '--goal=do the thing',
      '--workspace=/ws',
      '--verify-cmd=npm test',
      '--harness=fake',
      '--autonomous',
      '--max-iterations=3',
      '--model=m1',
    ]);
  });

  it('resumeArgv carries only the extension flags the request names (ADR 0012)', () => {
    const argv = resumeArgv('run-x', { note: 'hint', maxIterations: 9 }, '/ws', 'fake');
    expect(argv).toContain('--resume=run-x');
    expect(argv).toContain('--note=hint');
    expect(argv).toContain('--max-iterations=9');
    expect(argv).toContain('--harness=fake');
    expect(argv.some((a) => a.startsWith('--budget-tokens'))).toBe(false);
  });
});

describe('makeUiActions — in-process UI-owned runs (fake harness, zero LLM)', () => {
  let root: string;
  let sessions: SessionStore;
  let actions: UiActions;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'goaly-ui-actions-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test User');
    await writeFile(join(root, 'f.txt'), 'x\n');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
    sessions = new SessionStore();
    actions = makeUiActions({ workspaceRoot: root, sessions });
  });

  afterEach(async () => {
    actions.shutdown();
    // Let any still-live run unwind before deleting its tree (rm racing a writer is flaky).
    await Promise.all(sessions.all().map((s) => s.done.catch(() => {})));
    await rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** Wait until the run's gate parks (compile is fast but async). */
  async function waitForGate(runId: string): Promise<NonNullable<ReturnType<UiActions['pendingGate']>>> {
    for (let i = 0; i < 200; i++) {
      const gate = actions.pendingGate(runId);
      if (gate !== undefined && gate !== null) return gate;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('gate never parked');
  }

  /** Await the run settling, tolerating the session having already been cleaned up. */
  async function waitSettled(runId: string): Promise<void> {
    const session = sessions.get(runId);
    if (session !== undefined) await session.done.catch(() => {});
  }

  it('start (non-autonomous) parks at the browser Seal; approve turns the key and the run proceeds', { timeout: 30000 }, async () => {
    const started = await actions.start({
      goal: 'g',
      verifyCmd: 'false', // a red deterministic bar: never reaches Sign-off ⇒ zero LLM
      harness: 'fake',
      autonomous: false,
      maxIterations: 2,
    });
    expect(started.ok).toBe(true);
    const runId = started.ok ? started.runId : '';

    const gate = await waitForGate(runId);
    const done = sessions.get(runId)!.done; // grab BEFORE resolving — the store cleans up on settle
    expect(gate.kind).toBe('seal');
    expect(await actions.resolveGate(runId, gate.gateId, { decision: 'approve' })).toBe('ok');

    const result = await done;
    expect(result.code).toBe(1); // red bar → no-diff ABORTED (the outcome isn't the point; the gate is)

    // The log carries the REAL seal decision — the browser gate is a gate implementation, not a bypass.
    const log = await readFile(join(root, '.goaly', runId, 'log.jsonl'), 'utf8');
    expect(log).toContain('"tag":"SEAL_DECIDED"');
    expect(log).toContain('"kind":"approve"');
  });

  it('a second start in the SAME root is refused 409 while the first is live; a worktree is fine', { timeout: 30000 }, async () => {
    const first = await actions.start({
      goal: 'g',
      verifyCmd: 'false',
      harness: 'fake',
      autonomous: false,
    });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.runId : '';
    await waitForGate(firstId); // parked ⇒ definitely live

    const clash = await actions.start({ goal: 'g2', verifyCmd: 'false', harness: 'fake', autonomous: false });
    expect(clash).toMatchObject({ ok: false, status: 409 });
    expect(clash.ok === false ? clash.error : '').toContain('worktree');

    const inWorktree = await actions.start({
      goal: 'g3',
      verifyCmd: 'false',
      harness: 'fake',
      autonomous: true,
      maxIterations: 1,
      worktree: { name: 'side' },
    });
    expect(inWorktree.ok).toBe(true);
    const wtRunId = inWorktree.ok ? inWorktree.runId : '';
    await waitSettled(wtRunId);
    // The worktree run's state landed under the WORKTREE, not the main root.
    expect(existsSync(join(root, '.goaly', 'worktrees', 'side', '.goaly', wtRunId))).toBe(true);

    actions.stop(firstId);
    await waitSettled(firstId);
  });

  it('stop while parked at the Seal rejects the gate and the run unwinds (still resumable state)', { timeout: 30000 }, async () => {
    const started = await actions.start({ goal: 'g', verifyCmd: 'false', harness: 'fake', autonomous: false });
    const runId = started.ok ? started.runId : '';
    await waitForGate(runId);
    const done = sessions.get(runId)!.done;

    expect(actions.stop(runId)).toBe(true);
    const result = await done;
    expect(result.outcome?.status).toBe('ABORTED');
    // Not UI-owned any more once settled.
    expect(actions.stop(runId)).toBe(false);
    expect(actions.pendingGate(runId)).toBeNull();
  });

  it('resolveGate: unknown run → no-session; stale gateId → stale (double-submit guard)', { timeout: 30000 }, async () => {
    expect(await actions.resolveGate('run-none', 'x', { decision: 'approve' })).toBe('no-session');
    const started = await actions.start({ goal: 'g', verifyCmd: 'false', harness: 'fake', autonomous: false });
    const runId = started.ok ? started.runId : '';
    await waitForGate(runId);
    expect(await actions.resolveGate(runId, 'stale-id', { decision: 'approve' })).toBe('stale');
    actions.stop(runId);
    await waitSettled(runId);
  });

  it('resume continues an aborted run with a note + stuck override (RUN_EXTENDED in the log)', { timeout: 30000 }, async () => {
    const started = await actions.start({
      goal: 'g',
      verifyCmd: 'false',
      harness: 'fake',
      autonomous: true, // zero pauses: red bar → no-diff ABORTED after iteration 1
      maxIterations: 2,
    });
    const runId = started.ok ? started.runId : '';
    await waitSettled(runId);

    const resumed = await actions.resume(runId, { note: 'try f.txt', stuckNoDiff: false });
    expect(resumed.ok).toBe(true);
    await waitSettled(runId);

    const log = await readFile(join(root, '.goaly', runId, 'log.jsonl'), 'utf8');
    expect(log).toContain('"tag":"RUN_EXTENDED"');
    expect(log).toContain('try f.txt');
    // Revived past the no-diff abort: iteration 2 ran (a second AGENT_RAN landed).
    expect(log.split('"tag":"AGENT_RAN"').length - 1).toBe(2);
  });

  it('gate files + drift check: read, edit, allowlist, and the approve-time 409 (ADR 0016)', async () => {
    // A synthetic parked SEAL session over a real temp checkout — the file actions and the drift
    // check are exercised without an LLM compile (generatedFiles never arise from --verify-cmd).
    const content = 'test("gen", () => {})';
    await writeFile(join(root, 'gen.test.mjs'), content);
    const contract = makeFakeContract({
      generatedFiles: [{ path: 'gen.test.mjs', sha256: sha256Hex(content) }],
    });
    const gates = new UiGates();
    const parked = gates.approveContract(contract); // parks the seal gate
    const gateId = gates.pending()!.gateId;
    sessions.register({
      runId: asRunId('run-synthetic'),
      root: { kind: 'main' },
      rootPath: root,
      startedAt: 1,
      gates,
      stop: () => gates.stop(),
      stopRequested: () => false,
      done: parked.then(() => ({ code: 0, runId: asRunId('run-synthetic'), outcome: undefined })),
    });

    // GET: clean content, not dirty.
    const files = await actions.gateFiles('run-synthetic', gateId);
    expect(files).toMatchObject({
      gateId,
      files: [{ path: 'gen.test.mjs', content, dirty: false, truncated: false }],
    });
    expect(await actions.gateFiles('run-none', gateId)).toBe('no-session');
    expect(await actions.gateFiles('run-synthetic', 'stale')).toBe('stale');

    // PUT: allowlisted path writes through the guarded writer; others refuse.
    const written = await actions.writeGateFile('run-synthetic', gateId, {
      path: 'gen.test.mjs',
      content: 'test("gen", () => { expect(1).toBe(1) })',
    });
    expect(written).toMatchObject({ written: 'gen.test.mjs' });
    expect(
      await actions.writeGateFile('run-synthetic', gateId, { path: 'f.txt', content: 'hijack' }),
    ).toBe('bad-path');

    // The file is now DIRTY vs the frozen pin — approve refuses 409-style with the path named.
    const drift = await actions.resolveGate('run-synthetic', gateId, { decision: 'approve' });
    expect(drift).toEqual({ drifted: ['gen.test.mjs'] });
    expect(gates.pending()?.gateId).toBe(gateId); // still parked

    // `edited` resolves the gate (the run would refreeze); the drift is the operator's edit.
    expect(await actions.resolveGate('run-synthetic', gateId, { decision: 'edited' })).toBe('ok');
    await expect(parked).resolves.toEqual({ kind: 'edited' });
  });

  it('resume 404s an unknown run and refuses a bad start request with the guard text', { timeout: 30000 }, async () => {
    expect(await actions.resume('run-none', {})).toMatchObject({ ok: false, status: 404 });
    const bad = await actions.start({
      goal: 'g',
      verifyCmd: 'true',
      harness: 'fake',
      autonomous: true,
      worktree: { name: 'x', base: 'no-such-ref' },
    });
    expect(bad).toMatchObject({ ok: false, status: 422 });
  });
});
