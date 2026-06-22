// PARADOX FOUNDRY — browser controller. Glue between keyboard/buttons, the pure engine, and the
// canvas renderer. Turn-based: one keypress = one tick (every echo advances in lock-step). Holds an
// in-loop undo stack and a loop-start snapshot, and bakes the recording into an echo on demand.

import { LEVELS } from './levels.js';
import { parseLevel, step, endLoop } from './engine.js';
import { drawWorld } from './render.js';

const KEY_ACTION = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right',
  Space: 'act', KeyE: 'act',
  Period: 'wait', KeyX: 'wait',
};

const $ = (id) => document.getElementById(id);

export function startGame() {
  const canvas = $('board');
  const ctx = canvas.getContext('2d');

  const state = {
    levelIndex: 0,
    level: null,
    world: null,
    loopStart: null, // snapshot to restart the current loop
    history: [], // in-loop undo stack
    auto: null, // auto-wait timer handle
  };

  function freshWorld(level) {
    return parseLevel(level.map, {
      loopLength: level.loopLength,
      targetScore: level.targetScore,
      capacity: level.capacity,
    });
  }

  function cellSize() {
    const w = state.world;
    const maxW = Math.min(720, canvas.parentElement.clientWidth);
    const maxH = 520;
    return Math.floor(Math.min(maxW / w.width, maxH / w.height));
  }

  function render() {
    const cell = cellSize();
    canvas.width = state.world.width * cell;
    canvas.height = state.world.height * cell;
    drawWorld(ctx, state.world, cell);
    renderHud();
  }

  function renderHud() {
    const w = state.world;
    $('hud-level').textContent = state.level.name;
    $('hud-blurb').textContent = state.level.blurb;
    $('hud-score').textContent = `${w.score} / ${w.targetScore}`;
    $('hud-loop').textContent = String(w.loopCount);
    $('hud-echoes').textContent = String(w.echoes.length);
    $('hud-tick').textContent = `${w.tick} / ${w.loopLength}`;
    $('hud-collision').textContent = String(w.paradoxes.collision);
    $('hud-starvation').textContent = String(w.paradoxes.starvation);

    const bar = $('tickbar');
    bar.style.width = `${Math.min(100, (w.tick / w.loopLength) * 100)}%`;

    const flash = $('flash');
    const ev = w.events.find((e) => e.kind === 'collision' || e.kind === 'starvation');
    if (ev) {
      flash.textContent = ev.kind === 'collision' ? '⚡ PARADOX: actors collided' : '🩸 PARADOX: an echo starved';
      flash.classList.add('show');
      clearTimeout(flash._t);
      flash._t = setTimeout(() => flash.classList.remove('show'), 900);
    }

    $('btn-endloop').disabled = w.status === 'won';
    $('loopfull').classList.toggle('show', w.tick >= w.loopLength && w.status !== 'won');

    if (w.status === 'won') showWin();
  }

  function showWin() {
    stopAuto();
    const w = state.world;
    $('win-stats').innerHTML =
      `Cores shipped: <b>${w.score}</b><br>` +
      `Loops used: <b>${w.loopCount + 1}</b> · Echoes: <b>${w.echoes.length}</b><br>` +
      `Paradoxes — collisions <b>${w.paradoxes.collision}</b>, starvation <b>${w.paradoxes.starvation}</b>`;
    const last = state.levelIndex >= LEVELS.length - 1;
    $('btn-next').textContent = last ? 'Campaign complete 🎉' : 'Next level →';
    $('btn-next').disabled = last;
    $('overlay').classList.add('show');
  }

  function act(action) {
    const w = state.world;
    if (w.status === 'won' || w.tick >= w.loopLength) return;
    state.history.push(w);
    state.world = step(w, action);
    render();
  }

  function bakeEcho() {
    stopAuto();
    if (state.world.status === 'won') return;
    state.world = endLoop(state.world);
    state.loopStart = state.world;
    state.history = [];
    render();
  }

  function undo() {
    stopAuto();
    const prev = state.history.pop();
    if (prev) {
      state.world = prev;
      render();
    }
  }

  function restartLoop() {
    stopAuto();
    state.world = state.loopStart;
    state.history = [];
    render();
  }

  function resetLevel() {
    stopAuto();
    loadLevel(state.levelIndex);
  }

  function toggleAuto() {
    if (state.auto) return stopAuto();
    $('btn-auto').textContent = '⏸ Pause';
    state.auto = setInterval(() => {
      const w = state.world;
      if (w.status === 'won' || w.tick >= w.loopLength) return stopAuto();
      state.history.push(w);
      state.world = step(w, 'wait');
      render();
    }, 260);
  }

  function stopAuto() {
    if (state.auto) {
      clearInterval(state.auto);
      state.auto = null;
    }
    $('btn-auto').textContent = '▶ Auto-wait';
  }

  function loadLevel(i) {
    stopAuto();
    state.levelIndex = i;
    state.level = LEVELS[i];
    state.world = freshWorld(state.level);
    state.loopStart = state.world;
    state.history = [];
    $('overlay').classList.remove('show');
    $('level-select').value = String(i);
    render();
  }

  // ---- wiring ----
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Enter') return bakeEcho(), e.preventDefault();
    if (e.code === 'KeyZ' || e.code === 'Backspace') return undo(), e.preventDefault();
    if (e.code === 'KeyR') return (e.shiftKey ? resetLevel() : restartLoop()), e.preventDefault();
    if (e.code === 'KeyP') return toggleAuto(), e.preventDefault();
    const a = KEY_ACTION[e.code];
    if (a) {
      act(a);
      e.preventDefault();
    }
  });

  $('btn-endloop').onclick = bakeEcho;
  $('btn-undo').onclick = undo;
  $('btn-restart').onclick = restartLoop;
  $('btn-reset').onclick = resetLevel;
  $('btn-auto').onclick = toggleAuto;
  $('btn-next').onclick = () => loadLevel(Math.min(LEVELS.length - 1, state.levelIndex + 1));
  $('btn-act').onclick = () => act('act');
  for (const dir of ['up', 'down', 'left', 'right', 'wait']) {
    const el = $(`btn-${dir}`);
    if (el) el.onclick = () => act(dir);
  }

  const sel = $('level-select');
  LEVELS.forEach((l, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = l.name;
    sel.appendChild(opt);
  });
  sel.onchange = () => loadLevel(Number(sel.value));

  window.addEventListener('resize', () => state.world && render());

  loadLevel(0);
}
