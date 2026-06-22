import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLevel, step } from '../src/engine.js';

// Grid layout used across all tests
//   col:  0 1 2 3 4
// row 0:  # # # # #
// row 1:  # @ O . #   @ → floor at start (1,1); O = ore at (1,2)
// row 2:  # . . X #   X = output at (2,3)
// row 3:  # # # # #
const RAW = ['#####', '#@O.#', '#..X#', '#####'].join('\n');

// ── parseLevel ───────────────────────────────────────────────────────────────

test('parseLevel: start position is where @ was', () => {
  const s = parseLevel(RAW);
  assert.equal(s.pos.r, 1);
  assert.equal(s.pos.c, 1);
});

test('parseLevel: tiles contain X output glyph', () => {
  const s = parseLevel(RAW);
  assert.ok(s.tiles.flat().includes('X'), 'expected X tile in parsed grid');
});

test('parseLevel: default capacity is 3', () => {
  const s = parseLevel(RAW);
  assert.equal(s.capacity, 3);
});

test('parseLevel: custom capacity option is respected', () => {
  const s = parseLevel(RAW, { capacity: 1 });
  assert.equal(s.capacity, 1);
});

test('parseLevel: initial inventory is empty', () => {
  const s = parseLevel(RAW);
  assert.deepEqual(s.inv, []);
});

// ── Movement ─────────────────────────────────────────────────────────────────

test('move right advances column', () => {
  const s = step(parseLevel(RAW), 'right');
  assert.equal(s.pos.r, 1);
  assert.equal(s.pos.c, 2);
});

test('move left retreats column', () => {
  const s = step(step(parseLevel(RAW), 'right'), 'left');
  assert.equal(s.pos.r, 1);
  assert.equal(s.pos.c, 1);
});

test('move down advances row', () => {
  const s = step(parseLevel(RAW), 'down');
  assert.equal(s.pos.r, 2);
  assert.equal(s.pos.c, 1);
});

test('move up retreats row', () => {
  const s = step(step(parseLevel(RAW), 'down'), 'up');
  assert.equal(s.pos.r, 1);
  assert.equal(s.pos.c, 1);
});

test('move into wall above - position unchanged', () => {
  const s = step(parseLevel(RAW), 'up');
  assert.equal(s.pos.r, 1);
  assert.equal(s.pos.c, 1);
});

test('move into wall to the left - position unchanged', () => {
  const s = step(parseLevel(RAW), 'left');
  assert.equal(s.pos.r, 1);
  assert.equal(s.pos.c, 1);
});

// ── Mining (act on ore) ───────────────────────────────────────────────────────

test('act on ore tile adds ore to inventory', () => {
  const onOre = step(parseLevel(RAW), 'right'); // (1,2) = O
  const s = step(onOre, 'act');
  assert.deepEqual(s.inv, ['ore']);
});

test('act on ore tile twice accumulates ore', () => {
  const onOre = step(parseLevel(RAW), 'right');
  const s = step(step(onOre, 'act'), 'act');
  assert.deepEqual(s.inv, ['ore', 'ore']);
});

test('capacity limit: act on full inventory is a no-op', () => {
  const onOre = step(parseLevel(RAW, { capacity: 2 }), 'right');
  const full = step(step(onOre, 'act'), 'act');
  assert.equal(full.inv.length, 2);
  const after = step(full, 'act');
  assert.deepEqual(after.inv, ['ore', 'ore'], 'inv must not exceed capacity');
});

test('default capacity 3 is enforced after 4 consecutive act calls', () => {
  const onOre = step(parseLevel(RAW), 'right');
  let s = onOre;
  for (let i = 0; i < 4; i++) s = step(s, 'act');
  assert.equal(s.inv.length, 3, 'inv must not exceed default capacity of 3');
});

test('act on plain floor tile is a no-op', () => {
  const onFloor = step(parseLevel(RAW), 'down'); // (2,1) = floor
  const s = step(onFloor, 'act');
  assert.deepEqual(s.inv, []);
  assert.equal(s.pos.r, 2);
  assert.equal(s.pos.c, 1);
});

// ── Output tile (X) ──────────────────────────────────────────────────────────

test('act on X tile with empty inventory is a no-op', () => {
  // navigate down → right → right to reach X at (2,3)
  const atX = step(step(step(parseLevel(RAW), 'down'), 'right'), 'right');
  assert.equal(atX.pos.r, 2);
  assert.equal(atX.pos.c, 3);
  const after = step(atX, 'act');
  assert.deepEqual(after.inv, [], 'empty-handed act on X must leave inv unchanged');
  assert.equal(after.pos.r, 2);
  assert.equal(after.pos.c, 3);
});

// ── Purity ────────────────────────────────────────────────────────────────────

test('step does not mutate the input state pos', () => {
  const s0 = parseLevel(RAW);
  const posBefore = { r: s0.pos.r, c: s0.pos.c };
  step(s0, 'right');
  assert.deepEqual(s0.pos, posBefore);
});

test('step does not mutate the input state inv', () => {
  const s0 = parseLevel(RAW);
  const onOre = step(s0, 'right');
  const invSnapshot = [...onOre.inv];
  step(onOre, 'act');
  assert.deepEqual(onOre.inv, invSnapshot);
});

test('step is deterministic: same inputs yield deepEqual outputs', () => {
  const s0 = parseLevel(RAW);
  const a = step(s0, 'right');
  const b = step(s0, 'right');
  assert.deepEqual(a.pos, b.pos);
  assert.deepEqual(a.inv, b.inv);
});
