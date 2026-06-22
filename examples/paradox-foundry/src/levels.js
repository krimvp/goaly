// PARADOX FOUNDRY — campaign levels.
//
// Each level is an ASCII map (see GLYPHS / parseLevel in engine.js) plus the loop budget and the
// number of cores required to win. The difficulty curve walks the player from "one worker, one
// loop" up to genuinely multi-echo factories that demand collision- and starvation-free
// choreography across half a dozen replaying past selves.
//
// Glyph legend: '@' worker start · '.' empty · '#' wall · 'O' infinite ore · 'o' finite ore (12)
//               'F' forge (ore→metal) · 'A' assembler (2 metal→gear) · 'X' output (gear→core)
//               '1'-'9' buttons · 'a'-'i' gates (button N opens gate letter N).

export const LEVELS = [
  {
    id: 'first-light',
    name: '1 · First Light',
    blurb: 'One worker, one loop. Mine, forge, assemble, ship a single Core. Learn the chain.',
    loopLength: 40,
    targetScore: 1,
    capacity: 3,
    map: ['@.O.F.A.X'].join('\n'),
  },
  {
    id: 'echo-shift',
    name: '2 · Echo Shift',
    blurb: 'The loop is too short to do it all alone. Bake an echo to mine while the next you forges.',
    loopLength: 18,
    targetScore: 1,
    capacity: 3,
    map: [
      '#######',
      '@.O.F.X',
      '#####A#',
      '#######',
    ].join('\n'),
  },
  {
    id: 'crossfire',
    name: '3 · Crossfire',
    blurb: 'Two ore veins, two echoes feeding one forge. Stagger their paths or they collide.',
    loopLength: 22,
    targetScore: 1,
    capacity: 3,
    map: [
      'O..@..O',
      '.#...#.',
      '..FAX..',
      '#######',
    ].join('\n'),
  },
  {
    id: 'the-gate',
    name: '4 · The Gate',
    blurb: 'A gate seals the assembler. One echo must stand on the button while another keeps building.',
    loopLength: 26,
    targetScore: 1,
    capacity: 3,
    map: [
      '@.O.F.1',
      '#####.#',
      'X.A.a..',
      '#######',
    ].join('\n'),
  },
  {
    id: 'mass-production',
    name: '5 · Mass Production',
    blurb: 'Three Cores. A full pipeline of echoes, perfectly timed, with no paradox to spare.',
    loopLength: 34,
    targetScore: 3,
    capacity: 3,
    map: [
      '@..O..O..',
      '.#.....#.',
      '.F.....F.',
      '..A...A..',
      '....X....',
      '#########',
    ].join('\n'),
  },
];

/** Look up a level definition by id (or undefined). */
export function levelById(id) {
  return LEVELS.find((l) => l.id === id);
}
