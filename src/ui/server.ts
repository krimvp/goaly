import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Logger } from '../log/logger';
import { killActiveChildren } from '../util/spawn';
import { route, type RouterCtx } from './router';
import { resolveAssetsDir, readAsset } from './assets';
import { tailRun, NoSuchRunError, type TailDeps } from './sse';
import { makeUiActions, type UiActions } from './start-run';
import type { PendingGate, SseFrame, VersionResponse } from './api-schema';

/**
 * The `goaly ui` local web server (ADR 0014/0015): a thin `node:http` layer over the run-log
 * projections + the SSE tail, plus the interactive actions (start / gates / stop / resume — runs
 * execute IN-PROCESS through the same `executeRun` the CLI uses). Binds 127.0.0.1 by default and —
 * because a localhost server with no auth is reachable from any web page the browser has open —
 * enforces request guards even for reads: the Host header must be local (DNS-rebinding guard), a
 * present Origin must be same-origin (cross-site guard), and every state-changing request must
 * additionally carry `X-Goaly-Ui: 1` (a custom header a cross-site form can never attach). All
 * fail closed with 403.
 */
export type UiServerOptions = {
  workspaceRoot: string;
  /** Port to listen on (default 4180; 0 = ephemeral, for tests). */
  port?: number;
  /** Host to bind (default 127.0.0.1 — never widen without an explicit operator choice). */
  host?: string;
  /** Override the built-SPA directory (tests / unusual layouts). */
  assetsDir?: string;
  logger?: Logger;
  /** Injected router read seams (tests) — see {@link RouterCtx}. */
  inspect?: RouterCtx['inspect'];
  isActive?: RouterCtx['isActive'];
  listWorktrees?: RouterCtx['listWorktrees'];
  /** Injected SSE tail knobs (tests). */
  tail?: TailDeps;
  /** Injected interactive actions (tests). Default: the real in-process run machinery. */
  actions?: UiActions;
  /** Serve READ-ONLY (no start/stop/gates/worktree mutation). Default: interactive. */
  readOnly?: boolean;
};

export type UiServer = {
  /** The reachable base URL, e.g. `http://127.0.0.1:4180`. */
  url: string;
  port: number;
  close(): Promise<void>;
};

export const DEFAULT_UI_PORT = 4180;

