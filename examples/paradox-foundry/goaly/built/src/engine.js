// Pure tile-game engine: no DOM, no Math.random, no Date.

const DELTAS = {
  up: { dr: -1, dc: 0 },
  down: { dr: 1, dc: 0 },
  left: { dr: 0, dc: -1 },
  right: { dr: 0, dc: 1 },
};

const DEFAULT_CAPACITY = 3;

export function parseLevel(ascii, options = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  const lines = ascii.split('\n');
  const height = lines.length;
  const width = lines.reduce((max, line) => Math.max(max, line.length), 0);

  const tiles = [];
  let pos = { r: 0, c: 0 };

  for (let r = 0; r < height; r++) {
    const row = [];
    const line = lines[r];
    for (let c = 0; c < width; c++) {
      const ch = line[c] ?? '.';
      if (ch === '@') {
        pos = { r, c };
        row.push('.');
      } else {
        row.push(ch);
      }
    }
    tiles.push(row);
  }

  // x/y mirror c/r for the time-loop actor model.
  const start = { x: pos.c, y: pos.r };

  return {
    width,
    height,
    tiles,
    pos,
    inv: [],
    capacity,
    tick: 0,
    // ── time-loop state ──
    worker: { x: start.x, y: start.y },
    workerStart: { x: start.x, y: start.y },
    recording: [],
    echoes: [],
    loopCount: 0,
    loopLength: options.loopLength ?? null,
    // ── paradox accounting ──
    paradoxes: { collision: 0 },
  };
}

// Apply a single action to an independent actor located at (x, y) holding `inv`.
// Returns a fresh { x, y, inv }; never mutates its inputs. Mirrors the live
// worker's movement / mining rules but operates in x/y (column/row) space.
function applyAction(world, x, y, inv, action) {
  let nx = x;
  let ny = y;
  const ninv = inv.slice();

  const delta = DELTAS[action];
  if (delta) {
    const nr = y + delta.dr;
    const nc = x + delta.dc;
    const inBounds = nr >= 0 && nr < world.height && nc >= 0 && nc < world.width;
    if (inBounds && world.tiles[nr][nc] !== '#') {
      nx = nc;
      ny = nr;
    }
  } else if (action === 'act') {
    const tile = world.tiles[y]?.[x];
    if (tile === 'O' && ninv.length < world.capacity) {
      ninv.push('ore');
    }
  }
  // 'wait' and unknown actions are no-ops.

  return { x: nx, y: ny, inv: ninv };
}

export function step(world, action) {
  const tick = world.tick;

  // ── 1. Compute every actor's INTENDED target for this tick, each as an
  //       independent actor with its own x/y/inv. Echoes replay their recorded
  //       action; the live worker uses the supplied action. ──
  const echoTargets = (world.echoes ?? []).map(echo => {
    const replayed = echo.actions[tick];
    return {
      actions: echo.actions.slice(),
      x: echo.x,
      y: echo.y,
      moved: applyAction(world, echo.x, echo.y, echo.inv, replayed),
    };
  });

  const workerX = world.worker?.x ?? world.pos.c;
  const workerY = world.worker?.y ?? world.pos.r;
  const workerMoved = applyAction(world, workerX, workerY, world.inv, action);

  // ── 2. COLLISION PARADOX resolution. Actors commit in priority order — older
  //       echoes (lower index) first, then the live worker last. An actor that
  //       tries to MOVE into a cell already claimed by a higher-priority actor
  //       loses the contest: it stays put and a collision paradox is recorded.
  //       This is fully deterministic and never mutates `world`. ──
  const occupied = new Set();
  const cellKey = (x, y) => x + ',' + y;
  let collision = world.paradoxes?.collision ?? 0;

  const commit = (curX, curY, moved) => {
    const wantsMove = moved.x !== curX || moved.y !== curY;
    if (wantsMove && occupied.has(cellKey(moved.x, moved.y))) {
      // Contested cell already taken by an older/higher-priority actor: stay put.
      collision += 1;
      occupied.add(cellKey(curX, curY));
      return { x: curX, y: curY, inv: moved.inv };
    }
    occupied.add(cellKey(moved.x, moved.y));
    return { x: moved.x, y: moved.y, inv: moved.inv };
  };

  const echoes = echoTargets.map(e => {
    const committed = commit(e.x, e.y, e.moved);
    return { actions: e.actions, x: committed.x, y: committed.y, inv: committed.inv };
  });

  const workerCommitted = commit(workerX, workerY, workerMoved);

  // ── 3. Materialize the live worker state. ──
  const tiles = world.tiles.map(row => row.slice());
  const pos = { r: workerCommitted.y, c: workerCommitted.x };
  const inv = workerCommitted.inv;

  // ── 4. Record the live action. ──
  const recording = (world.recording ?? []).concat([action]);

  return {
    width: world.width,
    height: world.height,
    tiles,
    pos,
    inv,
    capacity: world.capacity,
    tick: tick + 1,
    worker: { x: pos.c, y: pos.r },
    workerStart: { x: world.workerStart.x, y: world.workerStart.y },
    recording,
    echoes,
    loopCount: world.loopCount ?? 0,
    loopLength: world.loopLength ?? null,
    paradoxes: { ...(world.paradoxes ?? {}), collision },
  };
}

// Bake the current recording into a new echo, then reset for the next loop:
// tick → 0, worker → workerStart, recording cleared, every echo reset to its
// start, loopCount incremented. Pure: never mutates `world`.
export function endLoop(world) {
  const start = { x: world.workerStart.x, y: world.workerStart.y };

  const baked = {
    actions: (world.recording ?? []).slice(),
    x: start.x,
    y: start.y,
    inv: [],
  };

  // Existing echoes reset to their start for the upcoming loop.
  const echoes = (world.echoes ?? [])
    .map(e => ({ actions: e.actions.slice(), x: start.x, y: start.y, inv: [] }))
    .concat([baked]);

  return {
    width: world.width,
    height: world.height,
    tiles: world.tiles.map(row => row.slice()),
    pos: { r: start.y, c: start.x },
    inv: [],
    capacity: world.capacity,
    tick: 0,
    worker: { x: start.x, y: start.y },
    workerStart: { x: start.x, y: start.y },
    recording: [],
    echoes,
    loopCount: (world.loopCount ?? 0) + 1,
    loopLength: world.loopLength ?? null,
    paradoxes: { collision: world.paradoxes?.collision ?? 0 },
  };
}

// Convenience: run a full loop of actions then bake it into an echo.
export function runLoop(world, actions) {
  let w = world;
  for (const action of actions) {
    w = step(w, action);
  }
  return endLoop(w);
}
