// PARADOX FOUNDRY — deterministic simulation core.
//
// This module is PURE: no DOM, no randomness, no clock, no I/O. Every public function
// takes a world and returns a brand-new world (the input is never mutated). Given the same
// inputs it produces byte-identical outputs — which is exactly what makes the frozen goaly
// verifier (the `node --test` suite) able to pin the game's behaviour so it can't regress.
//
// The game is a time-loop, multi-agent automation puzzle. You drive a single worker for a
// fixed-length loop. When the loop ends, the worker's recorded action stream is "baked" into a
// permanent ECHO that replays — in lock-step, every future loop — alongside the live worker.
// You bootstrap an entire factory out of cooperating copies of your past selves. When two
// actors (echoes and/or the live worker) fight over the same cell or the same resource, the
// engine records a PARADOX, which the player must design around.

/** @typedef {'empty'|'wall'|'ore'|'forge'|'assembler'|'output'|'button'|'gate'} TileType */

/** The six primitive actions an actor can take on a tick. */
export const ACTIONS = Object.freeze(['up', 'down', 'left', 'right', 'wait', 'act']);

/** Default crafting graph: ore --forge--> metal, 2 metal --assembler--> gear, gear --output--> core. */
export const DEFAULT_RECIPES = Object.freeze({
  forge: { in: { ore: 1 }, out: 'metal', time: 2 },
  assembler: { in: { metal: 2 }, out: 'gear', time: 3 },
});

const DELTA = Object.freeze({
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
});

const MACHINE_TYPES = Object.freeze(['forge', 'assembler']);

/** A glyph alphabet for ASCII levels (used by {@link parseLevel} and the bundled levels). */
export const GLYPHS = Object.freeze({
  '.': () => ({ type: 'empty' }),
  '#': () => ({ type: 'wall' }),
  O: () => ({ type: 'ore', amount: Infinity }),
  o: () => ({ type: 'ore', amount: 12 }),
  F: () => ({ type: 'forge', buf: {}, output: 0, progress: 0, cooking: false }),
  A: () => ({ type: 'assembler', buf: {}, output: 0, progress: 0, cooking: false }),
  X: () => ({ type: 'output' }),
});

function clone(value) {
  return structuredClone(value);
}

function idx(world, x, y) {
  return y * world.width + x;
}

function inBounds(world, x, y) {
  return x >= 0 && y >= 0 && x < world.width && y < world.height;
}

/** The tile at (x,y), or a wall sentinel when out of bounds (so the edge is solid). */
export function tileAt(world, x, y) {
  if (!inBounds(world, x, y)) return { type: 'wall' };
  return world.tiles[idx(world, x, y)];
}

function isMachine(tile) {
  return MACHINE_TYPES.includes(tile.type);
}

/**
 * Build a world from an ASCII map plus options. Unknown glyphs throw (fail-closed). Special
 * cells: the worker start is marked with '@', buttons with a digit `1-9`, gates with `a-i`
 * (gate `a` is opened by button `1`, `b` by `2`, …). Everything else comes from {@link GLYPHS}.
 *
 * @param {string} ascii rows separated by newlines; every row must be the same width.
 * @param {object} [opts]
 * @param {number} [opts.loopLength=24] ticks per loop.
 * @param {number} [opts.targetScore=1] cores required to win.
 * @param {number} [opts.capacity=3] worker/echo inventory size.
 * @param {object} [opts.recipes=DEFAULT_RECIPES] crafting graph.
 */