/** Request bodies above this are refused (fail-closed) — no legitimate request comes close. */
const MAX_BODY_BYTES = 1024 * 1024;

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const host = options.host ?? '127.0.0.1';
  const assetsDir = await resolveAssetsDir(options.assetsDir);
  const actions =
    options.readOnly === true
      ? undefined
      : (options.actions ??
        makeUiActions({
          workspaceRoot: options.workspaceRoot,
          ...(options.logger !== undefined ? { logger: options.logger } : {}),
        }));
  const ctx: RouterCtx = {
    workspaceRoot: options.workspaceRoot,
    version: await readVersion(),
    ...(options.inspect !== undefined ? { inspect: options.inspect } : {}),
    ...(options.isActive !== undefined ? { isActive: options.isActive } : {}),
    ...(options.listWorktrees !== undefined ? { listWorktrees: options.listWorktrees } : {}),
    ...(actions !== undefined ? { actions } : {}),
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      options.logger?.warn('ui request failed', { error: e instanceof Error ? e.message : String(e) });
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? 'GET';
    if (!requestAllowed(req)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden (non-local Host or cross-site Origin)' }));
      return;
    }
    // State-changing requests additionally need the custom header (CSRF defense in depth: a
    // cross-site <form> can never set it, and setting it via fetch forces a CORS preflight the
    // Origin guard already rejects).
    if (method !== 'GET' && req.headers['x-goaly-ui'] !== '1') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden (missing X-Goaly-Ui header)' }));
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let body: unknown;
    if (method === 'POST') {
      try {
        body = await readJsonBody(req);
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : 'invalid body' }));
        return;
      }
    }
    const outcome = await route(ctx, method, url.pathname, url.searchParams, body);

    if (outcome.kind === 'json') {
      res.writeHead(outcome.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(outcome.body));
      return;
    }
    if (outcome.kind === 'empty') {
      res.writeHead(outcome.status);
      res.end();
      return;
    }
    if (outcome.kind === 'sse') {
      await serveSse(res, outcome.runDir, outcome.runId, options.tail ?? {});
      return;
    }
    await serveStatic(res, url.pathname);
  }

  /**
   * The SSE stream: the disk tail (entries / stream / liveness / terminal) MERGED with the
   * session's live gate events (a parked Seal is server memory, not log state). A simple
   * queue+wakeup joins the two sources; client disconnect aborts both.
   */
  async function serveSse(res: ServerResponse, runDir: string, runId: string, tail: TailDeps): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const queue: SseFrame[] = [];
    let wake: (() => void) | undefined;
    let tailDone = false;
    let tailError: unknown;
    const push = (frame: SseFrame): void => {
      queue.push(frame);
      wake?.();
    };

    // Live gate push for UI-owned runs; a parked gate is replayed on connect so a page refresh
    // mid-Seal still shows the modal.
    const pending = actions?.pendingGate(runId);
    if (pending !== undefined && pending !== null) push({ event: 'gate', data: pending });
    const unsubscribeGates =
      actions?.onGateEvent(runId, (event) => {
        push(
          'resolved' in event
            ? { event: 'gate-resolved', data: { gateId: event.resolved } }
            : { event: 'gate', data: event as PendingGate },
        );
      }) ?? null;

    void (async () => {
      try {
        for await (const frame of tailRun(runDir, runId, tail, abort.signal)) push(frame);
      } catch (e) {
        tailError = e;
      } finally {
        tailDone = true;
        wake?.();
      }
    })();

    try {
      while (!abort.signal.aborted) {
        while (queue.length > 0) {
          const frame = queue.shift();
          if (frame !== undefined) res.write(renderSseFrame(frame));
        }
        if (tailDone) break;
        await new Promise<void>((resolveWake) => {
          wake = resolveWake;
          if (queue.length > 0 || tailDone || abort.signal.aborted) resolveWake();
        });
        wake = undefined;
      }
      if (tailError !== undefined && !abort.signal.aborted) {
        // The run vanished or its log is corrupt mid-tail: end the stream with a terminal error
        // event (headers are already out, so a status code is no longer possible).
        const message =
          tailError instanceof NoSuchRunError
            ? tailError.message
            : `run log unreadable: ${String(tailError)}`;
        res.write(renderSseFrame({ event: 'terminal', data: { stateTag: 'ERROR', error: message } }));
      }
    } finally {
      unsubscribeGates?.();
      res.end();
    }
  }

  async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
    if (assetsDir === null) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        'goaly ui: the web assets are not built (API-only mode).\n' +
          'Run `npm run build` in the goaly checkout, then restart `goaly ui`.\n' +
          'The JSON API is live under /api/ (try /api/runs).\n',
      );
      return;
    }
    const asset =
      (await readAsset(assetsDir, pathname === '/' ? '/index.html' : pathname)) ??
      // SPA fallback: unknown non-asset paths render the app shell (hash-routed client).
      (pathname.includes('.') ? null : await readAsset(assetsDir, '/index.html'));
    if (asset === null) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': asset.contentType });
    res.end(asset.body);
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_UI_PORT, host, () => resolvePromise());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? DEFAULT_UI_PORT);
  return {
    url: `http://${host}:${port}`,
    port,
    close: async () => {
      // Cooperative-stop every UI-owned run (each stays resumable via its write-ahead log), then
      // reap any live child process groups — mirroring the CLI's second-signal sweep.
      actions?.shutdown();
      await closeServer(server);
      killActiveChildren();
    },
  };
}

/**
 * Request guards for a no-auth localhost server: without these, any web page could read run logs
 * (DNS rebinding defeats the "it's only on localhost" assumption) — and, with the interactive
 * routes, start runs that execute code. Reads and writes are guarded alike.
 */
export function requestAllowed(req: Pick<IncomingMessage, 'headers'>): boolean {
  const host = req.headers.host;
  if (host === undefined || !isLocalHost(host)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const parsed = new URL(origin);
      if (!isLocalHost(parsed.host)) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function isLocalHost(hostHeader: string): boolean {
  const name = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function renderSseFrame(frame: SseFrame): string {
  if (frame.event === 'heartbeat') return ': keepalive\n\n';
  return `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** Read + JSON-parse a request body, fail-closed on size and syntax. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('request body is not valid JSON');
  }
}

/** Best-effort package identity for `/api/version` — 'unknown' when the manifest isn't found. */
async function readVersion(): Promise<VersionResponse> {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const raw = await readFile(new URL(rel, import.meta.url), 'utf8');
      const parsed = JSON.parse(raw) as { name?: string; version?: string };
      if (parsed.name === 'goaly') return { name: parsed.name, version: parsed.version ?? 'unknown' };
    } catch {
      /* try the next location */
    }
  }
  return { name: 'goaly', version: 'unknown' };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    // Long-lived SSE responses hold the server open; sever them so close() completes.
    server.closeAllConnections?.();
  });
}
