import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { route, type RouterCtx } from './router';
import type { RunListItem, RunReadResult, RunSummary, RunDetail } from '../runlog/inspect';
import { RunId, ContractHash } from '../domain/ids';
import type { WorktreeInfo } from '../workspace/worktree-manager';

const summary = (runId: string, overrides: Partial<RunSummary> = {}): RunSummary => ({
  runId: RunId.parse(runId),
  goal: 'g',
  status: 'DONE',
  stateTag: 'DONE',
  iterations: 1,
  tokensSpent: 10,
  startedAt: 1,
  endedAt: 2,
  contractHash: ContractHash.parse('c'.repeat(64)),
  ...overrides,
});

const detail = (runId: string): RunDetail => ({
  runId: RunId.parse(runId),
  goal: 'g',
  status: 'DONE',
  stateTag: 'DONE',
  reason: undefined,
  harness: 'fake',
  sessionId: undefined,
  startedAt: 1,
  endedAt: 2,
  iterations: 1,
  tokensSpent: 10,
  usage: {
    harness: { tokens: 0, calls: 0, unknownCalls: 0 },
    compiler: { tokens: 0, calls: 0, unknownCalls: 0 },
    verifier: { tokens: 0, calls: 0, unknownCalls: 0 },
    approver: { tokens: 0, calls: 0, unknownCalls: 0 },
    llm: { tokens: 0, calls: 0, unknownCalls: 0 },
    total: { tokens: 0, calls: 0, unknownCalls: 0 },
    budget: { spent: 0, exceeded: false },
  },
  contract: null,
  contractHash: null,
  plan: null,
  planSeal: [],
  planFailures: [],
  compileFailures: [],
  seal: [],
  prepare: undefined,
  iterationsDetail: [],
});

const worktree = (name: string): WorktreeInfo => ({
  name,
  path: `/ws/.goaly/worktrees/${name}`,
  branch: `goaly/${name}`,
  head: 'abcd1234',
  dirty: false,
  runs: 1,
  prunable: false,
});

/** A scripted router context: run data keyed by state dir. */
function makeCtx(opts: {
  runsByStateDir?: Record<string, RunListItem[]>;
  readByStateDir?: Record<string, Record<string, RunReadResult>>;
  worktrees?: WorktreeInfo[];
  live?: Set<string>;
}): RouterCtx {
  return {
    workspaceRoot: '/ws',
    version: { name: 'goaly', version: 'test' },
    inspect: {
      listRuns: async (stateDir) => opts.runsByStateDir?.[stateDir] ?? [],
      readRun: async (stateDir, runId) => opts.readByStateDir?.[stateDir]?.[runId] ?? null,
    },
    isActive: async (runDir) => opts.live?.has(runDir) ?? false,
    listWorktrees: async () => opts.worktrees ?? [],
  };
}

const q = new URLSearchParams();

