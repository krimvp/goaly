// Frozen success contract for PARADOX FOUNDRY's simulation core.
//
// Pure Node built-in test runner (`node --test`) — zero dependencies, runs fully offline. This is
// the deterministic bar goaly compiles, freezes, and re-checks every loop iteration: it pins
// movement, the crafting graph, echo replay, both paradox classes, the gate/button coordination
// mechanic, determinism, and a full end-to-end "ship a core" run. If any of these regress, the
// frozen verifier fails closed and goaly never declares the run DONE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS,
  DEFAULT_RECIPES,
  parseLevel,
  step,
  endLoop,
  runLoop,
  hashState,
  serialize,
  deserialize,
  tileAt,
} from '../src/engine.js';

const drive = (world, actions) => actions.reduce((w, a) => step(w, a), world);

test('parseLevel: dimensions, worker start, and fail-closed on bad input', () => {
  const w = parseLevel('@.O\n###', { loopLength: 5 });
  assert.equal(w.width, 3);
  assert.equal(w.height, 2);
  assert.deepEqual(w.workerStart, { x: 0, y: 0 });
  assert.equal(tileAt(w, 2, 0).type, 'ore');
  assert.equal(tileAt(w, 1, 1).type, 'wall');
  assert.throws(() => parseLevel('@?'), /unknown glyph/);
  assert.throws(() => parseLevel('@.\n#'), /width/);
  assert.throws(() => parseLevel('...'), /no worker start/);
});

test('movement: walls and the world edge are solid; open cells are walked', () => {
  const w = parseLevel('@.#', { loopLength: 5 });
  const a = step(w, 'right');
  assert.deepEqual([a.worker.x, a.worker.y], [1, 0]);
  const b = step(a, 'right'); // into the wall — blocked, not a paradox
  assert.deepEqual([b.worker.x, b.worker.y], [1, 0]);
  assert.equal(b.paradoxes.collision, 0);
  const c = step(w, 'up'); // off the top edge — blocked
  assert.deepEqual([c.worker.x, c.worker.y], [0, 0]);
});

test('mining: act yields ore, respects inventory capacity, and depletes finite nodes', () => {
  const w = parseLevel('@O', { loopLength: 10, capacity: 2 });
  let s = step(w, 'right'); // onto the ore (infinite node)
  s = drive(s, ['act', 'act']);
  assert.deepEqual(s.worker.inv, ['ore', 'ore']);
  const full = step(s, 'act'); // capacity 2 reached -> wasted reach
  assert.equal(full.paradoxes.starvation, 1);
  assert.deepEqual(full.worker.inv, ['ore', 'ore']);

  const finite = parseLevel('@o', { loopLength: 30, capacity: 3 }); // 'o' = 12 units
  let f = step(finite, 'right');
  f = drive(f, ['act', 'act', 'act']);
  assert.deepEqual(f.worker.inv, ['ore', 'ore', 'ore']);
  assert.equal(tileAt(f, 1, 0).amount, 9);
});

test('crafting graph: forge cooks ore into metal on its recipe timer', () => {
  const w = parseLevel('@FO', { loopLength: 20 });
  // mine an ore (move past forge to the ore at x=2), come back and deposit.
  let s = drive(w, ['right', 'right', 'act', 'left']); // now on forge with 1 ore
  assert.deepEqual(s.worker.inv, ['ore']);
  s = step(s, 'act'); // deposit -> machine starts cooking (recipe time 2)
  assert.deepEqual(s.worker.inv, []);
  s = drive(s, ['wait', 'wait', 'act']); // cook 2 ticks, then collect the metal
  assert.deepEqual(s.worker.inv, ['metal']);
});

test('crafting graph: assembler consumes two metal to make a gear', () => {
  assert.equal(DEFAULT_RECIPES.assembler.in.metal, 2);
  // Hand-place an assembler with two metal already buffered, then cook + collect.
  const w = parseLevel('@A', { loopLength: 20 });
  let s = step(w, 'right'); // onto the assembler
  s.worker.inv = ['metal', 'metal']; // start this actor holding two metal
  s = drive(s, ['act', 'act']); // deposit both -> assembler starts (recipe time 3)
  s = drive(s, ['wait', 'wait', 'wait', 'act']); // cook 3 ticks then collect the gear
  assert.deepEqual(s.worker.inv, ['gear']);
});

