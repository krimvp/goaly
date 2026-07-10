import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const ROOT = process.cwd();
const HTML_PATH = path.join(ROOT, 'index.html');
const DESIGN_PATH = path.join(ROOT, 'DESIGN.md');

// Deterministic frozen base instant, before any realistic future-dated sample
// launch, so the offline fallback renders positive T-minus values.
const BASE_NOW = Date.parse('2026-01-01T00:00:00Z');
let clockOffset = 0; // advanced by the live-countdown test
const nowMs = () => BASE_NOW + clockOffset;

// Controllable scroll position + desktop viewport reference for the parallax test.
let SCROLL = 0;
const VH_REF = 900; // px height of a ~1440px-wide desktop viewport (for vh->px)

let dom, window, doc;

function makeFakeDate() {
  const RealDate = Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowMs());
      else super(...args);
    }
    static now() { return nowMs(); }
  }
  return FakeDate;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function styleText() {
  return [...doc.querySelectorAll('style')].map((s) => s.textContent || '').join('\n');
}

function launchCards() {
  return [...doc.querySelectorAll('[data-launch-time]')]
    .filter((c) => c.querySelector('[data-field="mission"]'));
}

function expectedCountdown(dtIso, offset = 0) {
  const launchMs = Date.parse(dtIso);
  const total = Math.max(0, Math.floor((launchMs - (BASE_NOW + offset)) / 1000));
  return {
    total,
    days: Math.floor(total / 86400),
    hours: Math.floor((total % 86400) / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

function readTotal(card) {
  const g = (p) => parseInt((card.querySelector(`[data-countdown="${p}"]`).textContent || '').trim(), 10);
  return g('days') * 86400 + g('hours') * 3600 + g('minutes') * 60 + g('seconds');
}

function toPx(str) {
  if (!str) return null;
  const m = String(str).match(/(-?[0-9.]+)\s*(vh|vw|px|%)?/i);
  if (!m) return null;
  const num = parseFloat(m[1]);
  if (!isFinite(num)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'vh') return (num / 100) * VH_REF;
  if (unit === 'px' || unit === '') return num;
  return null; // vw / % are not usable as an absolute reference
}
function isBigPx(v) {
  const px = toPx(v);
  return px != null && px >= 480;
}
function cssBlocks(css) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) out.push([m[1].trim(), m[2]]);
  return out;
}

function integrated() {
  const rocket = doc.querySelector('[data-rocket]');
  const tower = doc.querySelector('[data-tower]');
  const svg = rocket ? rocket.closest('svg') : null;
  return { rocket, tower, svg };
}

function sceneSelectorTokens() {
  const { svg } = integrated();
  const tokens = new Set();
  let node = svg;
  while (node && node.nodeType === 1) {
    if (node.id) tokens.add('#' + node.id);
    for (const c of node.classList || []) tokens.add('.' + c);
    if (node.tagName.toLowerCase() === 'section') break;
    node = node.parentElement;
  }
  return tokens;
}

// Concrete declared height (px) of the scene/section — the section-relative
// reference for the parallax clamp bound. null when nothing concrete is declared.
function sceneHeightPx() {
  const { svg } = integrated();
  const cands = [];
  const push = (v) => { const px = toPx(v); if (px != null && px > 0) cands.push(px); };
  if (svg) {
    push(svg.getAttribute('height'));
    push(svg.style && svg.style.height);
    push(svg.style && svg.style.minHeight);
  }
  const tokens = sceneSelectorTokens();
  for (const [sel, body] of cssBlocks(styleText())) {
    if (![...tokens].some((t) => sel.includes(t))) continue;
    const re = /(?:min-)?height\s*:\s*([^;]+)/gi;
    let m;
    while ((m = re.exec(body))) push(m[1]);
  }
  if (!cands.length) return null;
  return Math.max(...cands);
}

before(async () => {
  assert.ok(existsSync(HTML_PATH), 'index.html must exist at repository root');
  const html = readFileSync(HTML_PATH, 'utf8');
  dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'https://localhost/',
    beforeParse(win) {
      win.Date = makeFakeDate();
      // Force OFFLINE so the bundled fallback dataset renders.
      win.fetch = () => Promise.reject(new Error('offline: network disabled for verification'));
      if (!win.matchMedia) {
        win.matchMedia = (q) => ({
          matches: false, media: q, onchange: null,
          addListener() {}, removeListener() {},
          addEventListener() {}, removeEventListener() {},
          dispatchEvent() { return false; },
        });
      }
      // IO that immediately reports the target fully in view, so parallax gated
      // behind in-view detection still activates under test.
      win.IntersectionObserver = class {
        constructor(cb) { this._cb = cb; }
        observe(el) {
          try {
            this._cb([{ isIntersecting: true, intersectionRatio: 1, target: el,
              boundingClientRect: {}, intersectionRect: {}, rootBounds: null, time: 0 }], this);
          } catch { /* ignore */ }
        }
        unobserve() {} disconnect() {} takeRecords() { return []; }
      };
      if (!win.ResizeObserver) {
        win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
      }
      Object.defineProperty(win, 'scrollY', { configurable: true, get: () => SCROLL });
      Object.defineProperty(win, 'pageYOffset', { configurable: true, get: () => SCROLL });
      win.scrollTo = win.scrollTo || (() => {});
    },
  });
  window = dom.window;
  doc = window.document;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (launchCards().length >= 6) break;
    await sleep(25);
  }
});

