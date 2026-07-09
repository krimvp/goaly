import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import jsdomPkg from 'jsdom';

const { JSDOM, VirtualConsole } = jsdomPkg;

function parseTime(raw) {
  if (raw == null) return NaN;
  let t = Date.parse(raw);
  if (!Number.isFinite(t)) {
    const n = Number(raw);
    if (Number.isFinite(n)) t = n;
  }
  return t;
}

function loadPage() {
  assert.ok(existsSync('index.html'), 'index.html must exist at the repository root');
  const html = readFileSync('index.html', 'utf8');
  const FIXED = Date.now();
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://verify.test/',
    virtualConsole,
    beforeParse(window) {
      const RealDate = window.Date;
      class MockDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(FIXED);
          else super(...args);
        }
        static now() { return FIXED; }
      }
      window.Date = MockDate;
      window.fetch = () => Promise.reject(new Error('network disabled for verification'));
      if (!window.matchMedia) {
        window.matchMedia = (q) => ({
          matches: false, media: q, onchange: null,
          addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
        });
      }
      window.IntersectionObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      window.scrollTo = () => {};
    },
  });
  return { dom, FIXED, html };
}

function waitFor(dom, selector, min, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const doc = dom.window.document;
    (function poll() {
      const n = doc.querySelectorAll(selector).length;
      if (n >= min) return resolve(n);
      if (Date.now() - start > timeout) return reject(new Error(`timed out waiting for >=${min} of "${selector}" (offline fallback did not render); got ${n}`));
      setTimeout(poll, 50);
    })();
  });
}

test('offline fallback renders a real SpaceX launch board with correct countdowns', async () => {
  const { dom, FIXED, html } = loadPage();
  try {
    await waitFor(dom, '[data-launch-time]', 6);
    const doc = dom.window.document;

    const cards = [...doc.querySelectorAll('[data-launch-time]')];
    assert.ok(cards.length >= 6, `expected >=6 launch cards with [data-launch-time], got ${cards.length}`);

    const fields = ['mission', 'vehicle', 'pad', 'orbit', 'status', 'date-utc'];
    const missionNames = new Set();
    for (const card of cards) {
      const got = {};
      for (const f of fields) {
        const el = card.querySelector(`[data-field="${f}"]`);
        assert.ok(el, `a launch card is missing [data-field="${f}"]`);
        got[f] = el.textContent.trim();
        assert.ok(got[f].length > 0, `a launch card has empty [data-field="${f}"]`);
      }
      // vehicle must be a real SpaceX vehicle, not a stub
      assert.match(got.vehicle, /falcon|starship|heavy/i, `[data-field="vehicle"] must name a real SpaceX vehicle (Falcon 9 / Falcon Heavy / Starship), got "${got.vehicle}"`);
      // pad and orbit must carry descriptive content, not one-letter placeholders
      assert.ok(got.pad.length >= 6, `[data-field="pad"] must give a real launch site + pad (>=6 chars), got "${got.pad}"`);
      assert.ok(got.orbit.length >= 6, `[data-field="orbit"] must give a real orbit/payload summary (>=6 chars), got "${got.orbit}"`);
      // date-utc must be an actual UTC timestamp: token + digits
      assert.match(got['date-utc'], /UTC/i, `[data-field="date-utc"] must display the time in UTC, got "${got['date-utc']}"`);
      assert.match(got['date-utc'], /\d/, `[data-field="date-utc"] must contain a parseable date with digits, got "${got['date-utc']}"`);
      missionNames.add(got.mission.toLowerCase());
    }
    assert.ok(missionNames.size >= 6, `mission names must be distinct across launches, got ${missionNames.size} unique among ${cards.length} cards`);

    const future = cards.filter((c) => {
      const t = parseTime(c.getAttribute('data-launch-time'));
      return Number.isFinite(t) && t > FIXED;
    });
    assert.ok(future.length >= 6, `expected >=6 upcoming (future-dated) launches so countdowns tick, got ${future.length}`);

    let checked = 0;
    for (const card of future) {
      const t = parseTime(card.getAttribute('data-launch-time'));
      const parts = ['days', 'hours', 'minutes', 'seconds'].map((p) => {
        const el = card.querySelector(`[data-countdown="${p}"]`);
        assert.ok(el, `a future launch card is missing countdown part [data-countdown="${p}"]`);
        return parseInt(el.textContent.replace(/[^0-9]/g, ''), 10);
      });
      const [d, h, m, s] = parts;
      assert.ok(Number.isFinite(d) && d >= 0, 'days must be a non-negative integer');
      assert.ok(h >= 0 && h < 24, `hours out of range: ${h}`);
      assert.ok(m >= 0 && m < 60, `minutes out of range: ${m}`);
      assert.ok(s >= 0 && s < 60, `seconds out of range: ${s}`);
      const shown = d * 86400 + h * 3600 + m * 60 + s;
      const expected = Math.floor((t - FIXED) / 1000);
      assert.ok(Math.abs(shown - expected) <= 2, `countdown must be computed from data-launch-time: shown ${shown}s vs expected ${expected}s`);
      checked++;
    }
    assert.ok(checked >= 6, 'must verify countdowns on at least 6 upcoming launches');

    const hero = doc.querySelector('[data-featured-countdown]');
    assert.ok(hero, 'a featured hero countdown element [data-featured-countdown] must exist');
    for (const p of ['days', 'hours', 'minutes', 'seconds']) {
      assert.ok(hero.querySelector(`[data-countdown="${p}"]`), `hero countdown missing [data-countdown="${p}"]`);
    }

    const src = doc.querySelector('[data-source]');
    assert.ok(src, 'a data-source indicator element [data-source] must exist');
    const srcText = `${src.getAttribute('data-source') || ''} ${src.textContent || ''}`.toLowerCase();
    assert.match(srcText, /sample|fallback|offline|demo/, 'with the network disabled the [data-source] indicator must reflect sample/fallback data');

    assert.match(html, /<script[^>]*>[\s\S]*?<\/script>/i, 'index.html must contain an inline <script>');
    assert.doesNotMatch(html, /<script[^>]+src\s*=\s*["']https?:/i, 'index.html must not load external scripts (no JS frameworks/CDN)');
    for (const link of html.match(/<link\b[^>]*>/gi) || []) {
      if (/rel\s*=\s*["']?stylesheet/i.test(link)) {
        assert.doesNotMatch(link, /href\s*=\s*["']https?:/i, 'index.html must not load an external stylesheet/font CDN required for the page to work');
      }
    }
  } finally {
    dom.window.close();
  }
});

test('DESIGN.md documents the design system', () => {
  assert.ok(existsSync('DESIGN.md'), 'DESIGN.md must exist at the repository root');
  const d = readFileSync('DESIGN.md', 'utf8');
  const hexes = d.match(/#[0-9a-fA-F]{6}\b/g) || [];
  assert.ok(hexes.length >= 3, `DESIGN.md must document a palette with >=3 hex colors, found ${hexes.length}`);
  assert.match(d, /palette/i, 'DESIGN.md must document the palette');
  assert.match(d, /type\s*[- ]?scale|typographic scale/i, 'DESIGN.md must document the type scale');
  assert.match(d, /spacing/i, 'DESIGN.md must document the spacing scale');
  assert.match(d, /grid/i, 'DESIGN.md must document the layout grid');
});
