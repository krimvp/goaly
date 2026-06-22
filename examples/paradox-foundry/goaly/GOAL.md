# Goal — Paradox Foundry

Build **Paradox Foundry**, an innovative, browser-playable **time-loop automation puzzle game**
that runs by simply opening `index.html` in a modern browser — no build step, no bundler, no
network, and no third-party dependencies (vanilla JavaScript ES modules + HTML5 Canvas only).

## The core idea (the innovative mechanic)

The player controls a single **worker** on a tile grid for a **fixed-length time loop**. Each tick
the worker performs one action. When the loop ends, the worker's **recorded** sequence of actions
is permanently baked into an **echo** — a ghost that, on every future loop, **replays those exact
actions in lock-step** alongside the live worker. The player bootstraps an entire automated factory
out of cooperating copies of their own past selves.

Because many echoes share one world, they can **conflict**, and every conflict is a **paradox**:

- a **collision paradox** when two actors try to enter the same cell on the same tick, and
- a **starvation paradox** when an echo's recorded action expects a resource (ore, a machine
  output, a gear to ship) that another actor already consumed.

Conflicts must resolve **deterministically** (older echoes have priority) so the whole simulation
is reproducible from its inputs.

## Production chain

A supply chain the cooperating echoes must operate:

`ore → (forge) → metal`, then `2 × metal → (assembler) → gear`, then `gear → (output pad) → core`.

Machines take **input items, cook for a recipe-specific number of ticks, then yield output** that an
actor collects. A level is won when the required number of **cores** has been shipped.

## Coordination mechanic

Include **buttons** and **gates**: a gate is passable only while some actor stands on its linked
button — forcing the player to dedicate an echo to holding a button so a later self can pass.

## Architecture (mandatory)

- A **pure, deterministic simulation core** in `src/engine.js` with **no DOM, no randomness, no
  clock, no I/O**. Every state transition takes a world and returns a brand-new world (inputs are
  never mutated). Given identical inputs it must produce identical output, including a stable
  `hashState` fingerprint. This is the part the frozen verifier locks.
- A separate **canvas renderer** and a small **controller** wiring keyboard/buttons to the engine.
- An **`index.html`** that loads the ES modules and is playable by opening the file directly.
- Several **levels of increasing complexity**, from a solo single-loop tutorial up to a multi-echo,
  multi-core factory.

## Definition of done

The game is genuinely playable in a browser, the simulation core is pure and deterministic, the
time-loop echo mechanic works (recorded actions replay as independent actors), both paradox classes
are detected, the gate/button mechanic works, and the authored test suite passes.
