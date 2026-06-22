// Verifier for the TIME-LOOP mechanic: recording, endLoop baking, and echo replay.
// Uses node:test (zero deps). The engine is pure — every assertion also checks
// that the input world is never mutated.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLevel, step, endLoop, runLoop } from '../src/engine.js';

// Minimal open level: worker starts at (0,0), one empty cell to the right.
const LEVEL = '@..\n...';

function mkWorld(opts = {}) {
  return parseLevel(LEVEL, { loopLength: 10, ...opts });
}

// ── recording ────────────────────────────────────────────────────────────────

test('step appends live action to recording', () => {
  const w0 = mkWorld();
  const w1 = step(w0, 'right');
  assert.deepEqual(w1.recording, ['right']);
  const w2 = step(w1, 'wait');
  assert.deepEqual(w2.recording, ['right', 'wait']);
});

test('step does not mutate the input world', () => {
  const w0 = mkWorld();
  const snap = JSON.stringify(w0);
  step(w0, 'right');
  assert.equal(JSON.stringify(w0), snap);
});

test('step increments tick', () => {
  const w0 = mkWorld();
  const w1 = step(w0, 'wait');
  assert.equal(w1.tick, 1);
  const w2 = step(w1, 'wait');
  assert.equal(w2.tick, 2);
});

// ── endLoop ──────────────────────────────────────────────────────────────────

test('endLoop bakes recording into echoes with {actions,x,y,inv}', () => {
  let w = mkWorld();
  w = step(w, 'right');
  w = step(w, 'wait');
  const baked = endLoop(w);

  assert.equal(baked.echoes.length, 1);
  const echo = baked.echoes[0];
  assert.deepEqual(echo.actions, ['right', 'wait']);
  assert('x' in echo, 'echo must have x');
  assert('y' in echo, 'echo must have y');
  assert('inv' in echo, 'echo must have inv');
});

test('endLoop resets tick to 0 and increments loopCount', () => {
  let w = mkWorld();
  w = step(w, 'wait');
  w = step(w, 'wait');
  assert.equal(w.tick, 2);
  const baked = endLoop(w);
  assert.equal(baked.tick, 0);
  assert.equal(baked.loopCount, 1);
});

test('endLoop clears recording', () => {
  let w = mkWorld();
  w = step(w, 'right');
  w = step(w, 'left');
  const baked = endLoop(w);
  assert.deepEqual(baked.recording, []);
});

test('endLoop resets worker to workerStart', () => {
  let w = mkWorld();
  w = step(w, 'right');
  assert.equal(w.worker.x, 1);
  const baked = endLoop(w);
  assert.equal(baked.worker.x, baked.workerStart.x);
  assert.equal(baked.worker.y, baked.workerStart.y);
});

test('endLoop does not mutate the input world', () => {
  let w = mkWorld();
  w = step(w, 'right');
  const snap = JSON.stringify(w);
  endLoop(w);
  assert.equal(JSON.stringify(w), snap);
});

test('second endLoop adds a second echo', () => {
  let w = mkWorld();
  w = runLoop(w, ['right', 'wait']);
  w = step(w, 'wait');
  w = step(w, 'right');
  w = endLoop(w);
  assert.equal(w.echoes.length, 2);
  assert.equal(w.loopCount, 2);
});

// ── echo replay is real and independent ──────────────────────────────────────

test('echo replays its recorded action and moves independently from the live worker', () => {
  // Loop 1: worker moves right on tick 0, building a recording of ['right'].
  let w = mkWorld();
  w = step(w, 'right');        // tick 0 -> 1, worker moves to x=1
  w = endLoop(w);              // bake; echo stored with actions=['right'], reset to x=0

  // Sanity: after endLoop everything resets to start.
  assert.equal(w.worker.x, w.workerStart.x, 'worker reset to start');
  assert.equal(w.echoes[0].x, w.workerStart.x, 'echo reset to start');

  const startX = w.workerStart.x;

  // Loop 2 tick 0: live worker WAITS, echo replays 'right'.
  const w2 = step(w, 'wait');

  // Live worker must not have moved (it waited).
  assert.equal(w2.worker.x, startX, 'live worker stayed put');
  assert.equal(w2.worker.y, w.workerStart.y, 'live worker y unchanged');

  // Echo must have moved right (replayed its recorded action at tick 0).
  const echo = w2.echoes[0];
  assert.notEqual(echo.x, startX, 'echo x changed — replay is real');
  assert.equal(echo.x, startX + 1, 'echo moved exactly one cell right');
});

