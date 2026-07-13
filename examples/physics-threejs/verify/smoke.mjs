import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');

if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error('[smoke] dist/index.html not found - run `vite build` first');
  process.exit(1);
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.map': 'application/json' };

const server = http.createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    let filePath = path.join(distDir, urlPath);
    if (!filePath.startsWith(distDir)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(filePath)) filePath = path.join(distDir, 'index.html');
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});

const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const base = 'http://127.0.0.1:' + port + '/';

const consoleErrors = [];
const pageErrors = [];
let ok = true;
const fail = (m) => { console.error('[smoke] FAIL:', m); ok = false; };

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err && err.message ? err.message : String(err)));

  const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  if (!resp || !resp.ok()) fail('page failed to load (status ' + (resp ? resp.status() : 'none') + ')');

  await page.waitForSelector('canvas', { timeout: 15000 });
  const size = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return c ? { w: c.width, h: c.height } : null;
  });
  if (!size || size.w < 1 || size.h < 1) fail('canvas has no rendered dimensions');

  const hasSample = await page.evaluate(() => typeof window.__physicsSample === 'function');
  if (!hasSample) {
    fail('the demo must expose window.__physicsSample() returning a flat numeric array of live object positions');
  } else {
    const read = () => page.evaluate(() => {
      const s = window.__physicsSample();
      return Array.isArray(s) ? s.map(Number) : null;
    });
    const first = await read();
    if (!first || first.length === 0) {
      fail('window.__physicsSample() returned no positions');
    } else {
      let changed = false;
      for (let t = 0; t < 40 && !changed; t++) {
        await page.waitForTimeout(150);
        const next = await read();
        if (next && next.length === first.length) {
          for (let i = 0; i < next.length; i++) {
            if (Number.isFinite(next[i]) && Math.abs(next[i] - first[i]) > 1e-4) { changed = true; break; }
          }
        }
      }
      if (!changed) fail('sampled object positions did not change across frames - the simulation is not running');
    }
  }

  if (consoleErrors.length) fail('console errors: ' + JSON.stringify(consoleErrors.slice(0, 5)));
  if (pageErrors.length) fail('uncaught page errors: ' + JSON.stringify(pageErrors.slice(0, 5)));
} catch (e) {
  fail(e && e.stack ? e.stack : String(e));
} finally {
  await browser.close();
  server.close();
}

if (ok) { console.log('[smoke] OK: canvas renders, no console/page errors, simulation advancing'); process.exit(0); }
process.exit(1);