export function parseLevel(ascii, opts = {}) {
  const rows = ascii.replace(/\n$/, '').split('\n');
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  if (width === 0) throw new Error('parseLevel: empty level');
  const tiles = new Array(width * height);
  let workerStart = null;
  for (let y = 0; y < height; y++) {
    const row = rows[y];
    if (row.length !== width) throw new Error(`parseLevel: row ${y} width ${row.length} != ${width}`);
    for (let x = 0; x < width; x++) {
      const ch = row[x];
      const here = y * width + x;
      if (ch === '@') {
        workerStart = { x, y };
        tiles[here] = { type: 'empty' };
      } else if (ch >= '1' && ch <= '9') {
        tiles[here] = { type: 'button', link: ch.charCodeAt(0) - '1'.charCodeAt(0) };
      } else if (ch >= 'a' && ch <= 'i') {
        tiles[here] = { type: 'gate', link: ch.charCodeAt(0) - 'a'.charCodeAt(0) };
      } else {
        const make = GLYPHS[ch];
        if (!make) throw new Error(`parseLevel: unknown glyph '${ch}' at (${x},${y})`);
        tiles[here] = make();
      }
    }
  }
  if (!workerStart) throw new Error('parseLevel: no worker start (@)');
  return createWorld({
    width,
    height,
    tiles,
    workerStart,
    loopLength: opts.loopLength ?? 24,
    targetScore: opts.targetScore ?? 1,
    capacity: opts.capacity ?? 3,
    recipes: opts.recipes ?? DEFAULT_RECIPES,
  });
}

/**
 * Construct an initial world. The caller supplies the tile array and worker start; everything
 * dynamic (tick, echoes, score, paradoxes) starts empty. The initial tile snapshot is kept so a
 * loop reset is exact and reproducible.
 */
export function createWorld({ width, height, tiles, workerStart, loopLength = 24, targetScore = 1, capacity = 3, recipes = DEFAULT_RECIPES }) {
  const initialTiles = clone(tiles);
  return {
    width,
    height,
    tiles: clone(tiles),
    initialTiles,
    workerStart: { ...workerStart },
    loopLength,
    targetScore,
    capacity,
    recipes: clone(recipes),
    tick: 0,
    loopCount: 0,
    worker: { x: workerStart.x, y: workerStart.y, inv: [] },
    recording: [],
    echoes: [],
    score: 0,
    paradoxes: { collision: 0, starvation: 0 },
    events: [],
    status: 'playing',
  };
}

/** Every actor that acts on a tick, in resolution PRIORITY order: oldest echo first, live worker last. */
function actorsInPriority(world) {
  const list = world.echoes.map((e, i) => ({ kind: 'echo', i, ref: e }));
  list.push({ kind: 'worker', i: -1, ref: world.worker });
  return list;
}

/** The action an actor takes this tick: echoes replay their recording; the worker uses `liveAction`. */
function actionFor(entry, tick, liveAction) {
  if (entry.kind === 'worker') return liveAction;
  return entry.ref.actions[tick] ?? 'wait';
}

/** Which gate links are open this tick: a gate is open while any actor stands on a linked button. */
function openLinks(world, actors) {
  const open = new Set();
  for (const a of actors) {
    const t = tileAt(world, a.ref.x, a.ref.y);
    if (t.type === 'button') open.add(t.link);
  }
  return open;
}

function passable(world, x, y, openSet) {
  if (!inBounds(world, x, y)) return false;
  const t = tileAt(world, x, y);
  if (t.type === 'wall') return false;
  if (t.type === 'gate') return openSet.has(t.link);
  return true;
}

/**
 * Resolve simultaneous movement deterministically, counting a collision paradox each time an
 * actor is forced to give up its move. The rule, by descending priority:
 *  - a move into a wall / closed gate / out of bounds is simply blocked (terrain, not a paradox);
 *  - otherwise actors are demoted to "stays put" by a monotonic fixpoint: a mover loses if its
 *    target is occupied by an actor that stays, or if a higher-priority mover claims the same cell.
 * Demotions only ever grow the "stationary" set, so the loop terminates in ≤ N passes.
 *
 * @returns {{ moves: Map<number,{x:number,y:number}>, collisions: number }}
 */