describe('route — the goaly ui API', () => {
  it('GET /api/version returns the package identity', async () => {
    const res = await route(makeCtx({}), 'GET', '/api/version', q);
    expect(res).toEqual({ kind: 'json', status: 200, body: { name: 'goaly', version: 'test' } });
  });

  it('GET /api/runs indexes runs across the main root AND every worktree, with live badges', async () => {
    const mainDir = join('/ws', '.goaly');
    const wtDir = join('/ws/.goaly/worktrees/feat', '.goaly');
    const ctx = makeCtx({
      worktrees: [worktree('feat')],
      runsByStateDir: {
        [mainDir]: [{ ok: true, summary: summary('run-a') }],
        [wtDir]: [
          { ok: true, summary: summary('run-b', { status: 'INCOMPLETE', stateTag: 'RUNNING_AGENT' }) },
          { ok: false, runId: 'run-bad', error: 'corrupt line 3' },
        ],
      },
      live: new Set([join(wtDir, 'run-b')]),
    });
    const res = await route(ctx, 'GET', '/api/runs', q);
    expect(res.kind).toBe('json');
    const body = (res as { body: { roots: unknown[] } }).body as {
      roots: Array<{ root: unknown; runs: Array<Record<string, unknown>> }>;
    };
    expect(body.roots).toHaveLength(2);
    expect(body.roots[0]?.root).toEqual({ kind: 'main' });
    expect(body.roots[0]?.runs[0]).toMatchObject({ ok: true, live: false });
    expect(body.roots[1]?.root).toEqual({ kind: 'worktree', name: 'feat' });
    expect(body.roots[1]?.runs[0]).toMatchObject({ ok: true, live: true });
    // Corrupt runs are FLAGGED in the index, never dropped (invariant #6).
    expect(body.roots[1]?.runs[1]).toMatchObject({ ok: false, runId: 'run-bad' });
  });

  it('GET /api/runs/:id finds the run in whichever root holds it', async () => {
    const wtDir = join('/ws/.goaly/worktrees/feat', '.goaly');
    const ctx = makeCtx({
      worktrees: [worktree('feat')],
      readByStateDir: { [wtDir]: { 'run-b': { ok: true, detail: detail('run-b') } } },
    });
    const res = await route(ctx, 'GET', '/api/runs/run-b', q);
    expect(res).toMatchObject({
      kind: 'json',
      status: 200,
      body: { root: { kind: 'worktree', name: 'feat' }, live: false },
    });
  });

  it('404s an unknown run; 409s a corrupt one (flagged, never dropped)', async () => {
    const mainDir = join('/ws', '.goaly');
    const ctx = makeCtx({
      readByStateDir: { [mainDir]: { 'run-bad': { ok: false, runId: 'run-bad', error: 'boom' } } },
    });
    expect(await route(ctx, 'GET', '/api/runs/run-none', q)).toMatchObject({ status: 404 });
    expect(await route(ctx, 'GET', '/api/runs/run-bad', q)).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining('boom') },
    });
  });

  it('400s an invalid run id fail-closed (the schema is also the path-traversal guard)', async () => {
    const ctx = makeCtx({});
    expect(await route(ctx, 'GET', '/api/runs/..%2F..%2Fetc', q)).toMatchObject({ status: 400 });
    expect(await route(ctx, 'GET', `/api/runs/${'x'.repeat(90)}`, q)).toMatchObject({ status: 400 });
  });

  it('GET /api/runs/:id/events resolves the run dir for the SSE layer', async () => {
    const mainDir = join('/ws', '.goaly');
    const ctx = makeCtx({
      readByStateDir: { [mainDir]: { 'run-a': { ok: true, detail: detail('run-a') } } },
    });
    expect(await route(ctx, 'GET', '/api/runs/run-a/events', q)).toEqual({
      kind: 'sse',
      runDir: join(mainDir, 'run-a'),
      runId: 'run-a',
    });
    expect(await route(ctx, 'GET', '/api/runs/run-none/events', q)).toMatchObject({ status: 404 });
  });

  it('GET /api/runs/:id/transcript pages with ?after and 204s when absent', async () => {
    const mainDir = join('/ws', '.goaly');
    const ctx: RouterCtx = {
      ...makeCtx({
        readByStateDir: { [mainDir]: { 'run-a': { ok: true, detail: detail('run-a') } } },
      }),
      readTranscript: async () => [
        { kind: 'message', text: 'a', phase: 'agent', ts: 1 },
        { kind: 'message', text: 'b', phase: 'agent', ts: 2 },
      ],
    };
    expect(await route(ctx, 'GET', '/api/runs/run-a/transcript', new URLSearchParams('after=1'))).toMatchObject({
      status: 200,
      body: { total: 2, entries: [{ text: 'b' }] },
    });
    expect(
      await route(ctx, 'GET', '/api/runs/run-a/transcript', new URLSearchParams('after=nope')),
    ).toMatchObject({ status: 400 });

    const none: RouterCtx = { ...ctx, readTranscript: async () => null };
    expect(await route(none, 'GET', '/api/runs/run-a/transcript', q)).toEqual({ kind: 'empty', status: 204 });
  });

  it('GET /api/worktrees returns the worktree projection', async () => {
    const res = await route(makeCtx({ worktrees: [worktree('feat')] }), 'GET', '/api/worktrees', q);
    expect(res).toMatchObject({ status: 200, body: { worktrees: [{ name: 'feat' }] } });
  });

  it('without actions, state-changing routes answer 503 (read-only server); unknown routes 404', async () => {
    const ctx = makeCtx({});
    expect(await route(ctx, 'POST', '/api/runs', q)).toMatchObject({ status: 503 });
    expect(await route(ctx, 'GET', '/api/nope', q)).toMatchObject({ status: 404 });
    expect(await route(ctx, 'GET', '/', q)).toEqual({ kind: 'static' });
    expect(await route(ctx, 'GET', '/app.js', q)).toEqual({ kind: 'static' });
  });
});

