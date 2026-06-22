import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import http from 'node:http';
import {
  parseAllowlistEntry,
  isHostAllowed,
  startEgressProxy,
  type AllowlistEntry,
  type EgressProxy,
} from './proxy';

describe('parseAllowlistEntry (PURE)', () => {
  it('parses a bare host', () => {
    expect(parseAllowlistEntry('api.anthropic.com')).toEqual({ host: 'api.anthropic.com' });
  });

  it('parses a pinned port as a number', () => {
    expect(parseAllowlistEntry('host:443')).toEqual({ host: 'host', port: 443 });
  });

  it('preserves a subdomain wildcard', () => {
    expect(parseAllowlistEntry('*.npmjs.org')).toEqual({ host: '*.npmjs.org' });
    expect(parseAllowlistEntry('*.npmjs.org:443')).toEqual({ host: '*.npmjs.org', port: 443 });
  });

  it('lower-cases the host', () => {
    expect(parseAllowlistEntry('API.Anthropic.COM')).toEqual({ host: 'api.anthropic.com' });
    expect(parseAllowlistEntry('Registry.NPMJS.org:443')).toEqual({
      host: 'registry.npmjs.org',
      port: 443,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parseAllowlistEntry('  host:80  ')).toEqual({ host: 'host', port: 80 });
  });
});

describe('isHostAllowed (PURE table tests)', () => {
  const exact: readonly AllowlistEntry[] = [{ host: 'api.anthropic.com' }];
  const wildcard: readonly AllowlistEntry[] = [{ host: '*.npmjs.org' }];
  const pinned: readonly AllowlistEntry[] = [{ host: 'host', port: 443 }];

  it('matches an exact host on any port', () => {
    expect(isHostAllowed(exact, 'api.anthropic.com', 443)).toBe(true);
    expect(isHostAllowed(exact, 'api.anthropic.com', 80)).toBe(true);
    expect(isHostAllowed(exact, 'other.anthropic.com', 443)).toBe(false);
  });

  it('wildcard matches subdomains AND the base, but not look-alikes', () => {
    expect(isHostAllowed(wildcard, 'registry.npmjs.org', 443)).toBe(true);
    expect(isHostAllowed(wildcard, 'npmjs.org', 443)).toBe(true);
    expect(isHostAllowed(wildcard, 'a.b.npmjs.org', 443)).toBe(true);
    expect(isHostAllowed(wildcard, 'evilnpmjs.org', 443)).toBe(false);
    expect(isHostAllowed(wildcard, 'npmjs.org.evil.com', 443)).toBe(false);
  });

  it('honours a pinned port', () => {
    expect(isHostAllowed(pinned, 'host', 443)).toBe(true);
    expect(isHostAllowed(pinned, 'host', 80)).toBe(false);
  });

  it('an entry without a port matches any port', () => {
    expect(isHostAllowed([{ host: 'host' }], 'host', 1)).toBe(true);
    expect(isHostAllowed([{ host: 'host' }], 'host', 65535)).toBe(true);
  });

  it('empty entries always deny (fail-closed)', () => {
    expect(isHostAllowed([], 'api.anthropic.com', 443)).toBe(false);
  });

  it('is case-insensitive on both sides', () => {
    expect(isHostAllowed([{ host: 'api.anthropic.com' }], 'API.Anthropic.COM', 443)).toBe(true);
    expect(isHostAllowed([{ host: '*.npmjs.org' }], 'Registry.NPMJS.Org', 443)).toBe(true);
  });
});

// --- IO server seam ----------------------------------------------------------------------------

/** Track everything started in a test so it is closed deterministically. */
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length) {
    const close = closers.pop()!;
    await close();
  }
});

