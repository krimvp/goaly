import { describe, it, expect } from 'vitest';
import { namesFrozenFile, normalizeRel, sanitizeRungOutput } from './rung-output';

/**
 * The dry run's ONE channel out of the scratch copy is the refusal reason, and the tree that just
 * failed CONTAINS the throwaway reference implementation. Every real runner reports a failure by
 * printing the source of the code under test — which on a red is precisely the reference — so the
 * summary fed back to the contract author must carry the failure and NOTHING of the reference.
 *
 * These fixtures are the output SHAPES of the runners a compiler actually authors against. Each one
 * asserts the same thing: no reference source, no reference path, no reference identifier survives.
 */

/** The frozen bar in every fixture below. */
const FROZEN = ['verify/check.test.mjs'];

/** Tokens that only ever appear in the throwaway reference implementation. */
const SECRETS = ['BAND_TABLE_SECRET', 'REFERENCE-ONLY-SECRET', '_band_for', 'src/widget'];

function expectNoLeak(summary: string, extra: readonly string[] = []): void {
  for (const secret of [...SECRETS, ...extra]) expect(summary).not.toContain(secret);
}

describe('sanitizeRungOutput — real runner shapes never leak the reference implementation', () => {
  it('vitest: drops the code frame and the stack frame of the implementation under test', () => {
    const out = [
      ' FAIL  verify/check.test.mjs > tariff > applies the band',
      'AssertionError: expected 15 to be 12 // Object.is equality',
      '',
      '- Expected',
      '+ Received',
      '',
      '- 12',
      '+ 15',
      '',
      ' ❯ verify/check.test.mjs:9:30',
      '      7|',
      "      8| test('applies the band', () => {",
      '      9|   expect(computeTariff(100)).toBe(12)',
      '       |                              ^',
      '     10| })',
      '',
      ' ❯ computeTariff src/widget.mjs:4:10',
      '      3| export function computeTariff(amount) {',
      '      4|   const band = BAND_TABLE_SECRET[amount]',
      '       |          ^',
      '',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expectNoLeak(summary, ['computeTariff(amount)', 'const band']);
    expect(summary).toContain('expected 15 to be 12');
    expect(summary).toContain('verify/check.test.mjs');
  });

  it('vitest with ANSI colors: the escapes never smuggle a frame past the whitelist', () => {
    const esc = '\u001B';
    const out = [
      `${esc}[31m \u276f computeTariff ${esc}[2msrc/widget.mjs:4:10${esc}[0m`,
      `${esc}[2m      4|${esc}[0m   const band = BAND_TABLE_SECRET[amount]`,
      `${esc}[31mAssertionError${esc}[0m: expected 15 to be 12`,
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expectNoLeak(summary, ['const band']);
    expect(summary).toContain('expected 15 to be 12');
    // The escapes are stripped before matching, so they cannot survive into the summary either.
    expect(summary).not.toContain(esc);
  });

  it('jest: the caret-marked gutter line (`  > 5 | …`) is dropped, not kept', () => {
    // PROVEN LEAK: jest marks the offending source line with a `>` prefix, which defeats a
    // gutter anchor that expects whitespace-then-digit — and the line names no file at all.
    const out = [
      ' FAIL  verify/check.test.mjs',
      '  ● tariff › applies the band',
      '',
      '    BAND_TABLE_SECRET is not defined',
      '',
      '      3 | export function computeTariff(amount) {',
      '      4 |   // look up the band',
      "    > 5 |   throw new Error('BAND_TABLE_SECRET')",
      '        |         ^',
      '      6 | }',
      '',
      '      at computeTariff (src/widget.mjs:5:9)',
      '      at Object.<anonymous> (verify/check.test.mjs:4:5)',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expectNoLeak(summary, ['computeTariff(amount)', 'look up the band']);
  });

  it('pytest: bare source lines of the traceback are dropped even though they name no file', () => {
    // PROVEN LEAK: pytest prints the source of the failing function with no filename on the line,
    // so a filter that keeps "lines naming no file" hands the author the implementation verbatim.
    const out = [
      '============================= test session starts ==============================',
      'platform linux -- Python 3.11.2, pytest-9.0.2, pluggy-1.5.0',
      'rootdir: /tmp/goaly-dry-run-abc',
      'collected 1 item',
      '',
      'verify/check.test.mjs F                                                  [100%]',
      '',
      '=================================== FAILURES ===================================',
      '_______________________________ test_tariff ____________________________________',
      '',
      '    def test_tariff():',
      '>       assert compute_tariff(100) == 12',
      '',
      'src/widget.py:7: in compute_tariff',
      '    band = _band_for(amount)',
      'src/widget.py:2: in _band_for',
      "    raise ValueError('band %d out of range' % band)",
      'E   ValueError: band 7 out of range',
      '',
      'verify/check.test.mjs:5: ValueError',
      '=========================== short test summary info ============================',
      '1 failed in 0.05s',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expectNoLeak(summary, ['def test_tariff', 'band = ', 'raise ValueError', 'src/widget.py']);
    // The one assertion line the whitelist may keep is the runner's own message, nothing more.
    expect(summary).toContain('band 7 out of range');
  });

  it('node: the location header takes its source block with it, and the message survives', () => {
    const out = [
      '/tmp/goaly-dry-run-abc/src/widget.mjs:2',
      "export function computeTariff(a) { throw new Error('boom ' + BAND_TABLE_SECRET); }",
      '                                   ^',
      '',
      'Error: boom 3',
      '    at computeTariff (file:///tmp/goaly-dry-run-abc/src/widget.mjs:2:36)',
      '    at file:///tmp/goaly-dry-run-abc/verify/check.test.mjs:3:14',
      '',
      'Node.js v22.11.0',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expectNoLeak(summary, ['computeTariff(a)']);
    expect(summary).toContain('Error: boom 3');
  });

  it('go test: the failing file/line of the reference never survives', () => {
    const out = [
      '--- FAIL: TestTariff (0.00s)',
      '    check_test.go:12: got 15, want 12',
      'panic: BAND_TABLE_SECRET [recovered]',
      '',
      'goroutine 1 [running]:',
      'example/tariff.computeTariff(0x64)',
      '\t/tmp/goaly-dry-run-abc/src/widget.go:9 +0x1d',
      'FAIL\texample/tariff\t0.004s',
      'exit status 1',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expectNoLeak(summary, ['widget.go', 'computeTariff(0x64)']);
  });

  it('mocha: the stack frames of the implementation are dropped, the message is kept', () => {
    const out = [
      '  tariff',
      '    1) applies the band',
      '',
      '  0 passing (5ms)',
      '  1 failing',
      '',
      '  1) tariff',
      '       applies the band:',
      '     Error: expected 15 to equal 12',
      '      at computeTariff (src/widget.mjs:5:9)',
      '      at Context.<anonymous> (verify/check.test.mjs:4:5)',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expectNoLeak(summary);
    expect(summary).toContain('expected 15 to equal 12');
  });

  it('bounds a preserved assertion message to a single line', () => {
    // PROVEN LEAK: an Error built from `fn.toString()` renders as a MULTI-LINE message whose
    // continuation lines name no file — so "keep lines naming no file" delivers the function body.
    const out = [
      'Error: reference failed: export function computeTariff(amount) {',
      '  const band = BAND_TABLE_SECRET[amount];',
      '  return band * 2;',
      '}',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expectNoLeak(summary, ['const band', 'return band']);
  });

  it('bounds a preserved assertion message to a fixed number of characters', () => {
    const out = `AssertionError: expected ${'x'.repeat(5000)} to be 12`;

    const summary = sanitizeRungOutput(out, FROZEN);

    expect(summary.length).toBeLessThanOrEqual(400);
  });

  it('drops a single-line message that lexically parses as code', () => {
    const arrow = "Error: (amount) => BAND_TABLE_SECRET[amount] * 2";
    const decl = 'AssertionError: function computeTariff(a) { return REFERENCE-ONLY-SECRET; }';

    expectNoLeak(sanitizeRungOutput(arrow, FROZEN));
    expectNoLeak(sanitizeRungOutput(decl, FROZEN));
  });

  it('over-drops an unrecognized runner format instead of passing it through', () => {
    const out = [
      '~~~ acme-runner 4.2 ~~~',
      'the check did not hold, here is what ran:',
      '  computeTariff(100) -> BAND_TABLE_SECRET',
      '  the check wanted 12',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expectNoLeak(summary, ['computeTariff(100)']);
    // Nothing in that output is a frozen-file frame or a recognized assertion line, so the whole
    // thing is withheld rather than guessed at.
    expect(summary).toBe('');
  });

  it('caps the frames it keeps, yet still delivers an assertion line printed after them', () => {
    const frames = Array.from({ length: 40 }, (_, i) => ` ❯ verify/check.test.mjs:${i + 1}:3`);
    const out = [...frames, 'AssertionError: expected 1 to be 2'].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN);

    expect(summary.split('\n').length).toBeLessThanOrEqual(13);
    expect(summary).toContain('AssertionError: expected 1 to be 2');
  });

  it('keeps only frames that PROVABLY name a frozen file', () => {
    const summary = sanitizeRungOutput(
      [
        ' ❯ verify/check.test.mjs:9:30',
        ' ❯ /tmp/goaly-dry-run-abc/verify/check.test.mjs:9:30',
        ' ❯ src/verify/check.test.mjs.bak:1:1',
        ' ❯ node_modules/vitest/dist/index.js:1:1',
      ].join('\n'),
      FROZEN,
    );

    expect(summary).toContain('verify/check.test.mjs:9:30');
    expect(summary).not.toContain('.bak');
    expect(summary).not.toContain('node_modules');
  });
});

describe('namesFrozenFile — the write side and the print side canonicalize identically', () => {
  // PROVEN LEAK: the collision drop compared path STRINGS while `FsScratchCopy.writeFile` compares
  // RESOLVED paths. A reference file spelled `verify/./check.test.mjs` was therefore judged
  // UNFROZEN when written (so it overwrote the frozen bar in the scratch copy) and FROZEN when
  // printed (so every line it emitted was whitelisted into the refusal fed to the contract author).
  const FROZEN_BAR = ['verify/check.test.mjs'];

  it.each([
    'verify/./check.test.mjs',
    'verify//check.test.mjs',
    './verify/./check.test.mjs',
    'verify/check.test.mjs/.',
    'verify/sub/../check.test.mjs',
    '  verify/./check.test.mjs  ',
  ])('treats %j as the frozen file it resolves onto', (spelling) => {
    expect(namesFrozenFile(spelling, FROZEN_BAR)).toBe(true);
  });

  it('normalizes both sides, so a frozen entry spelled oddly still matches', () => {
    expect(namesFrozenFile('verify/check.test.mjs', ['verify/./check.test.mjs'])).toBe(true);
    expect(normalizeRel('verify/./check.test.mjs')).toBe('verify/check.test.mjs');
    expect(normalizeRel('./a//b/')).toBe('a/b');
  });

  it('still refuses a merely similar path', () => {
    expect(namesFrozenFile('verify/check.test.mjs.bak', FROZEN_BAR)).toBe(false);
    expect(namesFrozenFile('src/other.mjs', FROZEN_BAR)).toBe(false);
  });

  it('with a scratch root, a dotted spelling under the root resolves onto the frozen path', () => {
    const root = '/tmp/goaly-dry-run-abc';
    expect(namesFrozenFile(`${root}/verify/./check.test.mjs`, FROZEN_BAR, root)).toBe(true);
    // …and a path OUTSIDE the copy is never frozen, however it is spelled.
    expect(namesFrozenFile('/elsewhere/verify/check.test.mjs', FROZEN_BAR, root)).toBe(false);
    // A relative token that merely LOOKS like the root prefix is not treated as absolute.
    expect(namesFrozenFile('tmp/goaly-dry-run-abc/verify/check.test.mjs', FROZEN_BAR, root)).toBe(
      false,
    );
  });
});

describe('sanitizeRungOutput — the assertion slot is not claimable by a raw source line', () => {
  const FROZEN_BAR = ['verify/check.test.mjs'];

  it("drops a source line inside node's uncaught-exception header block", () => {
    // PROVEN LEAK: node prints `path:LINE`, then the RAW offending source line with no gutter, then
    // a caret. The header is dropped (it names a non-frozen file) and the caret is dropped, but the
    // bare source line matched the `expected …` shape and reached the contract author verbatim.
    const out = [
      '/tmp/goaly-dry-run-abc/src/reference.mjs:7',
      '    expected: SECRET_FORMULA_H(n) * 7 + 1,',
      '              ^',
      '',
      'AssertionError [ERR_ASSERTION]: 15 !== 12',
      '    at Object.<anonymous> (/tmp/goaly-dry-run-abc/verify/check.test.mjs:3:1)',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN_BAR, '/tmp/goaly-dry-run-abc');

    expect(summary).not.toContain('SECRET_FORMULA_H');
    expect(summary).not.toContain('expected:');
    expect(summary).toContain('15 !== 12');
  });

  it.each([
    '    expected: n <= 1 ? 1 : n * SECRET(n - 1),',
    '    expected := SECRET * 7',
    '    ValueError: SECRET * 7 + 1,',
    '    ParseError: SECRET_LOOKUP(table),',
    '    RetryFailure: SECRET_BACKOFF(n) * 7',
  ])('drops the source line %j when it sits under a non-frozen location header', (source) => {
    const out = ['/tmp/goaly-dry-run-abc/src/reference.mjs:7', source, '              ^'].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN_BAR, '/tmp/goaly-dry-run-abc');

    expect(summary).not.toContain('SECRET');
  });

  it('drops a bare `expected …` line when no frame ever named a frozen file', () => {
    // Unmarked, `expected: …` is also what a fixture table in the reference looks like, so it is
    // only trusted once the runner has demonstrably been reporting on the frozen bar.
    const orphan = sanitizeRungOutput('expected SECRET_TABLE[3] to be 12', FROZEN_BAR);
    expect(orphan).toBe('');

    const inContext = sanitizeRungOutput(
      [' ❯ verify/check.test.mjs:9:30', 'expected 15 to be 12'].join('\n'),
      FROZEN_BAR,
    );
    expect(inContext).toContain('expected 15 to be 12');
  });

  it('drops a candidate whose body is an expression rather than a message', () => {
    expect(sanitizeRungOutput('Error: SECRET_HELPER(n - 1) * 7', FROZEN_BAR)).toBe('');
    expect(sanitizeRungOutput('Error: SECRET lookup table,', FROZEN_BAR)).toBe('');
  });

  it('keeps the runner message that follows the caret of a dropped block', () => {
    const out = [
      '/tmp/goaly-dry-run-abc/src/reference.mjs:2',
      '  const KEY = "LEAKED";',
      '        ^',
      '',
      'Error: boom 3',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN_BAR, '/tmp/goaly-dry-run-abc');

    expect(summary).not.toContain('LEAKED');
    expect(summary).toContain('Error: boom 3');
  });
});

/**
 * ROUND-5 REGRESSION. The location-block signal was a NEGATIVE one: "the previous non-empty line
 * carries a non-frozen file token". That assumes node's layout (header directly ABOVE the offending
 * source line). pytest prints the frame source FIRST and the `path:LINE: Error` header LAST, and
 * inside a multi-line statement the previous non-empty line is itself source or a `^^^^` caret — so
 * the signal never fires anywhere in pytest output, and the bare `expected …` shape claimed the
 * assertion slot with a RAW REFERENCE SOURCE LINE (verified end-to-end with real pytest 9.0.2).
 *
 * The rule is now POSITIVE: a no-file line must be provably runner-composed to be eligible at all,
 * and the `expected …` shape needs an explicit runner marker (or a frozen frame immediately above).
 */
describe('sanitizeRungOutput — a no-file line must be PROVABLY runner-composed', () => {
  const FROZEN_BAR = ['verify/check_impl.py'];
  const FORMULA = 'amount * ZZ9_TABLE[0] + 42 if amount > 50 else amount * 2';

  /**
   * pytest always prints the FROZEN test's own frame first, so `sawFrozenFrame` is set for the rest
   * of the output; from then on the only thing standing between the reference's source and the slot
   * was "the previous non-empty line carries a non-frozen file token" — which is false for every
   * line INSIDE a traceback body.
   */
  const PYTEST_HEAD = [
    '=================================== FAILURES ===================================',
    '________________________________ test_tariff ___________________________________',
    'verify/check_impl.py:9: in test_tariff',
    '    result = compute(100)',
    'src/impl.py:4: in compute',
  ];

  it('pytest: a reference source line whose previous line is itself source is refused', () => {
    const out = [
      ...PYTEST_HEAD,
      '    band = _band_for(amount)',
      `    expected = ${FORMULA}`,
      'E   NameError: the band lookup is not defined',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN_BAR);

    expect(summary).not.toContain(FORMULA);
    expect(summary).not.toContain('ZZ9_TABLE');
    // The runner's OWN marked line still reaches the author.
    expect(summary).toContain('NameError');
  });

  it('pytest: a reference source line whose previous line is a caret is refused too', () => {
    // The two-line-frame shape the previous fix missed entirely: no file token above the candidate,
    // just the caret pytest draws under the offending expression.
    const out = [
      ...PYTEST_HEAD,
      '        return (',
      '^^^^^^^^^^^^^^^^',
      `    expected = ${FORMULA}`,
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN_BAR);

    expect(summary).not.toContain(FORMULA);
    expect(summary).not.toContain('ZZ9_TABLE');
  });

  it('a bare `expected …` line is refused even inside a runner-composed frame block', () => {
    const out = [
      ' ❯ verify/check_impl.py:9:30',
      '      7 |   x = 1',
      `    expected = ${FORMULA}`,
    ].join('\n');

    expect(sanitizeRungOutput(out, FROZEN_BAR)).not.toContain('ZZ9_TABLE');
  });

  it('an ANSI-wrapped plain runner cannot smuggle the same line through', () => {
    const esc = '';
    const out = [
      ' ❯ verify/check_impl.py:9:30',
      `${esc}[31m    def compute(amount):${esc}[0m`,
      `${esc}[1m    expected = ${FORMULA}${esc}[0m`,
    ].join('\n');

    expect(sanitizeRungOutput(out, FROZEN_BAR)).not.toContain('ZZ9_TABLE');
  });

  it('keeps a MARKED expected line, which is the runner speaking', () => {
    const marked = sanitizeRungOutput('E   expected 15 to be 12', FROZEN_BAR);
    expect(marked).toContain('expected 15 to be 12');
  });
});

/**
 * ROUND-5 REGRESSION. The frame branch was a second, WIDER channel than the module doc admitted:
 * it kept the WHOLE line as long as every file token on it was frozen. pytest's short-summary line
 * is `FAILED <frozen path>::<test> - <the message the reference raised>` — a frozen path plus
 * arbitrary reference-authored free text — and up to MAX_LINES of them survived, bypassing every
 * assertion-slot guard. A frame is now truncated at the end of its location token.
 */
describe('sanitizeRungOutput — a frame keeps its location, not the free text after it', () => {
  const FROZEN_BAR = ['verify/check_impl.py'];

  it("pytest short summary: the reference's exception message is cut off the FAILED line", () => {
    const out = [
      '=========================== short test summary info ============================',
      'FAILED verify/check_impl.py::test_a - ValueError: ZZ9_TABLE band 7 out of range',
      'FAILED verify/check_impl.py::test_b - KeyError: SECRET_BAND_TABLE lookup failed',
    ].join('\n');

    const summary = sanitizeRungOutput(out, FROZEN_BAR);

    expect(summary).not.toContain('ZZ9_TABLE');
    expect(summary).not.toContain('SECRET_BAND_TABLE');
    // The identity of the failing test — which the author wrote — still survives.
    expect(summary).toContain('verify/check_impl.py::test_a');
    expect(summary).toContain('::test_b');
  });

  it('a vitest header keeps the file, not the trailing test title chain', () => {
    const summary = sanitizeRungOutput(
      ' FAIL  verify/check_impl.py > tariff > REFERENCE_ONLY_TITLE',
      FROZEN_BAR,
    );

    expect(summary).not.toContain('REFERENCE_ONLY_TITLE');
    expect(summary).toContain('verify/check_impl.py');
  });

  it('keeps the `:LINE:COL` suffix and the closing paren of a stack frame', () => {
    const summary = sanitizeRungOutput(
      '    at Object.<anonymous> (verify/check_impl.py:4:5) SECRET_TRAILER',
      FROZEN_BAR,
    );

    expect(summary).not.toContain('SECRET_TRAILER');
    expect(summary).toContain('verify/check_impl.py:4:5)');
  });
});
