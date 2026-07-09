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

// --- CSSOM helpers: bind design assertions to the REAL rendered elements. ---

// Every base (non reduced-motion) CSSStyleRule, flattened out of media blocks.
function baseStyleRules(doc) {
  const win = doc.defaultView;
  const STYLE = (win.CSSRule && win.CSSRule.STYLE_RULE) || 1;
  const MEDIA = (win.CSSRule && win.CSSRule.MEDIA_RULE) || 4;
  const out = [];
  const walk = (rules) => {
    for (const r of rules) {
      if (r.type === STYLE) out.push(r);
      else if (r.type === MEDIA) {
        if (!/prefers-reduced-motion/i.test((r.media && r.media.mediaText) || '')) walk(r.cssRules || []);
      }
    }
  };
  for (const sheet of doc.styleSheets) {
    try { walk(sheet.cssRules); } catch { /* unreadable sheet */ }
  }
  return out;
}

// Strip pseudo-classes/elements so `.card:hover`/`.card::before` still target the card.
function cleanSelector(sel) {
  return sel.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '');
}

function ruleMatchesAny(rule, els) {
  const cleaned = cleanSelector(rule.selectorText || '');
  for (const part of cleaned.split(',')) {
    const sel = part.trim();
    if (!sel) continue;
    for (const el of els) {
      try { if (el.matches(sel)) return true; } catch { /* invalid selector fragment */ }
    }
  }
  return false;
}

// Concatenated cssText of every base rule whose selector targets one of `els`.
function boundCss(rules, els) {
  return rules.filter((r) => ruleMatchesAny(r, els)).map((r) => r.cssText).join('\n');
}

function ancestors(el, n) {
  const out = [];
  let cur = el.parentElement;
  while (cur && out.length < n && cur.tagName !== 'BODY' && cur.tagName !== 'HTML') {
    out.push(cur);
    cur = cur.parentElement;
  }
  return out;
}

// element + its own subtree (NOT ancestors) — the facet/glass must be ON the card, not a shared outer wrapper.
function selfScope(el) {
  return [el, ...el.querySelectorAll('*')];
}

// element + a few ancestors + subtree — for typography/numeric traits that may live on a container.
function wideScope(el, up = 3) {
  return [el, ...ancestors(el, up), ...el.querySelectorAll('*')];
}

