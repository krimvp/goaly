// Pure ES module grid-game engine. No DOM, no Math.random, no Date.

const DEFAULT_SIZE = 8;

export function createWorld(width, height) {
  // Two supported shapes, both pure data:
  //  - createWorld(width, height) -> flat {width,height,x,y} (legacy callers)
  //  - createWorld()              -> {width,height,player:{x,y},walls:[]}
  if (width === undefined) {
    return {
      width: DEFAULT_SIZE,
      height: DEFAULT_SIZE,
      x: 0,
      y: 0,
      player: { x: 0, y: 0 },
      walls: [],
    };
  }
  return { width, height, x: 0, y: 0 };
}

const DELTAS = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

export function addWall(world, x, y) {
  const walls = Array.isArray(world.walls) ? world.walls : [];
  return { ...world, walls: [...walls, { x, y }] };
}

export function step(world, dir) {
  const delta = DELTAS[dir] || { dx: 0, dy: 0 };
  const usesPlayer = world.player !== undefined;
  const cur = usesPlayer ? world.player : { x: world.x, y: world.y };

  const nx = clamp(cur.x + delta.dx, 0, world.width - 1);
  const ny = clamp(cur.y + delta.dy, 0, world.height - 1);

  const walls = Array.isArray(world.walls) ? world.walls : [];
  const blocked = walls.some((w) => w.x === nx && w.y === ny);

  const fx = blocked ? cur.x : nx;
  const fy = blocked ? cur.y : ny;

  if (usesPlayer) {
    return { ...world, x: fx, y: fy, player: { x: fx, y: fy } };
  }
  const next = { width: world.width, height: world.height, x: fx, y: fy };
  if (Array.isArray(world.walls)) next.walls = world.walls;
  return next;
}

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