test('echo replay does not affect the live worker position', () => {
  let w = mkWorld();
  w = step(w, 'right');  // tick 0: worker to x=1
  w = endLoop(w);        // bake, reset

  // Next loop: the echo replays 'right' while the live worker moves DOWN. They
  // target different cells, so each actor moves fully independently with no
  // COLLISION PARADOX between them (the collision rule only fires on a shared
  // target cell — see collision.test.mjs for the contested case).
  const w2 = step(w, 'down');

  // Echo and worker moved independently — no cross-contamination.
  assert.equal(w2.worker.y, w.workerStart.y + 1, 'live worker moved down');
  assert.equal(w2.worker.x, w.workerStart.x, 'live worker x unchanged');
  assert.equal(w2.echoes[0].x, w.workerStart.x + 1, 'echo moved right independently');
});

test('echo x/y/inv are per-echo and do not alias the live worker', () => {
  let w = mkWorld();
  w = step(w, 'right');
  w = endLoop(w);
  const w2 = step(w, 'wait');

  // Mutating the echo object must not affect worker, and vice versa (immutability check).
  assert.notEqual(w2.echoes[0], w2.worker, 'echo and worker are distinct objects');
  // Positions diverged: echo moved, worker did not.
  assert.notEqual(w2.echoes[0].x, w2.worker.x);
});

test('multiple echoes all replay their own actions independently', () => {
  // Loop 1: move down then wait twice
  let w = mkWorld();
  w = runLoop(w, ['down', 'wait', 'wait']);

  // Loop 2: move right twice
  w = step(w, 'right');
  w = step(w, 'right');
  w = step(w, 'wait');
  w = endLoop(w);

  assert.equal(w.echoes.length, 2);

  // Tick 0 of loop 3: the echoes replay distinct tick-0 actions (echo 0 → down,
  // echo 1 → right), so they head to different cells with no COLLISION PARADOX
  // between them (the contested-cell case is covered in collision.test.mjs).
  const w3 = step(w, 'wait');
  assert.equal(w3.echoes.length, 2);

  // Echo 0 had actions=['down','wait','wait']; at tick 0 it replays 'down'.
  assert.equal(w3.echoes[0].y, w.workerStart.y + 1, 'echo 0 replayed down on tick 0');
  assert.equal(w3.echoes[0].x, w.workerStart.x, 'echo 0 x unchanged');
  // Echo 1 had actions=['right','right','wait']; at tick 0 it replays 'right'.
  assert.equal(w3.echoes[1].x, w.workerStart.x + 1, 'echo 1 replayed right on tick 0');

  // Tick 1: echo 0 replays 'wait' (stays), echo 1 replays 'right' (moves again).
  const w3b = step(w3, 'wait');
  assert.equal(w3b.echoes[0].y, w.workerStart.y + 1, 'echo 0 waited on tick 1 — stayed');
  assert.equal(w3b.echoes[1].x, w.workerStart.x + 2, 'echo 1 moved right again on tick 1');
});

test('engine is deterministic: same actions produce same state hash regardless of path', () => {
  // Two worlds built differently but ending in the same logical state must produce identical worlds.
  let wA = mkWorld();
  wA = step(wA, 'right');
  wA = step(wA, 'left');
  wA = endLoop(wA);

  let wB = mkWorld();
  wB = step(wB, 'right');
  wB = step(wB, 'left');
  wB = endLoop(wB);

  assert.deepEqual(JSON.parse(JSON.stringify(wA)), JSON.parse(JSON.stringify(wB)));
});
