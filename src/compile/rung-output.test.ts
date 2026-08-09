import { describe, it, expect } from 'vitest';
import { sanitizeRungOutput } from './rung-output';

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