test('echo replay: a baked loop runs as an independent actor next loop', () => {
  const w = parseLevel('@O', { loopLength: 4 });
  const looped = runLoop(w, ['right', 'act']); // bake an echo that mines one ore
  assert.equal(looped.echoes.length, 1);
  assert.equal(looped.loopCount, 1);
  assert.deepEqual(looped.worker.inv, []); // worker reset for the new loop
  // Next loop: the worker stands still; the echo replays right+act and mines on its own.
  const replay = drive(looped, ['wait', 'wait']);
  assert.deepEqual(replay.echoes[0].inv, ['ore']);
  assert.deepEqual(replay.worker.inv, []);
});

test('collision paradox: contested moves resolve by priority (older echo wins)', () => {
  const w = parseLevel('@.', { loopLength: 3 });
  const looped = runLoop(w, ['right']); // echo will step right each loop
  const next = step(looped, 'right'); // worker AND echo both target (1,0)
  assert.equal(next.paradoxes.collision, 1);
  assert.deepEqual([next.echoes[0].x, next.echoes[0].y], [1, 0]); // echo (priority) advanced
  assert.deepEqual([next.worker.x, next.worker.y], [0, 0]); // worker yielded
});

test('starvation paradox: a wasted act on an empty interactable is recorded', () => {
  const w = parseLevel('@X', { loopLength: 4 }); // output pad, no gear in hand
  const s = drive(w, ['right', 'act']);
  assert.equal(s.paradoxes.starvation, 1);
  assert.equal(s.score, 0);
});

test('coordination: a gate only opens while an actor holds its linked button', () => {
  // (0,0) start, (1,0) gate 'a'(link0); (0,1) button '1'(link0).
  const w = parseLevel('@a\n1.', { loopLength: 6 });
  // No echo yet: the worker cannot cross the closed gate.
  const blocked = step(w, 'right');
  assert.deepEqual([blocked.worker.x, blocked.worker.y], [0, 0]);
  // Bake an echo that goes down onto the button and holds it.
  const looped = runLoop(w, ['down']);
  // Next loop: wait one tick for the echo to reach the button, then walk through the open gate.
  const open = drive(looped, ['wait', 'right']);
  assert.deepEqual([open.echoes[0].x, open.echoes[0].y], [0, 1]); // echo on the button
  assert.deepEqual([open.worker.x, open.worker.y], [1, 0]); // worker crossed the now-open gate
});

test('determinism: identical inputs yield identical state; step never mutates its input', () => {
  const w = parseLevel('@.O.F', { loopLength: 12 });
  const plan = ['right', 'right', 'act', 'left', 'left', 'wait'];
  const before = hashState(w);
  const a = drive(w, plan);
  assert.equal(hashState(w), before, 'original world must be untouched (immutability)');
  const b = drive(parseLevel('@.O.F', { loopLength: 12 }), plan);
  assert.equal(hashState(a), hashState(b), 'same inputs -> same fingerprint');
});

test('serialization round-trips exactly, including infinite ore nodes', () => {
  const w = drive(parseLevel('@O.F', { loopLength: 8 }), ['right', 'act', 'left']);
  const restored = deserialize(serialize(w));
  assert.equal(hashState(restored), hashState(w));
  assert.equal(tileAt(restored, 1, 0).amount, Infinity);
  assert.throws(() => deserialize(null), /not an object/);
});

test('end-to-end: a single planned loop mines, forges, assembles, and ships a core', () => {
  // Corridor: start . ore . forge . assembler . output
  const w = parseLevel('@.O.F.A.X', { loopLength: 40, targetScore: 1 });
  const plan = [
    'right', 'right', 'act', 'act', // mine two ore
    'right', 'right', 'act', 'act', // deposit both into the forge
    'wait', 'act', 'wait', 'act', // collect two metal as they cook
    'right', 'right', 'act', 'act', // deposit both metal into the assembler
    'wait', 'wait', 'wait', 'act', // cook (time 3) then collect the gear
    'right', 'right', 'act', // ship the gear at the output -> a core
  ];
  const done = drive(w, plan);
  assert.equal(done.score, 1);
  assert.equal(done.status, 'won');
  assert.equal(done.paradoxes.collision, 0);
  assert.equal(done.paradoxes.starvation, 0);
});

test('ACTIONS is the closed action set and unknown actions fail closed', () => {
  assert.deepEqual([...ACTIONS].sort(), ['act', 'down', 'left', 'right', 'up', 'wait']);
  assert.throws(() => step(parseLevel('@.', { loopLength: 3 }), 'teleport'), /unknown action/);
});