describe('route — interactive routes (ADR 0015), against a scripted UiActions', () => {
  function makeActions(): { actions: import('./start-run').UiActions; calls: string[] } {
    const calls: string[] = [];
    const actions: import('./start-run').UiActions = {
      start: async (req) => {
        calls.push(`start:${req.goal}`);
        return { ok: true, runId: 'run-new' };
      },
      resume: async (runId, req) => {
        calls.push(`resume:${runId}:${req.note ?? ''}`);
        return { ok: true, runId };
      },
      stop: (runId) => {
        calls.push(`stop:${runId}`);
        return runId === 'run-live';
      },
      pendingGate: (runId) =>
        runId === 'run-live'
          ? { gateId: 'g1', kind: 'seal', contract: { rungs: [] } as never }
          : null,
      resolveGate: async (runId, gateId, decision) => {
        if (runId !== 'run-live') return 'no-session';
        if (decision.decision === 'edited' && gateId === 'plan-gate') return 'invalid';
        if (decision.decision === 'approve' && gateId === 'drifted-gate') return { drifted: ['gen.mjs'] };
        return gateId === 'g1' ? 'ok' : 'stale';
      },
      onGateEvent: () => null,
      gateFiles: async (runId, gateId) => {
        if (runId !== 'run-live') return 'no-session';
        if (gateId !== 'g1') return 'stale';
        return {
          gateId,
          files: [
            {
              path: 'test/gen.test.mjs',
              frozenSha256: 'a'.repeat(64),
              sha256OnDisk: 'b'.repeat(64),
              content: 'edited content',
              truncated: false,
              dirty: true,
            },
          ],
        };
      },
      writeGateFile: async (runId, gateId, write) => {
        if (runId !== 'run-live') return 'no-session';
        if (gateId !== 'g1') return 'stale';
        if (write.path !== 'test/gen.test.mjs') return 'bad-path';
        calls.push(`write:${write.path}`);
        return { written: write.path, sha256: 'c'.repeat(64) };
      },
      createWorktree: async (name) => {
        calls.push(`wt-create:${name}`);
        return { name, path: `/w/${name}`, branch: `goaly/${name}`, head: 'x', dirty: false, runs: 0, prunable: false };
      },
      removeWorktree: async (name, o) => {
        calls.push(`wt-remove:${name}:${o.force}:${o.deleteBranch}`);
      },
      shutdown: () => {},
    };
    return { actions, calls };
  }

  const ctxWith = (actions: import('./start-run').UiActions): RouterCtx => ({
    ...makeCtx({}),
    actions,
  });

  it('POST /api/runs Zod-parses the body fail-closed (.strict()) and 201s a valid start', async () => {
    const { actions, calls } = makeActions();
    const ctx = ctxWith(actions);
    const ok = await route(ctx, 'POST', '/api/runs', q, { goal: 'g', verifyCmd: 'true' });
    expect(ok).toMatchObject({ status: 201, body: { runId: 'run-new' } });
    expect(calls).toContain('start:g');
    // Missing verification source, both sources, and unknown fields all refuse with 400.
    expect(await route(ctx, 'POST', '/api/runs', q, { goal: 'g' })).toMatchObject({ status: 400 });
    expect(
      await route(ctx, 'POST', '/api/runs', q, { goal: 'g', verifyCmd: 'x', generate: true }),
    ).toMatchObject({ status: 400 });
    expect(
      await route(ctx, 'POST', '/api/runs', q, { goal: 'g', verifyCmd: 'x', hackTheBar: true }),
    ).toMatchObject({ status: 400 });
  });

  it('gate routes: GET pending, POST decision (404 unknown run, 409 stale id, 400 bad body)', async () => {
    const { actions } = makeActions();
    const ctx = ctxWith(actions);
    expect(await route(ctx, 'GET', '/api/runs/run-live/gate', q)).toMatchObject({ status: 200, body: { gateId: 'g1' } });
    expect(await route(ctx, 'GET', '/api/runs/run-other/gate', q)).toMatchObject({ status: 404 });
    expect(
      await route(ctx, 'POST', '/api/runs/run-live/gate/g1', q, { decision: 'approve' }),
    ).toMatchObject({ status: 200 });
    expect(
      await route(ctx, 'POST', '/api/runs/run-live/gate/old', q, { decision: 'approve' }),
    ).toMatchObject({ status: 409 });
    expect(
      await route(ctx, 'POST', '/api/runs/run-other/gate/g1', q, { decision: 'approve' }),
    ).toMatchObject({ status: 404 });
    // revise REQUIRES non-empty feedback (the HumanSealGate rule, schema-enforced).
    expect(
      await route(ctx, 'POST', '/api/runs/run-live/gate/g1', q, { decision: 'revise' }),
    ).toMatchObject({ status: 400 });
  });

  it('gate edited: valid patch accepted; plan gate 400; approve-with-drift 409 names the files (ADR 0016)', async () => {
    const { actions } = makeActions();
    const ctx = ctxWith(actions);
    expect(
      await route(ctx, 'POST', '/api/runs/run-live/gate/g1', q, {
        decision: 'edited',
        patch: { setup: null, commands: [{ index: 0, command: 'npm test' }] },
      }),
    ).toMatchObject({ status: 200 });
    // An unknown patch field refuses fail-closed (.strict()).
    expect(
      await route(ctx, 'POST', '/api/runs/run-live/gate/g1', q, {
        decision: 'edited',
        patch: { goal: 'weaker goal' },
      }),
    ).toMatchObject({ status: 400 });
    // Plan gates never accept manual edits.
    expect(
      await route(ctx, 'POST', '/api/runs/run-live/gate/plan-gate', q, { decision: 'edited' }),
    ).toMatchObject({ status: 400 });
    // Approve with drifted files: 409 + the file list; the gate stays parked.
    const drift = await route(ctx, 'POST', '/api/runs/run-live/gate/drifted-gate', q, { decision: 'approve' });
    expect(drift).toMatchObject({ status: 409, body: { drifted: ['gen.mjs'] } });
  });

  it('gate files: GET serves contents with dirty flags; PUT writes only allowlisted paths', async () => {
    const { actions, calls } = makeActions();
    const ctx = ctxWith(actions);
    expect(await route(ctx, 'GET', '/api/runs/run-live/gate/g1/files', q)).toMatchObject({
      status: 200,
      body: { gateId: 'g1', files: [{ path: 'test/gen.test.mjs', dirty: true }] },
    });
    expect(await route(ctx, 'GET', '/api/runs/run-other/gate/g1/files', q)).toMatchObject({ status: 404 });
    expect(await route(ctx, 'GET', '/api/runs/run-live/gate/old/files', q)).toMatchObject({ status: 409 });

    expect(
      await route(ctx, 'PUT', '/api/runs/run-live/gate/g1/files', q, {
        path: 'test/gen.test.mjs',
        content: 'new content',
      }),
    ).toMatchObject({ status: 200, body: { written: 'test/gen.test.mjs' } });
    expect(calls).toContain('write:test/gen.test.mjs');
    // A non-allowlisted path refuses (only the parked contract's authored files are writable).
    expect(
      await route(ctx, 'PUT', '/api/runs/run-live/gate/g1/files', q, {
        path: 'src/index.ts',
        content: 'hijack',
      }),
    ).toMatchObject({ status: 400, body: { error: expect.stringContaining('not an authored file') } });
    // Unknown body fields refuse fail-closed.
    expect(
      await route(ctx, 'PUT', '/api/runs/run-live/gate/g1/files', q, {
        path: 'test/gen.test.mjs',
        content: 'x',
        mode: '0777',
      }),
    ).toMatchObject({ status: 400 });
  });

  it('stop: 202 for a UI-owned live run, 404 otherwise (with the terminal hint)', async () => {
    const { actions } = makeActions();
    const ctx = ctxWith(actions);
    expect(await route(ctx, 'POST', '/api/runs/run-live/stop', q)).toMatchObject({ status: 202 });
    const miss = await route(ctx, 'POST', '/api/runs/run-other/stop', q);
    expect(miss).toMatchObject({ status: 404 });
    expect(JSON.stringify((miss as { body: unknown }).body)).toContain('--resume');
  });

  it('resume rides the extension schema (operational caps only; unknown fields refuse)', async () => {
    const { actions, calls } = makeActions();
    const ctx = ctxWith(actions);
    expect(
      await route(ctx, 'POST', '/api/runs/run-x/resume', q, { note: 'hint', maxIterations: 9 }),
    ).toMatchObject({ status: 201 });
    expect(calls).toContain('resume:run-x:hint');
    // The bar is structurally unreachable: a "goal" field is an unknown key → 400.
    expect(
      await route(ctx, 'POST', '/api/runs/run-x/resume', q, { goal: 'weaker goal' }),
    ).toMatchObject({ status: 400 });
  });

  it('worktree mutation: POST create (201/400), DELETE with boolean query (refusals → 409)', async () => {
    const { actions, calls } = makeActions();
    const ctx = ctxWith(actions);
    expect(await route(ctx, 'POST', '/api/worktrees', q, { name: 'feat' })).toMatchObject({ status: 201 });
    expect(await route(ctx, 'POST', '/api/worktrees', q, { name: '../x' })).toMatchObject({ status: 400 });
    expect(
      await route(ctx, 'DELETE', '/api/worktrees/feat', new URLSearchParams('force=true')),
    ).toMatchObject({ status: 200 });
    expect(calls).toContain('wt-remove:feat:true:false');
    expect(
      await route(ctx, 'DELETE', '/api/worktrees/feat', new URLSearchParams('force=maybe')),
    ).toMatchObject({ status: 400 });
  });
});