after(() => {
  // Guarantee the process exits: kill jsdom's per-second countdown interval + rAF.
  try { if (window) window.close(); } catch { /* ignore */ }
});

// =================== functional non-regression ===================

test('offline fallback renders at least 6 launch cards', () => {
  assert.ok(launchCards().length >= 6, `expected >=6 fallback cards, got ${launchCards().length}`);
});

test('data-source indicator reflects the sample/offline dataset', () => {
  const el = doc.querySelector('[data-source]');
  assert.ok(el, '[data-source] indicator must exist');
  const signal = `${el.getAttribute('data-source') || ''} ${el.textContent || ''}`.toLowerCase();
  assert.match(signal, /sample|fallback|offline/, 'indicator must show the offline/sample source');
});

test('semantic landmark present', () => {
  assert.ok(doc.querySelector('main'), 'a <main> landmark is required for accessibility');
});

test('every card exposes required non-empty telemetry fields', () => {
  const fields = ['mission', 'vehicle', 'pad', 'orbit', 'status', 'date-utc'];
  for (const card of launchCards()) {
    for (const f of fields) {
      const el = card.querySelector(`[data-field="${f}"]`);
      assert.ok(el, `card missing [data-field="${f}"]`);
      assert.ok((el.textContent || '').trim().length > 0, `[data-field="${f}"] must be non-empty`);
    }
    const vehicle = card.querySelector('[data-field="vehicle"]').textContent;
    assert.match(vehicle, /falcon|starship|heavy/i, `vehicle must name a SpaceX vehicle, got "${vehicle}"`);
  }
});

test('per-card countdown equals computed T-minus at t0', () => {
  for (const card of launchCards()) {
    const dt = card.getAttribute('data-launch-time');
    assert.ok(dt, 'card must carry data-launch-time');
    const exp = expectedCountdown(dt, 0);
    assert.ok(exp.total > 0, `fallback launch ${dt} must be in the future relative to frozen now`);
    for (const part of ['days', 'hours', 'minutes', 'seconds']) {
      const el = card.querySelector(`[data-countdown="${part}"]`);
      assert.ok(el, `card missing [data-countdown="${part}"]`);
      const got = parseInt((el.textContent || '').trim(), 10);
      assert.equal(got, exp[part], `countdown ${part} for ${dt}: expected ${exp[part]}, got "${el.textContent}"`);
    }
  }
});

test('featured hero countdown exists and matches the next launch at t0', () => {
  const hero = doc.querySelector('[data-featured-countdown]');
  assert.ok(hero, '[data-featured-countdown] hero must exist');
  for (const part of ['days', 'hours', 'minutes', 'seconds']) {
    assert.ok(hero.querySelector(`[data-countdown="${part}"]`), `hero missing [data-countdown="${part}"]`);
  }
  const first = launchCards()[0];
  const exp = expectedCountdown(first.getAttribute('data-launch-time'), 0);
  const heroDays = parseInt(hero.querySelector('[data-countdown="days"]').textContent.trim(), 10);
  assert.equal(heroDays, exp.days, 'hero countdown must match the next (first) launch');
});