function resolveMovement(world, actors, actions, openSet) {
  const targets = new Map(); // actor index in `actors` -> desired cell
  const stationary = new Set(); // indices that stay at their current cell
  let collisions = 0;

  actors.forEach((a, i) => {
    const act = actions[i];
    const d = DELTA[act];
    if (!d) {
      stationary.add(i); // wait/act: never moves
      return;
    }
    const nx = a.ref.x + d.dx;
    const ny = a.ref.y + d.dy;
    if (!passable(world, nx, ny, openSet)) {
      stationary.add(i); // blocked by terrain — not a paradox
      return;
    }
    targets.set(i, { x: nx, y: ny });
  });

  const cellOf = (i) => `${actors[i].ref.x},${actors[i].ref.y}`;
  let changed = true;
  while (changed) {
    changed = false;
    const stayCells = new Set([...stationary].map(cellOf));
    // Highest-priority surviving mover wins each contested target; `actors` is already priority-ordered.
    const claimed = new Map(); // "x,y" -> winning actor index
    for (const [i, t] of targets) {
      const key = `${t.x},${t.y}`;
      if (!claimed.has(key)) claimed.set(key, i);
    }
    for (const [i, t] of [...targets]) {
      const key = `${t.x},${t.y}`;
      const losesContest = claimed.get(key) !== i;
      const blockedByStayer = stayCells.has(key);
      if (losesContest || blockedByStayer) {
        targets.delete(i);
        stationary.add(i);
        collisions++;
        changed = true;
      }
    }
  }
  return { moves: targets, collisions };
}

/** Deposit one input item from inventory into a machine's buffer, or `null` if nothing fits. */
function tryDeposit(actor, tile, recipe) {
  for (const item of Object.keys(recipe.in)) {
    const have = actor.inv.indexOf(item);
    const buffered = tile.buf[item] ?? 0;
    if (have !== -1 && buffered < recipe.in[item]) return item;
  }
  return null;
}

/**
 * Apply one actor's `act` at its (post-movement) cell, mutating the supplied draft world.
 * Returns `'ok'` if something happened, `'starve'` if the act was a wasted reach (machine empty,
 * inventory full, ore exhausted, no gear to ship), or `'noop'` if the tile isn't interactable.
 */
function applyAct(draft, actor) {
  const tile = draft.tiles[idx(draft, actor.x, actor.y)];
  if (tile.type === 'ore') {
    if (actor.inv.length >= draft.capacity || tile.amount <= 0) return 'starve';
    actor.inv.push('ore');
    if (tile.amount !== Infinity) tile.amount -= 1;
    return 'ok';
  }
  if (tile.type === 'output') {
    const g = actor.inv.indexOf('gear');
    if (g === -1) return 'starve';
    actor.inv.splice(g, 1);
    draft.score += 1;
    return 'ok';
  }
  if (isMachine(tile)) {
    const recipe = draft.recipes[tile.type];
    const depositItem = tryDeposit(actor, tile, recipe);
    if (depositItem) {
      actor.inv.splice(actor.inv.indexOf(depositItem), 1);
      tile.buf[depositItem] = (tile.buf[depositItem] ?? 0) + 1;
      return 'ok';
    }
    if (tile.output > 0 && actor.inv.length < draft.capacity) {
      tile.output -= 1;
      actor.inv.push(recipe.out);
      return 'ok';
    }
    return 'starve';
  }
  return 'noop';
}

/** Advance every machine one tick: finish a cooking batch, then start a new one if inputs are buffered. */
function tickMachines(draft) {
  for (const tile of draft.tiles) {
    if (!isMachine(tile)) continue;
    const recipe = draft.recipes[tile.type];
    if (tile.cooking) {
      tile.progress -= 1;
      if (tile.progress <= 0) {
        tile.cooking = false;
        tile.output += 1;
      }
    }
    if (!tile.cooking) {
      const ready = Object.keys(recipe.in).every((it) => (tile.buf[it] ?? 0) >= recipe.in[it]);
      if (ready) {
        for (const it of Object.keys(recipe.in)) tile.buf[it] -= recipe.in[it];
        tile.cooking = true;
        tile.progress = recipe.time;
      }
    }
  }
}

/**
 * Advance the world by ONE tick. Every echo replays its recorded action for the current tick and
 * the live worker performs `liveAction`; movement is resolved together (collision paradoxes), then
 * acts are applied in priority order (starvation paradoxes), then machines cook. The live action is
 * appended to the recording so the loop can later be baked into an echo. Returns a NEW world.
 */