// ---------------------------------------------------------------------------
// FUNCTIONAL NON-REGRESSION: the redesign must keep every existing feature
// working, verified against the bundled fallback dataset with fetch disabled.
// ---------------------------------------------------------------------------
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
      assert.match(got.vehicle, /falcon|starship|heavy/i, `[data-field="vehicle"] must name a real SpaceX vehicle (Falcon 9 / Falcon Heavy / Starship), got "${got.vehicle}"`);
      assert.ok(got.pad.length >= 6, `[data-field="pad"] must give a real launch site + pad (>=6 chars), got "${got.pad}"`);
      assert.ok(got.orbit.length >= 6, `[data-field="orbit"] must give a real orbit/payload summary (>=6 chars), got "${got.orbit}"`);
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

    // Self-contained: inline script, no external framework/CDN/font dependency.
    assert.match(html, /<script[^>]*>[\s\S]*?<\/script>/i, 'index.html must contain an inline <script>');
    assert.doesNotMatch(html, /<script[^>]+src\s*=\s*["']https?:/i, 'index.html must not load external scripts (no JS frameworks/CDN)');
    for (const link of html.match(/<link\b[^>]*>/gi) || []) {
      if (/rel\s*=\s*["']?stylesheet/i.test(link)) {
        assert.doesNotMatch(link, /href\s*=\s*["']https?:/i, 'index.html must not load an external stylesheet/font CDN required for the page to work');
      }
    }

    // Semantic landmarks (requirement 8).
    assert.ok(doc.querySelector('main'), 'page must use a <main> landmark');
    assert.ok(doc.querySelector('footer'), 'page must use a <footer> landmark');
    assert.ok(doc.querySelector('section, article'), 'page must use <section>/<article> landmarks');
  } finally {
    dom.window.close();
  }
});

// ---------------------------------------------------------------------------
// NEON CRYSTAL REDESIGN — each visual trait is bound to the ACTUAL rendered
// element it must style (the launch cards, the hero countdown, the display
// heading, the countdown digits). A decoy <style> block on unused selectors
// (e.g. `.__x{...}`) matches none of these elements and therefore FAILS.
// ---------------------------------------------------------------------------
test('the launch cards are faceted neon-crystal glass shards', async () => {
  const { dom } = loadPage();
  try {
    await waitFor(dom, '[data-launch-time]', 6);
    const doc = dom.window.document;
    const rules = baseStyleRules(doc);
    assert.ok(rules.length >= 10, `the parsed stylesheet must contain real CSS rules, got ${rules.length}`);

    const cards = [...doc.querySelectorAll('[data-launch-time]')];
    assert.ok(cards.length >= 6, `expected >=6 launch cards, got ${cards.length}`);

    // (4) Every card is a faceted shard: a rule matching the card (or its subtree)
    //     sets clip-path: polygon(...). (Absent from the pre-redesign tree.)
    // (4) Every card uses glassmorphism: backdrop-filter: blur(...) on the card/subtree.
    let cardsWithGlow = 0;
    for (const card of cards) {
      const css = boundCss(rules, selfScope(card));
      assert.match(css, /clip-path\s*:\s*polygon\s*\(/i,
        'each launch card must be a faceted crystal shard: a rule matching the card must set clip-path: polygon(...) (requirement 4)');
      assert.match(css, /(?:-webkit-)?backdrop-filter\s*:[^;{}]*blur\s*\(/i,
        'each launch card must use glassmorphism: a rule matching the card must set backdrop-filter: blur(...) (requirement 4)');
      if (/(?:box|text)-shadow\s*:/i.test(css)) cardsWithGlow++;
    }
    // (5/7) The cards carry a neon glow edge (base or hover).
    assert.ok(cardsWithGlow >= 1,
      'launch cards must carry a neon glow (box-shadow/text-shadow on a rule matching a card) (requirements 5,7)');
  } finally {
    dom.window.close();
  }
});

test('the hero, headings and countdown digits carry the neon treatment', async () => {
  const { dom, html } = loadPage();
  try {
    await waitFor(dom, '[data-launch-time]', 6);
    const doc = dom.window.document;
    const rules = baseStyleRules(doc);
    const styleText = [...doc.querySelectorAll('style')].map((s) => s.textContent || '').join('\n');
    assert.ok(styleText.length > 500, 'inline CSS is implausibly small for a full redesign');

    // (5) The featured hero countdown digits glow.
    const featured = doc.querySelector('[data-featured-countdown]');
    assert.ok(featured, '[data-featured-countdown] must exist');
    const heroCss = boundCss(rules, wideScope(featured, 3));
    assert.match(heroCss, /(?:box|text)-shadow\s*:/i,
      'the featured countdown must glow: a box-shadow/text-shadow rule must be bound to the hero countdown (requirement 5)');

    // (6) A display heading uses ultra-wide uppercase treatment.
    const headings = [...doc.querySelectorAll('h1, h2, h3')];
    assert.ok(headings.length >= 1, 'the page must have a display heading');
    const anyUppercase = headings.some((h) => /text-transform\s*:\s*uppercase/i.test(boundCss(rules, wideScope(h, 3))));
    const anyTracked = headings.some((h) => /letter-spacing\s*:/i.test(boundCss(rules, wideScope(h, 3))));
    assert.ok(anyUppercase, 'a display heading must be uppercase (text-transform: uppercase bound to a heading) (requirement 6)');
    assert.ok(anyTracked, 'a display heading must set letter-spacing for the ultra-wide display treatment (requirement 6)');

    // (6) Countdown digits use tabular numerals (digital/terminal feel).
    const digit = doc.querySelector('[data-countdown]');
    assert.ok(digit, 'a [data-countdown] digit element must exist');
    const digitCss = boundCss(rules, wideScope(digit, 4));
    assert.match(digitCss, /tabular-nums/i,
      'countdown digits must use tabular numerals (font-variant-numeric: tabular-nums bound to the countdown) (requirement 6)');

    // (4/5) A neon / holographic gradient accent — bound to the hero or a card if
    //       possible, otherwise present as a global accent.
    const gradientRe = /(?:linear|radial|conic)-gradient\s*\(/i;
    const cards = [...doc.querySelectorAll('[data-launch-time]')];
    const boundGradient = gradientRe.test(heroCss) ||
      cards.some((c) => gradientRe.test(boundCss(rules, selfScope(c))));
    assert.ok(boundGradient || gradientRe.test(styleText),
      'a neon/holographic gradient accent must be used (requirements 4-5)');

    // (7) Motion is wired and gated behind prefers-reduced-motion.
    const win = doc.defaultView;
    const KEYFRAMES = (win.CSSRule && win.CSSRule.KEYFRAMES_RULE) || 7;
    const MEDIA = (win.CSSRule && win.CSSRule.MEDIA_RULE) || 4;
    let keyframes = 0, reducedMotion = 0;
    const scan = (ruleList) => {
      for (const r of ruleList) {
        if (r.type === KEYFRAMES) keyframes++;
        else if (r.type === MEDIA) {
          if (/prefers-reduced-motion/i.test((r.media && r.media.mediaText) || '')) reducedMotion++;
          if (r.cssRules) scan(r.cssRules);
        }
      }
    };
    for (const sheet of doc.styleSheets) { try { scan(sheet.cssRules); } catch { /* ignore */ } }
    assert.ok(keyframes >= 1, `there must be at least one @keyframes animation for the neon motion (requirement 7), found ${keyframes}`);
    assert.match(styleText, /animation(?:-name)?\s*:/i, 'motion must be wired via an animation declaration (requirement 7)');
    assert.ok(reducedMotion >= 1, 'all motion must be disabled under a @media (prefers-reduced-motion) query (requirement 7)');

    // (8) Responsive down to small mobile: at least one max-width media query.
    assert.match(styleText, /@media[^{]*max-width/i, 'the layout must stay responsive via a max-width media query (requirement 8)');

    // Reference html so it participates (self-contained already checked in group A).
    assert.ok(html.length > 0);
  } finally {
    dom.window.close();
  }
});

// ---------------------------------------------------------------------------
// DESIGN.md must be rewritten for the new neon crystal system.
// ---------------------------------------------------------------------------
test('DESIGN.md documents the neon crystal design system', () => {
  assert.ok(existsSync('DESIGN.md'), 'DESIGN.md must exist at the repository root');
  const d = readFileSync('DESIGN.md', 'utf8');

  const hexes = d.match(/#[0-9a-fA-F]{6}\b/g) || [];
  assert.ok(hexes.length >= 3, `DESIGN.md must document a palette with >=3 hex colors, found ${hexes.length}`);

  // Core design-system sections.
  assert.match(d, /palette/i, 'DESIGN.md must document the palette');
  assert.match(d, /type\s*[- ]?scale|typographic scale/i, 'DESIGN.md must document the type scale');
  assert.match(d, /spacing/i, 'DESIGN.md must document the spacing scale');
  assert.match(d, /grid/i, 'DESIGN.md must document the layout grid');

  // New neon crystal vocabulary — proves DESIGN.md was rewritten for this system.
  assert.match(d, /neon/i, 'DESIGN.md must describe the neon aesthetic');
  assert.match(d, /crystal|facet|prism|shard/i, 'DESIGN.md must describe the crystalline/faceted treatment');
  assert.match(d, /glass|glassmorphism|backdrop/i, 'DESIGN.md must document the glass/backdrop treatment');
  assert.match(d, /gradient/i, 'DESIGN.md must document gradients');
  assert.match(d, /prefers-reduced-motion|reduced[- ]?motion/i, 'DESIGN.md must document the reduced-motion rule');

  // Neon prism palette hues (requirement 5): cyan + magenta/pink + purple/uv.
  assert.match(d, /cyan/i, 'DESIGN.md palette must document the electric cyan hue');
  assert.match(d, /magenta|pink/i, 'DESIGN.md palette must document the hot magenta/pink hue');
  assert.match(d, /purple|violet|ultraviolet/i, 'DESIGN.md palette must document the ultraviolet/purple hue');
});
