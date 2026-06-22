import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, step } from '../src/engine.js';

describe('createWorld', () => {
  it('returns correct shape and initial position', () => {
    const w = createWorld(5, 4);
    assert.equal(w.width, 5);
    assert.equal(w.height, 4);
    assert.equal(w.x, 0);
    assert.equal(w.y, 0);
  });

  it('works for non-square dimensions', () => {
    const w = createWorld(10, 3);
    assert.equal(w.width, 10);
    assert.equal(w.height, 3);
  });
});

describe('step – movement', () => {
  it('moves right', () => {
    const w = createWorld(5, 5);
    const next = step(w, 'right');
    assert.equal(next.x, 1);
    assert.equal(next.y, 0);
  });

  it('moves down', () => {
    const w = createWorld(5, 5);
    const next = step(w, 'down');
    assert.equal(next.x, 0);
    assert.equal(next.y, 1);
  });

  it('moves left from interior', () => {
    const w = { width: 5, height: 5, x: 3, y: 2 };
    const next = step(w, 'left');
    assert.equal(next.x, 2);
    assert.equal(next.y, 2);
  });

  it('moves up from interior', () => {
    const w = { width: 5, height: 5, x: 3, y: 2 };
    const next = step(w, 'up');
    assert.equal(next.x, 3);
    assert.equal(next.y, 1);
  });

  it('chained moves reach expected position', () => {
    let w = createWorld(10, 10);
    w = step(w, 'right');
    w = step(w, 'right');
    w = step(w, 'down');
    assert.equal(w.x, 2);
    assert.equal(w.y, 1);
  });
});

describe('step – edge blocking', () => {
  it('blocks movement left at x=0', () => {
    const w = createWorld(5, 5);
    const next = step(w, 'left');
    assert.equal(next.x, 0);
  });

  it('blocks movement up at y=0', () => {
    const w = createWorld(5, 5);
    const next = step(w, 'up');
    assert.equal(next.y, 0);
  });

  it('blocks movement right at x=width-1', () => {
    const w = { width: 5, height: 5, x: 4, y: 0 };
    const next = step(w, 'right');
    assert.equal(next.x, 4);
  });

  it('blocks movement down at y=height-1', () => {
    const w = { width: 5, height: 5, x: 0, y: 4 };
    const next = step(w, 'down');
    assert.equal(next.y, 4);
  });

  it('blocks on a 1x1 grid in all directions', () => {
    const w = createWorld(1, 1);
    assert.equal(step(w, 'up').y, 0);
    assert.equal(step(w, 'down').y, 0);
    assert.equal(step(w, 'left').x, 0);
    assert.equal(step(w, 'right').x, 0);
  });
});

describe('step – immutability', () => {
  it('returns a new object reference', () => {
    const w = createWorld(5, 5);
    const next = step(w, 'right');
    assert.notEqual(next, w);
  });

  it('does not mutate x on the original world', () => {
    const w = createWorld(5, 5);
    const xBefore = w.x;
    step(w, 'right');
    assert.equal(w.x, xBefore);
  });

  it('does not mutate y on the original world', () => {
    const w = createWorld(5, 5);
    const yBefore = w.y;
    step(w, 'down');
    assert.equal(w.y, yBefore);
  });

  it('does not mutate when blocked at edge', () => {
    const w = createWorld(5, 5);
    const xBefore = w.x;
    const yBefore = w.y;
    step(w, 'left');
    step(w, 'up');
    assert.equal(w.x, xBefore);
    assert.equal(w.y, yBefore);
  });
});