export function step(world, liveAction) {
  if (world.status === 'won') return world;
  if (!ACTIONS.includes(liveAction)) throw new Error(`step: unknown action '${liveAction}'`);
  const draft = clone(world);
  const actors = actorsInPriority(draft);
  const actions = actors.map((a) => actionFor(a, draft.tick, liveAction));
  const events = [];

  const openSet = openLinks(draft, actors);
  const { moves, collisions } = resolveMovement(draft, actors, actions, openSet);
  draft.paradoxes.collision += collisions;
  if (collisions > 0) events.push({ kind: 'collision', count: collisions, tick: draft.tick });

  for (const [i, cell] of moves) {
    actors[i].ref.x = cell.x;
    actors[i].ref.y = cell.y;
  }

  // Acts resolve in priority order so a higher-priority actor consumes the shared resource first.
  actors.forEach((a, i) => {
    if (actions[i] !== 'act') return;
    const result = applyAct(draft, a.ref);
    if (result === 'starve') {
      draft.paradoxes.starvation += 1;
      events.push({ kind: 'starvation', actor: a.kind, at: { x: a.ref.x, y: a.ref.y }, tick: draft.tick });
    }
  });

  tickMachines(draft);

  draft.recording = [...draft.recording, liveAction];
  draft.tick += 1;
  draft.events = events;
  if (draft.score >= draft.targetScore) draft.status = 'won';
  return draft;
}

/**
 * Bake the just-finished loop into a permanent echo and reset the world for the next loop: tick
 * back to 0, machines/ore restored from the initial snapshot, all actors returned to the worker
 * start with empty inventories. Score and paradox tallies are CUMULATIVE across loops (they are the
 * player's running record). Returns a NEW world. Calling this mid-loop bakes a partial recording.
 */
export function endLoop(world) {
  const draft = clone(world);
  if (draft.recording.length > 0) {
    draft.echoes = [...draft.echoes, { actions: [...draft.recording], x: draft.workerStart.x, y: draft.workerStart.y, inv: [] }];
  }
  draft.tiles = clone(draft.initialTiles);
  draft.tick = 0;
  draft.loopCount += 1;
  draft.recording = [];
  draft.worker = { x: draft.workerStart.x, y: draft.workerStart.y, inv: [] };
  for (const e of draft.echoes) {
    e.x = draft.workerStart.x;
    e.y = draft.workerStart.y;
    e.inv = [];
  }
  draft.events = [];
  return draft;
}

/** Run a full loop from a flat action list, then bake it into an echo. Convenience for tests/AI. */
export function runLoop(world, actions) {
  let w = world;
  for (const a of actions) w = step(w, a);
  return endLoop(w);
}

/**
 * A stable, order-independent fingerprint of the entire dynamic world state. Two worlds reached by
 * any path collide iff they are observationally identical — the determinism backbone of the test
 * suite. Pure string hash (FNV-1a) so it needs no crypto and is identical in node and the browser.
 */
export function hashState(world) {
  const machines = world.tiles.map((t) =>
    isMachine(t) ? `${t.type}|${JSON.stringify(t.buf)}|${t.output}|${t.progress}|${t.cooking ? 1 : 0}` : t.type === 'ore' ? `ore${t.amount}` : t.type,
  );
  const echoes = world.echoes.map((e) => `${e.x},${e.y}:${e.inv.join('+')}`);
  const payload = JSON.stringify({
    t: world.tick,
    l: world.loopCount,
    w: `${world.worker.x},${world.worker.y}:${world.worker.inv.join('+')}`,
    e: echoes,
    m: machines,
    s: world.score,
    p: world.paradoxes,
    st: world.status,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Serialize a world to a plain JSON-safe object (Infinity ore -> null sentinel). */
export function serialize(world) {
  return JSON.parse(
    JSON.stringify(world, (_k, v) => (v === Infinity ? '∞' : v)),
  );
}

/** Inverse of {@link serialize}; restores the Infinity sentinel. Fails on a non-object. */
export function deserialize(data) {
  if (typeof data !== 'object' || data === null) throw new Error('deserialize: not an object');
  return JSON.parse(JSON.stringify(data), (_k, v) => (v === '∞' ? Infinity : v));
}
