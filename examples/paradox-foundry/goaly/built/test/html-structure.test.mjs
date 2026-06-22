import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

test('index.html exists at repo root', () => {
  assert.ok(existsSync('index.html'), 'index.html must exist at repo root');
});

test('index.html references src/engine.js and src/render.js as type=module', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.ok(
    /type\s*=\s*["']module["']/.test(html),
    'index.html must contain a <script type="module">'
  );
  assert.ok(
    /\.\/src\/engine\.js/.test(html),
    'index.html must reference ./src/engine.js'
  );
  assert.ok(
    /\.\/src\/render\.js/.test(html),
    'index.html must reference ./src/render.js'
  );
});

test('index.html contains a canvas element', () => {
  const html = readFileSync('index.html', 'utf8');
  assert.ok(/<canvas[\s\/>]/i.test(html), 'index.html must contain a <canvas> element');
});
