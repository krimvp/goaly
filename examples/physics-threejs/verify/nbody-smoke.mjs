import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');

if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error('[nbody-smoke] dist/index.html not found - run `vite build` first');
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
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});

const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const base = 'http://127.0.0.1:' + port + '/';

const PANEL = '.lil-gui, [data-physics-panel], #physics-panel, .dg.main, .dg.ac';
let ok = true;
const fail = (m) => { console.error('[nbody-smoke] FAIL:', m); ok = false; };

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

const sample = (page) => page.evaluate(() => {
  const s = window.__physicsSample && window.__physicsSample();
  return Array.isArray(s) ? s.map(Number) : null;
});

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));

  const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  if (!resp || !resp.ok()) fail('page failed to load (status ' + (resp ? resp.status() : 'none') + ')');
  await page.waitForSelector('canvas', { timeout: 15000 });

  const hasSample = await page.evaluate(() => typeof window.__physicsSample === 'function');
  if (!hasSample) fail('window.__physicsSample() must be exposed for all scenes');

  // Cycle scenes (arrow key) until the three-body scene: exactly 3 bodies => 9 numbers.
  let onThreeBody = false;
  for (let k = 0; k < 6 && !onThreeBody; k++) {
    const s = await sample(page);
    if (s && s.length === 9) { onThreeBody = true; break; }
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(350);
  }
  if (!onThreeBody) fail('could not reach a three-body scene exposing exactly 3 body positions (9 numbers) via __physicsSample after cycling scenes');

  if (ok && onThreeBody) {
    const panelCount = await page.locator(PANEL).count().catch(() => 0);
    if (!panelCount) fail('three-body scene has no control panel (expected one of: ' + PANEL + ')');

    const first = await sample(page);
    let changed = false, maxAbs = 0;
    for (let t = 0; t < 20; t++) {
      await page.waitForTimeout(120);
      const cur = await sample(page);
      if (!cur || cur.length !== 9) { fail('three-body sample changed length mid-run: ' + (cur ? cur.length : 'null')); break; }
      for (let i = 0; i < 9; i++) {
        if (!Number.isFinite(cur[i])) fail('non-finite body coordinate (simulation blew up): ' + cur[i]);
        maxAbs = Math.max(maxAbs, Math.abs(cur[i]));
        if (Math.abs(cur[i] - first[i]) > 1e-3) changed = true;
      }
    }
    if (!changed) fail('the three bodies did not move across frames - orbit is frozen or not stepping');
    if (maxAbs >= 100) fail('body positions left a generous bound (|coord| >= 100) - the orbit is diverging/blowing up, not stable (max ' + maxAbs + ')');
  }

  if (errors.length) fail('console/page errors: ' + JSON.stringify(errors.slice(0, 5)));
} catch (e) {
  fail(e && e.stack ? e.stack : String(e));
} finally {
  await browser.close();
  server.close();
}

if (ok) { console.log('[nbody-smoke] OK: fourth (three-body) scene present with a control panel; 3 bodies orbit (positions change) while staying within a bounded magnitude (stable, no blow-up)'); process.exit(0); }
process.exit(1);