test('page is self-contained: no external scripts/styles/images', () => {
  const external = /^(https?:)?\/\//i;
  for (const s of doc.querySelectorAll('script[src]')) {
    assert.ok(!external.test(s.getAttribute('src')), `external script not allowed: ${s.getAttribute('src')}`);
  }
  for (const l of doc.querySelectorAll('link[href]')) {
    const rel = (l.getAttribute('rel') || '').toLowerCase();
    if (rel.includes('stylesheet') || rel.includes('preconnect') || rel.includes('font')) {
      assert.ok(!external.test(l.getAttribute('href')), `external stylesheet/font not allowed: ${l.getAttribute('href')}`);
    }
  }
  for (const img of doc.querySelectorAll('img[src]')) {
    assert.ok(!external.test(img.getAttribute('src')), `external image not allowed: ${img.getAttribute('src')}`);
  }
  assert.ok(doc.querySelector('style'), 'inline <style> required');
  assert.ok(doc.querySelector('script:not([src])'), 'inline <script> required');
});

test('mission-control HUD: ticker, grid, status LEDs, designations, T-MINUS', () => {
  const ticker = doc.querySelector('[data-ticker]');
  assert.ok(ticker, 'a telemetry ticker [data-ticker] is required');
  assert.ok((ticker.textContent || '').trim().length > 0, 'ticker must contain telemetry text');

  const grid = doc.querySelector('[data-grid]');
  assert.ok(grid, 'a technical grid overlay [data-grid] is required');

  const leds = doc.querySelectorAll('[data-led]');
  assert.ok(leds.length >= 3, `expected >=3 status LEDs [data-led], got ${leds.length}`);

  for (const card of launchCards()) {
    const desig = card.querySelector('[data-designation]');
    assert.ok(desig, 'each card must carry a designation strip [data-designation]');
    assert.ok((desig.textContent || '').trim().length > 0, '[data-designation] must be non-empty');
  }

  assert.match(doc.body.textContent || '', /T[\s\u2212-]*MINUS/i, 'T-MINUS microcopy required somewhere');
});