function listenHttp(handler: http.RequestListener): Promise<http.Server> {
  const server = http.createServer(handler);
  closers.push(() => new Promise<void>((res) => server.close(() => res())));
  return new Promise<http.Server>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function listenTcp(handler: (sock: net.Socket) => void): Promise<net.Server> {
  const server = net.createServer(handler);
  closers.push(() => new Promise<void>((res) => server.close(() => res())));
  return new Promise<net.Server>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function portOf(server: http.Server | net.Server): number {
  const addr = server.address();
  if (typeof addr === 'object' && addr) return addr.port;
  throw new Error('no port');
}

function startProxy(
  allowlist: readonly string[],
  onDeny?: (t: string) => void,
): Promise<EgressProxy> {
  return startEgressProxy(allowlist, { ...(onDeny !== undefined ? { onDeny } : {}) }).then((p) => {
    closers.push(() => p.close());
    return p;
  });
}

describe('startEgressProxy — server behaviour', () => {
  it('HTTP forward ALLOW: forwards to the upstream and returns its response', async () => {
    const upstream = await listenHttp((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
    const upstreamPort = portOf(upstream);
    const proxy = await startProxy(['127.0.0.1']);

    const { status, body } = await proxyHttpGet(proxy.port, upstreamPort);
    expect(status).toBe(200);
    expect(body).toBe('ok');
    expect(proxy.denied).toEqual([]);
  });

  it('HTTP forward DENY: returns 403 and records the target', async () => {
    const upstream = await listenHttp((_req, res) => res.end('should not reach'));
    const upstreamPort = portOf(upstream);
    const proxy = await startProxy(['allowed.test']);

    const { status } = await proxyHttpGet(proxy.port, upstreamPort);
    expect(status).toBe(403);
    expect(proxy.denied).toContain(`127.0.0.1:${upstreamPort}`);
  });

  it('CONNECT ALLOW: tunnels bytes to the upstream and back', async () => {
    const echo = await listenTcp((sock) => sock.pipe(sock));
    const echoPort = portOf(echo);
    const proxy = await startProxy(['127.0.0.1']);

    const echoed = await connectTunnelEcho(proxy.port, echoPort, 'ping');
    expect(echoed).toBe('ping');
    expect(proxy.denied).toEqual([]);
  });

  it('CONNECT DENY: returns 403, destroys the socket, records and reports the target', async () => {
    const seen: string[] = [];
    const proxy = await startProxy(['allowed.test'], (t) => seen.push(t));

    const resp = await connectRaw(proxy.port, '127.0.0.1:9');
    expect(resp.startsWith('HTTP/1.1 403')).toBe(true);
    expect(proxy.denied).toContain('127.0.0.1:9');
    expect(seen).toContain('127.0.0.1:9');
  });
});

// --- low-level client helpers ------------------------------------------------------------------

/** Make an absolute-form HTTP request THROUGH the proxy to a 127.0.0.1 upstream. */
function proxyHttpGet(
  proxyPort: number,
  upstreamPort: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: `http://127.0.0.1:${upstreamPort}/`,
        headers: { Host: `127.0.0.1:${upstreamPort}` },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Open a raw CONNECT tunnel through the proxy, send a payload, return the tunnelled echo. */
function connectTunnelEcho(
  proxyPort: number,
  echoPort: number,
  payload: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: 127.0.0.1:${echoPort}\r\n\r\n`);
    });
    let established = false;
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!established) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        const header = buf.slice(0, idx).toString('utf8');
        if (!header.startsWith('HTTP/1.1 200')) {
          reject(new Error(`unexpected CONNECT response: ${header}`));
          sock.destroy();
          return;
        }
        established = true;
        buf = buf.slice(idx + 4); // any body after header (none expected)
        sock.write(payload);
      }
      if (established && buf.length >= Buffer.byteLength(payload)) {
        const out = buf.slice(0, Buffer.byteLength(payload)).toString('utf8');
        sock.destroy();
        resolve(out);
      }
    });
    sock.on('error', reject);
  });
}

/** Send a CONNECT and resolve with the raw status line/header text returned by the proxy. */
function connectRaw(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    sock.on('close', () => resolve(buf));
    sock.on('error', (err) => {
      // A destroyed socket after the 403 is expected; resolve with whatever we read.
      if (buf) resolve(buf);
      else reject(err);
    });
  });
}
