// Canvas 2D renderer for the tile-game engine.
// Pure presentation: this module reads world state and draws it. It contains
// NO game logic — it never mutates the world and never decides what happens
// next, it only paints what already is.

// Tile glyph → fill colour. Glyphs mirror the engine's ASCII tiles:
//   '.' empty   '#' wall   'O' ore   'X' output
const TILE_COLORS = {
  '.': '#1b1f2a', // empty floor
  '#': '#454c5e', // wall
  'O': '#e0a73c', // ore deposit
  'X': '#3ca0e0', // output / delivery
};

const EMPTY_COLOR = TILE_COLORS['.'];
const GRID_COLOR = '#11141c';
const WORKER_COLOR = '#f4f4f6';
const ECHO_COLOR = 'rgba(244, 244, 246, 0.35)';
const INV_COLOR = '#e0a73c';

// Draw the full world: tiles, echoes (translucent ghosts), the live worker
// (solid circle), and a small inventory indicator.
//   ctx   – a Canvas 2D rendering context (or compatible stub)
//   world – an engine world object (see engine.js)
//   cell  – pixel size of one tile cell
export function drawWorld(ctx, world, cell = 24) {
  if (!ctx || !world) return;

  const { width = 0, height = 0, tiles = [] } = world;

  // ── Tiles ──
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const glyph = tiles[r]?.[c] ?? '.';
      ctx.fillStyle = TILE_COLORS[glyph] ?? EMPTY_COLOR;
      ctx.fillRect(c * cell, r * cell, cell, cell);

      // Thin grid outline so cells stay legible.
      ctx.strokeStyle = GRID_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(c * cell, r * cell, cell, cell);
    }
  }

  const radius = cell * 0.32;
  const center = (n) => n * cell + cell / 2;

  // ── Echoes: translucent ghost circles ──
  ctx.fillStyle = ECHO_COLOR;
  for (const echo of world.echoes ?? []) {
    ctx.beginPath();
    ctx.arc(center(echo.x), center(echo.y), radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Live worker: solid circle ──
  const worker = world.worker ?? { x: world.pos?.c ?? 0, y: world.pos?.r ?? 0 };
  ctx.fillStyle = WORKER_COLOR;
  ctx.beginPath();
  ctx.arc(center(worker.x), center(worker.y), radius, 0, Math.PI * 2);
  ctx.fill();

  // ── Inventory indicator: one small pip per carried item, top-left. ──
  drawInventory(ctx, world, cell);
}

// Small inventory indicator — a row of pips, one per held item, drawn in the
// top-left corner. Pure helper, no logic beyond reading inv length.
function drawInventory(ctx, world, cell) {
  const inv = world.inv ?? [];
  const capacity = world.capacity ?? inv.length;
  const pip = Math.max(2, cell * 0.18);
  const gap = pip * 0.6;
  const y = gap;

  for (let i = 0; i < capacity; i++) {
    const x = gap + i * (pip + gap);
    ctx.fillStyle = i < inv.length ? INV_COLOR : 'rgba(224, 167, 60, 0.2)';
    ctx.fillRect(x, y, pip, pip);
  }
}
