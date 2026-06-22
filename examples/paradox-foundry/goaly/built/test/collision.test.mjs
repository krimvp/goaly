// Collision-paradox verification for src/engine.js.
// Two actors contesting the same cell: older echo wins, loser stays put,
// world.paradoxes.collision increments. Engine must remain pure (no mutation).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLevel, step, runLoop } from '../src/engine.js';

const drive = (world, actions) => actions.reduce((w, a) => step(w, a), world);

test('collision: paradoxes.collision initializes to 0 on a fresh world', () => {
  const w = parseLevel('@.', { loopLength: 4 });
  assert.equal(typeof w.paradoxes, 'object', 'paradoxes must be an object');
  assert.equal(w.paradoxes.collision, 0, 'paradoxes.collision must start at 0');
});

test('collision: older echo beats the live worker for the same target cell', () => {
  // Level: '@' at x=0, open cell at x=1.
  const w = parseLevel('@.', { loopLength: 3 });
  // Bake echo[0] with action 'right' — it will replay right on tick 0 each loop.
  const looped = runLoop(w, ['right']);
  assert.equal(looped.echoes.length, 1);
  assert.equal(looped.paradoxes.collision, 0, 'no collision yet after first loop bake');

  // Tick 0 of loop 2: echo[0] targets (1,0), worker also targets (1,0) — COLLISION.
  const next = step(looped, 'right');

  // Echo (higher priority, older) moves to the contested cell.
  assert.equal(next.echoes[0].x, 1, 'echo advanced to contested cell');
  assert.equal(next.echoes[0].y, 0);

  // Worker (lower priority) stays put.
  assert.equal(next.worker.x, 0, 'worker stayed put after losing the contest');
  assert.equal(next.worker.y, 0);

  // Collision counter incremented exactly once.
  assert.equal(next.paradoxes.collision, 1, 'paradoxes.collision incremented to 1');
});

test('collision: two echoes contest the same cell — older (lower-index) echo wins', () => {
  const w = parseLevel('@.', { loopLength: 4 });
  // Loop 1: bake echo[0] with ['right']
  const loop1 = runLoop(w, ['right']);
  // Loop 2: bake echo[1] with ['right']; worker also moves right but that's another loop
  const loop2 = runLoop(loop1, ['right']);
  assert.equal(loop2.echoes.length, 2);

  // Tick 0 of loop 3: echo[0] and echo[1] both replay 'right' -> both target (1,0).
  // Worker waits — not involved in this particular contest.
  const next = step(loop2, 'wait');

  // echo[0] (oldest, index 0) wins.
  assert.equal(next.echoes[0].x, 1, 'echo[0] (oldest) advanced to contested cell');
  assert.equal(next.echoes[0].y, 0);

  // echo[1] (newer, index 1) stays put.
  assert.equal(next.echoes[1].x, 0, 'echo[1] (newer) stayed put after losing the contest');
  assert.equal(next.echoes[1].y, 0);

  // Collision counter records the echo-vs-echo contest.
  assert.ok(next.paradoxes.collision >= 1, 'echo-vs-echo collision counted');
});

test('collision: no collision when actors target different cells', () => {
  // Open 3-cell level so echo can move to x=1 without worker contesting it.
  const w = parseLevel('@..', { loopLength: 4 });
  // Bake echo that moves right (to x=1).
  const looped = runLoop(w, ['right']);

  // Worker waits — echo moves freely to (1,0) with no contest.
  const next = step(looped, 'wait');

  assert.equal(next.paradoxes.collision, 0, 'no collision when actors do not share a target');
  assert.equal(next.echoes[0].x, 1, 'echo moved freely');
  assert.equal(next.worker.x, 0, 'worker stayed as expected');
});

test('collision: counter accumulates across multiple ticks', () => {
  // '@.' — echo baked with 'right'. After loop bake both echo and worker start at (0,0).
  const w = parseLevel('@.', { loopLength: 4 });
  const looped = runLoop(w, ['right']);

  // Tick 0: echo and worker both target (1,0) — echo wins, collision=1.
  const t0 = step(looped, 'right');
  assert.equal(t0.paradoxes.collision, 1);

  // Tick 1: echo has no recorded action for tick 1 -> waits (stays at (1,0)).
  //         Worker tries right to (1,0) where the stationary echo sits — collision=2.
  const t1 = step(t0, 'right');
  assert.equal(t1.paradoxes.collision, 2);

  // Tick 2: same geometry — collision=3.
  const t2 = step(t1, 'right');
  assert.equal(t2.paradoxes.collision, 3);
});

test('collision: step() is pure — input world is never mutated', () => {
  const w = parseLevel('@.', { loopLength: 3 });
  const looped = runLoop(w, ['right']);

  const collBefore = looped.paradoxes.collision;
  const workerXBefore = looped.worker.x;
  const echoXBefore = looped.echoes[0].x;

  // Cause a collision — this must not mutate `looped`.
  step(looped, 'right');

  assert.equal(looped.paradoxes.collision, collBefore, 'input paradoxes.collision not mutated');
  assert.equal(looped.worker.x, workerXBefore, 'input worker.x not mutated');
  assert.equal(looped.echoes[0].x, echoXBefore, 'input echo[0].x not mutated');
});
