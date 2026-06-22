/**
 * Allowlisting forward proxy used to enforce a network-egress allowlist (issue #39).
 *
 * The module has two clearly separated parts:
 *
 *  - A PURE matching core ({@link parseAllowlistEntry}, {@link isHostAllowed}) that is fully
 *    table-testable: given a parsed allowlist and a `host:port`, it decides ALLOW/DENY with no IO.
 *  - An IO server seam ({@link startEgressProxy}) that binds a forward proxy on 127.0.0.1, handles
 *    plain HTTP requests (absolute-form URLs) and HTTPS CONNECT tunnels, and routes each target
 *    through the pure core.
 *
 * Fail-closed (invariant #4): anything not explicitly on the allowlist is REFUSED. An EMPTY
 * allowlist therefore denies everything. Denied targets are recorded in an audit log and surfaced
 * via the optional `onDeny` callback.
 *
 * Dependency-free: only Node.js builtins (`node:net`, `node:http`).
 */
import net from 'node:net';
import http from 'node:http';
import type { Duplex } from 'node:stream';

/** A parsed allowlist entry: a host with an optional pinned port. */
export type AllowlistEntry = { readonly host: string; readonly port?: number };

/**
 * Parse a raw allowlist token into an entry. Accepts a bare host ("api.anthropic.com"), a
 * subdomain wildcard ("*.npmjs.org"), each optionally pinned to a port ("host:443"). Lower-cases
 * the host. PURE.
 */
export function parseAllowlistEntry(raw: string): AllowlistEntry {
  const trimmed = raw.trim();
  const colon = trimmed.lastIndexOf(':');
  if (colon !== -1) {
    const maybePort = trimmed.slice(colon + 1);
    // Only treat the suffix as a port when it is a run of digits; this keeps hosts that happen to
    // contain a colon (none in practice for our tokens) from being misparsed.
    if (maybePort.length > 0 && /^\d+$/.test(maybePort)) {
      return { host: trimmed.slice(0, colon).toLowerCase(), port: Number(maybePort) };
    }
  }
  return { host: trimmed.toLowerCase() };
}

/**
 * Does `host:port` match ANY entry? Matching is case-insensitive. An entry host matches either
 * exactly, OR — when it begins with "*." — as a suffix covering subdomains (so "*.npmjs.org"
 * matches "registry.npmjs.org" and "npmjs.org" itself, but not "evilnpmjs.org"). A port pinned on
 * an entry must equal the requested port; an entry with no port matches any port. PURE.
 */
export function isHostAllowed(
  entries: readonly AllowlistEntry[],
  host: string,
  port: number,
): boolean {
  const h = host.toLowerCase();
  for (const entry of entries) {
    if (entry.port !== undefined && entry.port !== port) continue;
    const eh = entry.host;
    if (eh.startsWith('*.')) {
      const base = eh.slice(2); // "*.npmjs.org" -> "npmjs.org"
      // Matches the base itself, or any host ending in ".base" (a real subdomain). The leading dot
      // is what prevents "evilnpmjs.org" from matching, and anchoring at the END prevents
      // "npmjs.org.evil.com" from matching.
      if (h === base || h.endsWith('.' + base)) return true;
    } else if (h === eh) {
      return true;
    }
  }
  return false;
}

/** A running allowlisting forward proxy (handles HTTP requests and HTTPS CONNECT tunnels). */
export interface EgressProxy {
  /** The actual port it is listening on (bound to 127.0.0.1). */
  readonly port: number;
  /** Audit log: every denied "host:port" target, in order. */
  readonly denied: readonly string[];
  /** Stop listening and drop connections. */
  close(): Promise<void>;
}

export type StartEgressProxyOpts = {
  /** Bind host (default "127.0.0.1"). */
  readonly host?: string;
  /** Listen port (default 0 ⇒ an ephemeral port the OS assigns; read `.port` after start). */
  readonly port?: number;
  /** Called with the "host:port" target whenever a request/CONNECT is DENIED. */
  readonly onDeny?: (target: string) => void;
};

/**
 * Start the proxy. Fail-closed (invariant #4): a CONNECT or HTTP request whose host:port is not on
 * the allowlist is REFUSED — CONNECT gets "HTTP/1.1 403 Forbidden" and the socket is destroyed;
 * a plain HTTP request gets a 403 response. Allowed CONNECTs are tunnelled to the upstream;
 * allowed HTTP requests are forwarded. Binds to 127.0.0.1 by default. The allowlist strings are
 * parsed with parseAllowlistEntry. An EMPTY allowlist denies everything.
 */
export function startEgressProxy(
  allowlist: readonly string[],
  opts: StartEgressProxyOpts = {},
): Promise<EgressProxy> {
  const host = opts.host ?? '127.0.0.1';
  const listenPort = opts.port ?? 0;
  const entries = allowlist.map(parseAllowlistEntry);
  const denied: string[] = [];
  const sockets = new Set<Duplex>();

  const track = (sock: Duplex): void => {
    sockets.add(sock);
    sock.once('close', () => sockets.delete(sock));
  };

  const deny = (target: string): void => {
    denied.push(target);
    opts.onDeny?.(target);
  };

  const server = http.createServer();

  // Plain HTTP: the proxy receives an absolute-form URL in `req.url` (e.g. "http://host:port/path").
  server.on('request', (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    const hostname = target.hostname;
    const port = target.port ? Number(target.port) : 80;
    const label = `${hostname}:${port}`;

    if (!isHostAllowed(entries, hostname, port)) {
      deny(label);
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const headers = { ...req.headers };
    delete headers['proxy-connection'];

    const upstream = http.request(
      {
        host: hostname,
        port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain' });
      }
      res.end();
    });
    req.pipe(upstream);
  });

  // HTTPS CONNECT tunnels: `req.url` has the form "host:port" (port defaults to 443).
  server.on('connect', (req, clientSocket, head) => {
    track(clientSocket);
    const raw = req.url ?? '';
    const colon = raw.lastIndexOf(':');
    const hostname = colon === -1 ? raw : raw.slice(0, colon);
    const port = colon === -1 ? 443 : Number(raw.slice(colon + 1)) || 443;
    const label = `${hostname}:${port}`;

    if (!isHostAllowed(entries, hostname, port)) {
      deny(label);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    const upstream = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    track(upstream);
    upstream.on('error', () => {
      clientSocket.destroy();
    });
    clientSocket.on('error', () => {
      upstream.destroy();
    });
  });

  server.on('connection', track);

  return new Promise<EgressProxy>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, host, () => {
      server.removeListener('error', reject);
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : listenPort;
      resolve({
        port: boundPort,
        get denied(): readonly string[] {
          return denied;
        },
        close(): Promise<void> {
          return new Promise<void>((res) => {
            // Forcibly drop open sockets so close() resolves promptly (Node v22).
            server.closeAllConnections?.();
            for (const sock of sockets) sock.destroy();
            sockets.clear();
            server.close(() => res());
          });
        },
      });
    });
  });
}
