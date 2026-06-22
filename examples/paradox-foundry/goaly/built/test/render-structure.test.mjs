import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');

describe('render.js structure', () => {
  it('src/render.js exists', () => {
    assert.ok(existsSync(resolve(root, 'src/render.js')), 'src/render.js does not exist');
  });

  it('src/render.js exports drawWorld as a function', async () => {
    const mod = await import(resolve(root, 'src/render.js'));
    assert.ok(typeof mod.drawWorld === 'function', `drawWorld export is ${typeof mod.drawWorld}, expected function`);
  });
});

describe('engine.js DOM-free invariant', () => {
  it('src/engine.js contains no DOM references', () => {
    const enginePath = resolve(root, 'src/engine.js');
    assert.ok(existsSync(enginePath), 'src/engine.js does not exist');
    const source = readFileSync(enginePath, 'utf8');
    const forbidden = ['document', 'window', 'canvas'];
    for (const term of forbidden) {
      assert.ok(
        !source.includes(term),
        `engine.js contains forbidden DOM reference: '${term}'`
      );
    }
  });
});
