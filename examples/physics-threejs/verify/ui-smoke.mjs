import { chromium } from 'playwright';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(here, '..', 'dist');

if (!existsSync(path.join(distDir, 'index.html'))) {
  console.error('[ui-smoke] dist/index.html not found - run `vite build` first');
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
const fail = (m) => { console.error('[ui-smoke] FAIL:', m); ok = false; };

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

const sample = (page) => page.evaluate(() => {
  const s = window.__physicsSample && window.__physicsSample();
  return Array.isArray(s) ? s.map(Number) : null;
});

async function motion(page, ms) {
  const first = await sample(page);
  let peak = 0;
  const steps = Math.max(1, Math.round(ms / 120));
  for (let t = 0; t < steps; t++) {
    await page.waitForTimeout(120);
    const cur = await sample(page);
    if (first && cur) {
      const n = Math.min(first.length, cur.length);
      for (let i = 0; i < n; i++) {
        const d = Math.abs(cur[i] - first[i]);
        if (Number.isFinite(d) && d > peak) peak = d;
      }
    }
  }
  return peak;
}

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));

  const resp = await page.goto(base, { waitUntil: 'load', timeout: 30000 });
  if (!resp || !resp.ok()) fail('page failed to load (status ' + (resp ? resp.status() : 'none') + ')');
  await page.waitForSelector('canvas', { timeout: 15000 });

  const panelCount = await page.locator(PANEL).count().catch(() => 0);
  if (!panelCount) fail('no control-panel element found (expected one of: ' + PANEL + ')');

  const hasSample = await page.evaluate(() => typeof window.__physicsSample === 'function');
  if (!hasSample) fail('window.__physicsSample() must still be exposed (panel must not interfere)');
  const hasSet = await page.evaluate(() => typeof window.__physicsSetParam === 'function');
  if (!hasSet) fail('window.__physicsSetParam(name, value) must be exposed so a panel control can be driven programmatically');

  if (ok) {
    const baseline = await motion(page, 800);
    if (baseline <= 0.02) fail('simulation not visibly moving at baseline (peak delta ' + baseline + ')');

    await page.evaluate(() => window.__physicsSetParam('timeScale', 0));
    await page.waitForTimeout(200);
    const frozen = await motion(page, 800);
    if (!(frozen < baseline * 0.3)) fail('setting timeScale=0 did not measurably slow the running simulation (baseline ' + baseline + ', frozen ' + frozen + ') - control appears decorative, not wired');

    await page.evaluate(() => window.__physicsSetParam('timeScale', 1));
    await page.waitForTimeout(200);
    const resumed = await motion(page, 800);
    if (!(resumed > frozen * 2 && resumed > 0.01)) fail('restoring timeScale=1 did not resume motion (frozen ' + frozen + ', resumed ' + resumed + ')');

    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    const panelAfter = await page.locator(PANEL).count().catch(() => 0);
    if (!panelAfter) fail('control panel missing after switching scenes (must rebuild per scene)');
    const stillMoving = await motion(page, 800);
    if (stillMoving <= 0.02) fail('simulation not running after scene switch (peak delta ' + stillMoving + ')');
  }

  if (errors.length) fail('console/page errors: ' + JSON.stringify(errors.slice(0, 5)));
} catch (e) {
  fail(e && e.stack ? e.stack : String(e));
} finally {
  await browser.close();
  server.close();
}

if (ok) { console.log('[ui-smoke] OK: control panel present, timeScale control causally drives the live simulation, panel rebuilds on scene switch'); process.exit(0); }
process.exit(1);