test('telemetry typography + animation + palette tokens declared in CSS', () => {
  const css = styleText();
  assert.match(css, /font-family\s*:[^;{}]*mono/i, 'monospace telemetry typography required');
  assert.match(css, /@keyframes[^{]*\{[\s\S]*?opacity/i, 'a blinking/pulsing (opacity) keyframe is required');
  assert.match(css, /--[\w-]+\s*:/, 'CSS custom-property design tokens required');
});

// =================== NEW: integrated rocket-in-tower centerpiece ===================

test('centerpiece is ONE integrated inline SVG scene with a coherent viewBox', () => {
  const { rocket, tower, svg } = integrated();
  assert.ok(rocket, 'rocket group ([data-rocket]) required');
  assert.ok(tower, 'launch tower group ([data-tower]) required');
  assert.equal(rocket.tagName.toLowerCase(), 'g', '[data-rocket] must be a <g> group inside the scene svg (not a standalone svg)');
  assert.equal(tower.tagName.toLowerCase(), 'g', '[data-tower] must be a <g> group inside the scene svg (not a standalone svg)');
  assert.ok(svg, 'rocket group must live inside an <svg>');
  assert.equal(tower.closest('svg'), svg, 'rocket and tower must share ONE integrated <svg> scene (currently they are two separate SVGs)');
  const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  assert.equal(vb.length, 4, 'scene <svg> must declare a coherent 4-value viewBox');
  const vbw = vb[2], vbh = vb[3];
  assert.ok(vbw > 0 && vbh > 0, 'viewBox must have positive width/height');
  assert.ok(vbh > vbw, `scene must be tall/slender (viewBox h ${vbh} must exceed w ${vbw})`);
});

test('centerpiece: rocket + tower are rich stroke-based line-art, aria-hidden', () => {
  const { rocket, tower, svg } = integrated();
  const geoSel = 'path, line, polyline, polygon, rect, circle, ellipse';
  const rgeo = rocket.querySelectorAll(geoSel);
  const tgeo = tower.querySelectorAll(geoSel);
  assert.ok(rgeo.length >= 6, `rocket must be drawn from stroke geometry (>=6 elements, got ${rgeo.length})`);
  assert.ok(tgeo.length >= 8, `tower must be a lattice with service arms (>=8 stroke elements, got ${tgeo.length})`);
  const ah = (el) => !!el && el.getAttribute('aria-hidden') === 'true';
  assert.ok(ah(svg) || ah(svg.closest('[aria-hidden="true"]')), 'decorative scene svg must be aria-hidden');
  const all = [...svg.querySelectorAll(geoSel)];
  const solid = all.filter((e) => {
    const f = (e.getAttribute('fill') || '').trim().toLowerCase();
    if (!f || f === 'none' || f === 'transparent') return false;
    const fo = parseFloat(e.getAttribute('fill-opacity'));
    const o = parseFloat(e.getAttribute('opacity'));
    const translucent = (!isNaN(fo) && fo < 0.9) || (!isNaN(o) && o < 0.9);
    return !translucent;
  });
  assert.ok(solid.length <= Math.ceil(all.length * 0.15),
    `scene must be stroke-only line-art; too many opaque solid-filled elements (${solid.length}/${all.length})`);
});

test('centerpiece: scene dominates its section (large declared height + backdrop header)', () => {
  const { svg } = integrated();
  assert.ok(svg, 'scene svg required');
  const inlineBig = isBigPx(svg.getAttribute('height'))
    || isBigPx(svg.style && svg.style.height)
    || isBigPx(svg.style && svg.style.minHeight);
  let cssBig = false;
  if (!inlineBig) {
    const tokens = sceneSelectorTokens();
    for (const [sel, body] of cssBlocks(styleText())) {
      if (![...tokens].some((t) => sel.includes(t))) continue;
      const re = /(?:min-)?height\s*:\s*([^;]+)/gi;
      let m;
      while ((m = re.exec(body))) { if (isBigPx(m[1])) { cssBig = true; break; } }
      if (cssBig) break;
    }
  }
  assert.ok(inlineBig || cssBig,
    'scene must render tall (>=~500px / 60-80vh): declare a large height on the scene svg or its section (the old doodles were ~140-300px)');

  let section = svg;
  while (section && section.tagName && section.tagName.toLowerCase() !== 'section') section = section.parentElement;
  assert.ok(section, 'the centerpiece must live in its own <section>');
  assert.match(section.textContent || '', /integration|pad\s*39a|vehicle/i,
    'centerpiece section needs a mission-control header strip (e.g. "PAD 39A // VEHICLE INTEGRATION")');
});

test('motion: line-drawing reveal + keyframes + reduced-motion policy declared', () => {
  const css = styleText();
  assert.match(css, /stroke-dashoffset/i, 'stroke-dashoffset line-drawing reveal required');
  assert.match(css, /@keyframes/i, 'CSS @keyframes animation required');
  assert.match(css, /prefers-reduced-motion/i, 'prefers-reduced-motion policy required');
  const { svg } = integrated();
  assert.ok(svg.querySelector('[data-beacon]'), 'a blinking beacon ([data-beacon]) is required in the scene');
  assert.ok(svg.querySelector('[data-engine-glow]'), 'an engine-glow element ([data-engine-glow]) is required in the scene');
});

// =================== NEW: parallax — real differentiated motion + section-relative clamp ===================

test('parallax: >=2 layers move at DIFFERENT non-zero speeds and the scene stays clamped in its section', async () => {
  const layers = [...doc.querySelectorAll('[data-parallax]')];
  assert.ok(layers.length >= 2, `at least two [data-parallax] layers required, got ${layers.length}`);

  const { svg } = integrated();
  const sceneLayer = svg && svg.closest('[data-parallax]');
  assert.ok(sceneLayer, 'the rocket/tower scene must sit inside a [data-parallax] layer');
  const sceneIdx = layers.indexOf(sceneLayer);

  const H = sceneHeightPx();
  assert.ok(H && H > 0, 'scene/section must declare a concrete height so the parallax clamp can be section-relative');

  const tyOf = (el) => {
    const t = (el.style && el.style.transform) || '';
    const m = t.match(/translateY\(\s*(-?[0-9.]+)px\s*\)/i)
      || t.match(/translate(?:3d)?\(\s*[^,]+,\s*(-?[0-9.]+)px/i);
    return m ? parseFloat(m[1]) : 0;
  };
  const drive = async (s) => {
    SCROLL = s;
    window.dispatchEvent(new window.Event('scroll'));
    await sleep(40); // let any rAF-throttled handler flush
    return layers.map((el) => tyOf(el));
  };

  // (1) LIVE, DIFFERENTIATED motion: at some non-zero scroll, at least two layers
  // translate by non-zero AND unequal amounts (real parallax at distinct speeds).
  // A missing/no-op scroll handler leaves every layer at 0 and fails here.
  let differentiated = false;
  for (const s of [8, 20, 45, 90, 180, 360]) {
    const mags = (await drive(s)).map((v) => Math.abs(v));
    const moving = mags.filter((v) => v > 0.5);
    const distinct = new Set(moving.map((v) => Math.round(v * 10) / 10));
    if (moving.length >= 2 && distinct.size >= 2) { differentiated = true; break; }
  }
  assert.ok(differentiated,
    'at least two [data-parallax] layers must move by NON-ZERO, DIFFERENT amounts under scroll (live parallax at distinct speeds, goal #3); a static/no-op layer set leaves every translateY at 0 and fails');

  // (2) SECTION-RELATIVE CLAMP: under large scroll the SCENE must never be pushed
  // out of its section — |translateY| stays within 30% of the scene height. A real
  // 10-15% clamp passes; an unclamped scrollY*speed handler (or a flat multi-thousand-
  // px clamp) drives the scene off-screen and fails.
  const sceneBound = 0.30 * H;
  const globalBound = 2.5 * H; // generous ceiling; still catches runaway/unclamped layers
  for (const s of [3000, 30000, 200000]) {
    const vals = await drive(s);
    const sceneMag = Math.abs(vals[sceneIdx]);
    assert.ok(sceneMag <= sceneBound,
      `at scrollY=${s} the rocket/tower scene translated ${sceneMag.toFixed(1)}px, exceeding ${sceneBound.toFixed(1)}px (30% of the ${H.toFixed(0)}px scene height); clamp/attenuate it so the scene stays substantially inside its section (goal #3)`);
    for (let i = 0; i < vals.length; i++) {
      const mag = Math.abs(vals[i]);
      assert.ok(mag <= globalBound,
        `at scrollY=${s} parallax layer #${i} translated ${mag.toFixed(1)}px, exceeding ${globalBound.toFixed(0)}px; every [data-parallax] layer must be clamped/attenuated (goal #3)`);
    }
  }

  SCROLL = 0;
  window.dispatchEvent(new window.Event('scroll'));
});

// =================== LIVE countdown (second time point) ===================

test('countdown is LIVE: digits tick and recompute from data-launch-time', async () => {
  const cards = launchCards();
  assert.ok(cards.length >= 6, 'need cards to verify live countdown');
  const card = cards[0];
  const dt = card.getAttribute('data-launch-time');
  const t0 = expectedCountdown(dt, 0);
  assert.equal(readTotal(card), t0.total, 'displayed T-minus must equal computed value at t0');

  clockOffset += 5000;
  const deadline = Date.now() + 8000;
  let changed = false;
  while (Date.now() < deadline) {
    if (readTotal(card) !== t0.total) { changed = true; break; }
    await sleep(100);
  }
  assert.ok(changed, 'countdown must tick on its own interval as time advances');

  const t1 = expectedCountdown(dt, 5000);
  assert.equal(readTotal(card), t1.total, 'ticked value must equal T-minus recomputed at t1');
  assert.equal(t0.total - t1.total, 5, 'advancing 5s must reduce T-minus by exactly 5s');
  for (const c of launchCards()) {
    const e = expectedCountdown(c.getAttribute('data-launch-time'), 5000);
    assert.equal(readTotal(c), e.total, 'every card must recompute from its own data-launch-time at t1');
  }
});

// =================== design-system documentation ===================

test('DESIGN.md documents the rebuilt centerpiece + parallax rules', () => {
  assert.ok(existsSync(DESIGN_PATH), 'DESIGN.md must exist at repository root');
  const md = readFileSync(DESIGN_PATH, 'utf8');
  const low = md.toLowerCase();
  assert.match(md, /#[0-9a-fA-F]{6}\b/, 'DESIGN.md must document palette hex values');
  const need = [
    [/palette/, 'palette'],
    [/scale/, 'type/spacing scale'],
    [/spacing/, 'spacing scale'],
    [/phosphor|green/, 'phosphor green accent'],
    [/cyan/, 'cyan accent'],
    [/mono/, 'monospace/telemetry typography'],
    [/rocket/, 'rocket line-art rules'],
    [/tower/, 'tower line-art rules'],
    [/stroke/, 'stroke width/glow rules'],
    [/parallax/, 'parallax rules'],
    [/clamp|attenuat/, 'parallax clamp/attenuation rule'],
    [/proportion|3\/4|three[\s-]*quarter|slender|aspect/, 'rocket/tower proportions'],
    [/integrated|single .*(svg|scene)|one .*(svg|scene)/, 'the integrated single-svg scene'],
    [/reduced[\s-]*motion/, 'reduced-motion policy'],
  ];
  for (const [re, label] of need) {
    assert.match(low, re, `DESIGN.md must document ${label}`);
  }
});
