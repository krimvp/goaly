import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileRunLog } from '../runlog/file-runlog';
import { makeConfig, makeFakeContract } from '../testing/fakes';
import { RunId, ContractHash, DiffHash, SessionId } from '../domain/ids';
import type { RunLogEntry } from '../runlog/runlog';
import { startUiServer, requestAllowed, type UiServer } from './server';

const RUN_ID = 'run-server-test';

describe('requestAllowed — Host / Origin guards for a no-auth localhost server', () => {
  const req = (headers: Record<string, string>): { headers: Record<string, string> } => ({ headers });

  it('allows local Hosts (with or without port), rejects everything else', () => {
    expect(requestAllowed(req({ host: '127.0.0.1:4180' }))).toBe(true);
    expect(requestAllowed(req({ host: 'localhost:4180' }))).toBe(true);
    expect(requestAllowed(req({ host: 'localhost' }))).toBe(true);
    expect(requestAllowed(req({ host: '[::1]:4180' }))).toBe(true);
    expect(requestAllowed(req({ host: 'evil.example.com:4180' }))).toBe(false); // DNS rebinding
    expect(requestAllowed(req({}))).toBe(false);
  });

  it('rejects a cross-site Origin, allows a local or absent one', () => {
    expect(requestAllowed(req({ host: 'localhost:4180', origin: 'http://localhost:4180' }))).toBe(true);
    expect(requestAllowed(req({ host: 'localhost:4180', origin: 'http://127.0.0.1:4180' }))).toBe(true);
    expect(requestAllowed(req({ host: 'localhost:4180', origin: 'https://evil.example.com' }))).toBe(false);
    expect(requestAllowed(req({ host: 'localhost:4180', origin: 'not a url' }))).toBe(false);
  });
});

describe('startUiServer — end-to-end over real HTTP (port 0, in-process)', () => {
  let workspace: string;
  let server: UiServer;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'goaly-ui-server-'));
    const log = new FileRunLog(join(workspace, '.goaly', RUN_ID));
    await log.writeHeader({
      runId: RunId.parse(RUN_ID),
      startedAt: 1000,
      config: makeConfig(),
      harness: 'fake',
    });
    // A REPLAY-VALID event sequence (the projections fold it through the real reducer):
    // compile → seal → one red iteration ending ABORTED.
    const contract = makeFakeContract();
    const base = { runId: RunId.parse(RUN_ID), contractHash: contract.contractHash };
    await log.append({
      ...base,
      seq: 1,
      ts: 1001,
      event: { tag: 'CONTRACT_COMPILED', contract },
      stateTagAfter: 'AWAIT_SEAL',
    } as RunLogEntry);
    await log.append({
      ...base,
      seq: 2,
      ts: 1002,
      event: { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } },
      stateTagAfter: 'RUNNING_AGENT',
    } as RunLogEntry);
    await log.append({
      ...base,
      seq: 3,
      ts: 1003,
      event: {
        tag: 'AGENT_RAN',
        run: { output: 'ok', sessionId: SessionId.parse('s1'), status: 'completed' },
        prevDiffHash: DiffHash.parse('0000000'),
        diffHash: DiffHash.parse('0000000'),
        budget: { exceeded: false },
      },
      stateTagAfter: 'VERIFYING',
    } as RunLogEntry);
    await log.append({
      ...base,
      seq: 4,
      ts: 1004,
      event: { tag: 'VERIFIED', verdict: { pass: false, confidence: 1, detail: 'red' } },
      stateTagAfter: 'ABORTED',
    } as RunLogEntry);

    server = await startUiServer({
      workspaceRoot: workspace,
      port: 0,
      listWorktrees: async () => [],
      tail: { sleep: async () => {}, isActive: async () => false },
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(workspace, { recursive: true, force: true });
  });

  it('serves the runs index and the run detail as JSON', async () => {
    const index = (await (await fetch(`${server.url}/api/runs`)).json()) as {
      roots: Array<{ runs: Array<{ ok: boolean }> }>;
    };
    expect(index.roots[0]?.runs).toHaveLength(1);

    const res = await fetch(`${server.url}/api/runs/${RUN_ID}`);
    expect(res.status).toBe(200);
    const detail = (await res.json()) as { detail: { status: string; iterations: number } };
    expect(detail.detail).toMatchObject({ status: 'ABORTED', iterations: 1 });
  });

  it('streams the run over SSE: hello → entries → terminal', async () => {
    const res = await fetch(`${server.url}/api/runs/${RUN_ID}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const body = await res.text(); // the run is terminal, so the stream ends by itself
    expect(body).toContain('event: hello');
    expect(body).toContain('event: entry');
    expect(body).toContain('event: terminal');
    expect(body).toContain('"stateTag":"ABORTED"');
  });

  it('404s unknown runs and refuses bad ids', async () => {
    expect((await fetch(`${server.url}/api/runs/run-none`)).status).toBe(404);
    expect((await fetch(`${server.url}/api/runs/run-none/events`)).status).toBe(404);
  });

  it('rejects a spoofed Host and a cross-site Origin with 403 (fail-closed)', async () => {
    // fetch() refuses to send a custom Host (forbidden header) — spoof it with a raw request,
    // which is exactly what a DNS-rebinding attacker's resolver effectively does.
    const spoofedHost = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: server.port, path: '/api/runs', headers: { host: 'evil.example.com' } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(spoofedHost).toBe(403);
    const crossOrigin = await fetch(`${server.url}/api/runs`, {
      headers: { origin: 'https://evil.example.com' },
    });
    expect(crossOrigin.status).toBe(403);
  });

  it('serves the SPA shell when assets exist, and an API-only hint when they do not', async () => {
    // This checkout may or may not have dist/ui built; force both cases with an override.
    const assetsDir = await mkdtemp(join(tmpdir(), 'goaly-ui-assets-'));
    await writeFile(join(assetsDir, 'index.html'), '<html>shell</html>');
    const withAssets = await startUiServer({
      workspaceRoot: workspace,
      port: 0,
      assetsDir,
      listWorktrees: async () => [],
    });
    try {
      const page = await (await fetch(withAssets.url)).text();
      expect(page).toContain('shell');
      // SPA fallback: an unknown, extension-less path still renders the shell (hash routing).
      expect(await (await fetch(`${withAssets.url}/some/route`)).text()).toContain('shell');
    } finally {
      await withAssets.close();
      await rm(assetsDir, { recursive: true, force: true });
    }

    const apiOnly = await startUiServer({
      workspaceRoot: workspace,
      port: 0,
      assetsDir: join(workspace, 'no-such-dir'),
      listWorktrees: async () => [],
    });
    try {
      const page = await (await fetch(apiOnly.url)).text();
      expect(page).toContain('API-only');
    } finally {
      await apiOnly.close();
    }
  });
});
