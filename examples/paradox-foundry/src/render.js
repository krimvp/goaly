// PARADOX FOUNDRY — canvas renderer (DOM side; intentionally NOT covered by the frozen verifier,
// which pins only the pure simulation core). Draws the grid, machines with live buffer/output/cook
// state, the gate/button links, the live worker, and every replaying echo as a translucent ghost.

const COLORS = {
  bg: '#0a0e1a',
  grid: '#1b2236',
  empty: '#121829',
  wall: '#070a12',
  ore: '#3a2f1c',
  oreEdge: '#caa84a',
  forge: '#3a1f1f',
  assembler: '#1f2f3a',
  output: '#13321f',
  outputEdge: '#39d98a',
  button: '#2a1f3a',
  gateClosed: '#3a1320',
  gateOpen: '#143a2a',
  worker: '#ffd34d',
  echo: '#6cc6ff',
};

const ITEM_GLYPH = { ore: '🪨', metal: '🔩', gear: '⚙️', core: '💠' };

/** A gate link is "lit" this frame iff some actor stands on a matching button. */
function openLinks(world) {
  const lit = new Set();
  const actors = [world.worker, ...world.echoes];
  for (const a of actors) {
    const t = world.tiles[a.y * world.width + a.x];
    if (t && t.type === 'button') lit.add(t.link);
  }
  return lit;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawTile(ctx, world, x, y, cell, lit) {
  const t = world.tiles[y * world.width + x];
  const px = x * cell;
  const py = y * cell;
  const pad = 2;
  let fill = COLORS.empty;
  if (t.type === 'wall') fill = COLORS.wall;
  else if (t.type === 'ore') fill = COLORS.ore;
  else if (t.type === 'forge') fill = COLORS.forge;
  else if (t.type === 'assembler') fill = COLORS.assembler;
  else if (t.type === 'output') fill = COLORS.output;
  else if (t.type === 'button') fill = COLORS.button;
  else if (t.type === 'gate') fill = lit.has(t.link) ? COLORS.gateOpen : COLORS.gateClosed;

  ctx.fillStyle = fill;
  roundRect(ctx, px + pad, py + pad, cell - pad * 2, cell - pad * 2, 6);
  ctx.fill();

  ctx.font = `${Math.floor(cell * 0.42)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = px + cell / 2;
  const cy = py + cell / 2;

  if (t.type === 'ore') {
    ctx.fillText('🪨', cx, cy - cell * 0.08);
    ctx.fillStyle = COLORS.oreEdge;
    ctx.font = `${Math.floor(cell * 0.2)}px system-ui`;
    ctx.fillText(t.amount === Infinity ? '∞' : String(t.amount), cx, py + cell * 0.82);
  } else if (t.type === 'forge' || t.type === 'assembler') {
    ctx.fillText(t.type === 'forge' ? '🏭' : '🛠️', cx, cy - cell * 0.06);
    drawMachineState(ctx, world, t, px, py, cell);
  } else if (t.type === 'output') {
    ctx.fillText('🎯', cx, cy);
  } else if (t.type === 'button') {
    ctx.fillStyle = lit.has(t.link) ? COLORS.outputEdge : '#a47ad6';
    ctx.fillText('◉', cx, cy);
    tagLink(ctx, t.link, px, py, cell);
  } else if (t.type === 'gate') {
    ctx.fillStyle = lit.has(t.link) ? COLORS.outputEdge : '#d6587a';
    ctx.fillText(lit.has(t.link) ? '▢' : '▣', cx, cy);
    tagLink(ctx, t.link, px, py, cell);
  }
}

function tagLink(ctx, link, px, py, cell) {
  ctx.fillStyle = '#9fb0d0';
  ctx.font = `${Math.floor(cell * 0.2)}px system-ui`;
  ctx.fillText(String(link + 1), px + cell * 0.2, py + cell * 0.22);
}

function drawMachineState(ctx, world, t, px, py, cell) {
  const recipe = world.recipes[t.type];
  const need = Object.values(recipe.in)[0];
  const have = Object.values(t.buf).reduce((a, b) => a + b, 0);
  // input buffer pips (top-left) and ready outputs (top-right)
  ctx.font = `${Math.floor(cell * 0.18)}px system-ui`;
  ctx.fillStyle = '#cdd6f4';
  ctx.fillText(`${have}/${need}`, px + cell * 0.26, py + cell * 0.2);
  if (t.output > 0) {
    ctx.fillStyle = COLORS.outputEdge;
    ctx.fillText(`▸${t.output}`, px + cell * 0.74, py + cell * 0.2);
  }
  // cook progress bar along the bottom
  if (t.cooking) {
    const frac = 1 - t.progress / recipe.time;
    ctx.fillStyle = '#2a3350';
    ctx.fillRect(px + 6, py + cell - 10, cell - 12, 4);
    ctx.fillStyle = '#f6a23b';
    ctx.fillRect(px + 6, py + cell - 10, (cell - 12) * frac, 4);
  }
}

function drawActor(ctx, x, y, cell, color, inv, label, alpha) {
  const cx = x * cell + cell / 2;
  const cy = y * cell + cell / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(cx, cy, cell * 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();
  if (label) {
    ctx.fillStyle = '#08101f';
    ctx.font = `bold ${Math.floor(cell * 0.26)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx, cy);
  }
  // carried items as a little row of glyphs above the head
  if (inv && inv.length) {
    ctx.globalAlpha = Math.min(1, alpha + 0.25);
    ctx.font = `${Math.floor(cell * 0.22)}px system-ui`;
    inv.forEach((it, i) => {
      ctx.fillText(ITEM_GLYPH[it] ?? '?', cx + (i - (inv.length - 1) / 2) * cell * 0.24, cy - cell * 0.38);
    });
  }
  ctx.restore();
}

/** Draw the entire world onto a 2D context. Returns the cell size used (for hit-testing if needed). */
export function drawWorld(ctx, world, cell) {
  const W = world.width * cell;
  const H = world.height * cell;
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  const lit = openLinks(world);
  for (let y = 0; y < world.height; y++) {
    for (let x = 0; x < world.width; x++) drawTile(ctx, world, x, y, cell, lit);
  }

  // echoes first (ghosts), then the live worker on top
  world.echoes.forEach((e, i) => drawActor(ctx, e.x, e.y, cell, COLORS.echo, e.inv, String(i + 1), 0.5));
  drawActor(ctx, world.worker.x, world.worker.y, cell, COLORS.worker, world.worker.inv, '', 1);

  return cell;
}

export { ITEM_GLYPH };
