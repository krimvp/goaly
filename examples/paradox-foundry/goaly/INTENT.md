# Intent — how to author the verification (instructions to goaly's compiler)

Author the success contract as a **Node built-in test runner** suite (`node --test`) that needs
**zero dependencies** and runs **fully offline**, plus a deterministic verify **command** of the
form `node --test "test/**/*.test.mjs"`.

Test **only the pure simulation core** (`src/engine.js`). Do **not** test the canvas/DOM/renderer —
those are not part of the deterministic contract.

The frozen test files must pin, at minimum, all of these behaviours of the engine:

1. **Level parsing** from an ASCII map: dimensions, the worker start cell, and **fail-closed**
   errors on an unknown glyph, a ragged row, or a missing worker start.
2. **Movement**: open cells are walked; walls and the world edge are solid (a blocked move is not a
   paradox).
3. **Mining**: an `act` on ore yields one ore, respects an inventory **capacity**, and depletes a
   finite ore node.
4. **Crafting timers**: the forge cooks `ore → metal` on its recipe time; the assembler consumes
   **two** metal to make one gear after its cook time.
5. **Echo replay**: a baked loop replays next loop as an **independent actor** (it mines/moves on
   its own while the live worker does something else).
6. **Collision paradox**: two actors contesting one cell resolve by priority (older echo wins) and
   the collision is **counted**.
7. **Starvation paradox**: a wasted `act` on an empty interactable is **counted**.
8. **Gate/button coordination**: a gate is impassable when its button is unheld and passable while
   an actor holds the linked button.
9. **Determinism**: identical inputs produce an identical `hashState`, and a step **never mutates**
   its input world.
10. **Serialization** round-trips the world exactly (including infinite-ore nodes).
11. **End-to-end**: a single planned loop mines, forges, assembles, and ships a **core**, reaching a
    "won" status with zero paradoxes.

The command must **fail until the engine actually implements these behaviours** — never a vacuous
check. Keep the test files self-contained so the integrity guard can pin them by content hash.
