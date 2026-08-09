import { posix } from 'node:path';

/**
 * The ONE channel out of the contract dry run's scratch copy: a bounded, STRUCTURED SUMMARY of a
 * failing rung's output (see `contract-dry-run.ts`).
 *
 * The tree that just failed CONTAINS the throwaway reference implementation, and every real test
 * runner reports a failure by printing the source of the code under test — code-frame gutters,
 * traceback bodies, stack frames. That summary becomes `COMPILE_FAILED.reason` and is fed to the
 * contract author, who then writes the frozen verification files a worker reads: an author handed a
 * working solution can fold it into the bar, which is a wrong-GREEN at t=0.
 *
 * So this is a WHITELIST, and a narrow one. A line survives only if it is either
 *
 * 1. a line whose every file-ish token names one of the frozen `generatedFiles` (the bar's own
 *    frames) — and then only its LOCATION survives: the line is truncated at the end of its last
 *    file token (plus any `:LINE[:COL]` / `::test-id` suffix), because a runner is free to append
 *    arbitrary reference-authored text after the path (pytest's
 *    `FAILED <frozen path>::<test> - <the message the reference raised>`), or
 * 2. the FIRST line matching one of the recognized assertion/error shapes below, carrying no
 *    file-ish token at all AND provably composed by the runner (see below).
 *
 * Everything else is dropped — including lines that name no file, which is exactly the default that
 * leaked pytest traceback bodies and jest's `> 5 | …` marker line past the previous line-by-line
 * blacklist. A kept line is stripped of ANSI escapes, truncated to {@link MAX_LINE_CHARS}, and
 * dropped if it lexically parses as code by the checks below; at most {@link MAX_LINES} survive.
 *
 * The single assertion slot is CONTEXT-SENSITIVE, and the context test is POSITIVE. The earlier
 * NEGATIVE form ("refuse when the previous non-empty line names a non-frozen file") assumed node's
 * layout, where a header sits directly above the offending source line:
 *
 * ```
 * /scratch/src/reference.mjs:7        ← header (dropped: names a non-frozen file)
 *     expected: SECRET(n) * 7 + 1,    ← a RAW SOURCE LINE, naming no file
 *               ^                     ← caret (dropped)
 * ```
 *
 * pytest does the opposite — source first, `src/impl.py:4: NameError` header last — so INSIDE a
 * traceback body the previous non-empty line is itself source or a `^^^^` caret, the negative
 * signal never fires, and `expected = <the whole reference algorithm>` claimed the slot. Being
 * "not obviously inside a header block" is the COMMON case for reference source, not the exception.
 *
 * So a no-file candidate must now be affirmatively RUNNER-COMPOSED: either it carries an explicit
 * runner marker itself ({@link RUNNER_MARKER} — pytest's `E `, mocha's `N)`, jest's `●`,
 * `FAILED`/`--- FAIL:`, a capitalized `Expected:`/`Received:`), or the scan is currently inside a
 * runner-composed block ({@link runnerContext}: opened by a frame naming only frozen files, by a
 * gutter/caret the runner drew, or by a marker line; closed by a frame naming a NON-frozen file or
 * by a line that lexically parses as source). The ambiguous `expected …` shape — equally a fixture
 * literal or an assignment in the reference — is stricter still: block context is NOT enough, it
 * needs an explicit marker or a frozen frame on the immediately preceding line.
 *
 * HONEST LIMITS. This is a lexical + local-context filter, not a proof:
 * - the one kept assertion line is whatever the runner put in the message, so a reference that
 *   throws with a secret *as its message* still surfaces that message (bounded to one truncated
 *   line, dropped if it looks like code or like an expression, and kept only in runner-composed
 *   context). It is NOT proven to be free of reference-implementation text: a line that both looks
 *   like a runner message and stands in runner-composed context is kept, whoever composed it. A
 *   runner marker proves the RUNNER printed the line, never that the runner AUTHORED its content.
 * - the frame branch keeps the text BEFORE the location token (the runner's `at …` / `FAILED` /
 *   `❯` decoration, and any function name the frame names). That prefix is not proven to be
 *   runner-composed either — it is bounded and, on every runner shape pinned here, names only the
 *   frozen file's own symbols.
 * - {@link namesFrozenFile} matches a path SUFFIX when no `root` is given, so a frame naming
 *   `…/<frozen path>` under any prefix counts as frozen. That is why the dry run drops a reference
 *   file by the SAME predicate: whatever this treats as frozen is never written into the scratch
 *   copy in the first place. Both sides canonicalize with {@link normalizeRel} — the same `.`/`//`
 *   collapse the scratch copy's own `resolve(root, relPath)` performs — so a path can never be
 *   judged unfrozen when written and frozen when printed.
 * - an unrecognized runner format produces an empty summary rather than a guess.
 */

/** Max chars kept from any one line — nothing that reaches the author is unbounded. */
const MAX_LINE_CHARS = 200;

/** Max lines the summary may carry, so one rung cannot fill the refusal. */
const MAX_LINES = 12;

/**
 * CSI / OSC escapes a runner emits when it believes it is writing to a TTY. Built from string
 * source rather than a regex literal so the control characters stay readable in this file.
 */
const ANSI = new RegExp(
  '\\u001B(?:\\[[0-?]*[ -\\/]*[@-~]|\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\))',
  'g',
);

/** A test runner's source-frame gutter (`      4|   const x = 1;`, `    > 5 |   throw …`). */
const GUTTER_LINE = /^\s*>?\s*\d+\s*\|/;

/** The caret line that closes a frame block (`        |          ^` or `  ^`). */
const CARET_LINE = /^\s*\|?\s*\^+\s*$/;

/** A path-ish token containing a separator (`src/impl.ts`, `/tmp/x/impl.ts:5:9`, `node:internal/x`). */
const SLASH_REF = /[\w.@~+-]*(?:\/[\w.@~+-]+)+(?::\d+(?::\d+)?)?/g;

/** A bare `file.ext:LINE[:COL]` reference (a runner frame printed without a directory). */
const FILE_LINE_REF = /[\w.@+-]+\.[A-Za-z]\w{0,6}:\d+(?::\d+)?/g;

/**
 * `AssertionError [ERR_ASSERTION]: …`, `ValueError: …`, `E   ValueError: …`, `1) Error: …`.
 * The name must be ONE identifier starting at the line (after pytest's `E ` / mocha's `N)` marker)
 * and must start with an upper-case letter, so a lower-case `foo_error:` key is not an error line.
 */
const ERROR_LINE =
  /^\s*(?:E\s+)?(?:\d+\)\s*)?(?:[A-Z][\w.]*)?(?:Error|Exception|Failure)(?:\s*\[[^\]\n]{0,60}\])?\s*:\s*(?<body>.*)$/;

/**
 * pytest's `E   assert …` marker line. The `E` marker is the runner's OWN gutter, so this shape
 * cannot be a raw source line. The bare `assert …` form is deliberately NOT recognized:
 * unprefixed, that is a traceback SOURCE line.
 */
const PYTEST_ASSERT_LINE = /^\s*E\s+assert(?:ion)?\b[:\s]\s*(?<body>.*)$/i;

/**
 * A runner's own `expected …` summary line. Unmarked, this shape is also exactly what a fixture
 * table (`expected: SECRET(n) * 7,`) or an assignment (`expected = <the whole algorithm>`) in the
 * reference implementation looks like — which is how a raw pytest source line claimed the assertion
 * slot. It is therefore admitted ONLY with an explicit runner marker in front of it, or when the
 * immediately preceding non-empty line was a frame naming only frozen files.
 */
const EXPECTED_LINE = /^\s*expected\b[:\s]\s*(?<body>.*)$/i;

/** The same shape carrying a runner's own gutter/marker (`E   expected …`, `1) expected …`). */
const MARKED_EXPECTED_LINE = /^\s*(?:E\s+|\d+\)\s*|[●✕✗✘×]\s*)expected\b[:\s]\s*(?<body>.*)$/i;

/** jest/vitest's capitalized diff pair — a header the runner composes, never a source line. */
const DIFF_PAIR_LINE = /^\s*(?:Expected|Received)\s*:\s*(?<body>.*)$/;

/**
 * Text only a test runner prints: its own gutters, numbered-failure markers and status words. A
 * line carrying one of these is taken as runner-composed FRAMING — which is a claim about who
 * printed the line, never about who authored the rest of it.
 */
const RUNNER_MARKER =
  /^\s*(?:E\s+\S|\d+\)\s|[●✕✗✘×]|FAILED\s|FAIL\s|--- FAIL:|not ok\s|Expected:|Received:)/;

/** A statement/declaration opener — anchored, so it fires on source lines, not on prose. */
const CODE_OPENER =
  /^\s*(?:export|import|from|require|module|package|func|function|class|def|return|throw|raise|const|let|var|public|private|protected|static|async|await|yield|struct|interface|enum|type|new|lambda|if|elif|else|for|while|switch|case|try|catch|finally|with|fn|impl|use)\b/;

/** Function-literal / block tokens anywhere in the line (`fn.toString()` folded into a message). */
const CODE_TOKEN =
  /=>|\bfunction\s*[\w$]*\s*\(|\bclass\s+[\w$]+|\bdef\s+[\w$]+\s*\(|\blambda\b[^:\n]{0,40}:|[{;]\s*$/;

/** An assignment (`band = _band_for(amount)`, `const x = 1`) — `==`/`=>` are not assignments. */
const ASSIGNMENT = /^\s*(?:const|let|var)?\s*[\w$][\w$.\[\]'"]*\s*(?:\+|-|\*|\/|%|\|\||&&|\?\?)?=(?!=|>)/;

/**
 * A call carrying an identifier/number argument (`SECRET(n - 1)`, `_band_for(amount)`). Runner
 * MESSAGES rarely look like this while reference source almost always does, so an assertion-slot
 * candidate containing one is refused. Deliberately over-broad: it also refuses honest messages
 * like `expected computeTariff(100) to be 12`, which the caller renders as a withheld-output notice.
 */
const CALL_EXPRESSION = /\b[A-Za-z_$][\w$]*\s*\(\s*[A-Za-z_$\d]/;

/** A trailing comma — an object/array literal element, not the end of a sentence. */
const TRAILING_COMMA = /,\s*$/;

/** Drop ANSI escapes before matching, so a color code can never break an anchor. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/**
 * Canonical comparison form of a workspace-relative path: trimmed, with `.` segments, duplicate
 * separators and a trailing `/`/`/.` collapsed, and any leading `./` (or `../`) resolved away.
 *
 * This is deliberately the SAME collapse `FsScratchCopy.writeFile` gets for free from
 * `resolve(root, relPath)`. When this normalized only a leading `./`, `verify/./check.test.mjs`
 * was judged UNFROZEN on the write side (so the reference file was written) and FROZEN on the print
 * side (because it resolved onto the frozen path) — the reference silently rewrote the bar under
 * test and then had its own lines whitelisted into the refusal.
 */
export function normalizeRel(p: string): string {
  return posix.normalize(`/${p.trim()}`).replace(/\/+$/, '').slice(1);
}

/**
 * True when `ref` names one of the frozen verification files.
 *
 * With `root` (the scratch copy's own directory) the match is EXACT after relativizing against it,
 * which is what the output filter uses: a runner prints absolute scratch paths, and anything that
 * does not resolve inside the copy is simply not frozen. Without `root` it falls back to a path
 * SUFFIX match — deliberately BROADER, and that is the mode the dry run uses to drop reference files
 * that collide with the bar. So the frozen set the filter recognizes is a subset of the set the
 * collision drop refuses to write: a file this ever calls frozen is never written as a reference.
 */
export function namesFrozenFile(ref: string, frozen: readonly string[], root?: string): boolean {
  const token = relativize(ref, root);
  return frozen.some((f) => {
    const path = normalizeRel(f);
    if (path.length === 0) return false;
    return token === path || (root === undefined && token.endsWith(`/${path}`));
  });
}

/**
 * A path inside `root`, expressed relative to it; anything else (or no root) is canonicalized only.
 * Absoluteness is preserved through the canonicalization so a relative `tmp/x/…` can never be
 * mistaken for the absolute scratch root `/tmp/x`.
 */
function relativize(ref: string, root: string | undefined): string {
  const token = canonical(ref);
  if (root === undefined) return normalizeRel(ref);
  const base = canonical(root);
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return token.startsWith(prefix) ? token.slice(prefix.length) : normalizeRel(ref);
}

/** {@link normalizeRel}, but keeping a leading `/` when the token was absolute. */
function canonical(p: string): string {
  const t = p.trim();
  const rel = normalizeRel(t);
  return t.startsWith('/') ? `/${rel}` : rel;
}

/**
 * Every file-ish token on one output line, with any `:LINE[:COL]` suffix stripped. Directory-bearing
 * tokens are matched first and BLANKED OUT before the bare `file.ext:LINE` pass, so one frame never
 * yields both `verify/check.test.mjs` and a truncated `check.test.mjs` (which would look unfrozen).
 */
function fileRefs(line: string): string[] {
  return fileTokens(line).map((t) => t.text.replace(/(?::\d+)+$/, ''));
}

/** Every file-ish token with its end offset, directory-bearing tokens first (see {@link fileRefs}). */
function fileTokens(line: string): { text: string; end: number }[] {
  const slashed = [...line.matchAll(SLASH_REF)];
  // Blank the directory-bearing tokens with SPACES so the bare pass keeps the original offsets.
  const masked = line.replace(SLASH_REF, (m) => ' '.repeat(m.length));
  const bare = [...masked.matchAll(FILE_LINE_REF)];
  return [...slashed, ...bare].map((m) => ({ text: m[0], end: m.index + m[0].length }));
}

/** A `::test-id` / `::TestName` suffix, plus a closing bracket the runner wrapped the frame in. */
const FRAME_SUFFIX = /^(?:::[\w$.[\]-]+)*[)\]]?/;

/**
 * A frame line cut down to its LOCATION: everything up to the end of its last file token, plus any
 * `::test-id` suffix and closing bracket. Whatever the runner appended after that is free text it
 * did not have to compose — pytest's short summary puts the exception message the REFERENCE raised
 * there (`FAILED verify/x.py::test_a - ValueError: <reference text>`), and the frame branch is not
 * screened by the assertion-slot guards, so that text is dropped rather than trusted.
 */
function frameLocation(line: string): string {
  const tokens = fileTokens(line);
  const end = tokens.reduce((max, t) => Math.max(max, t.end), 0);
  if (end === 0) return line;
  const tail = FRAME_SUFFIX.exec(line.slice(end))?.[0] ?? '';
  return line.slice(0, end + tail.length);
}

/** True when the text lexically parses as source code rather than as a message about a failure. */
function looksLikeCode(text: string): boolean {
  return CODE_OPENER.test(text) || CODE_TOKEN.test(text) || ASSIGNMENT.test(text);
}

/**
 * The line itself when it is a recognized assertion/error message that is not code; else nothing.
 *
 * `bareExpectedOk` gates the UNMARKED `expected …` shape (see {@link EXPECTED_LINE}): it is true
 * only when the previous non-empty line was a frame naming exclusively frozen files, i.e. the
 * runner is demonstrably reporting on the bar right here. The marked forms need no such gate — the
 * marker is the runner's own gutter and cannot be a raw source line.
 */
function assertionLine(text: string, bareExpectedOk: boolean): string | undefined {
  const match =
    ERROR_LINE.exec(text) ??
    PYTEST_ASSERT_LINE.exec(text) ??
    MARKED_EXPECTED_LINE.exec(text) ??
    DIFF_PAIR_LINE.exec(text) ??
    (bareExpectedOk ? EXPECTED_LINE.exec(text) : null);
  if (match === null) return undefined;
  const body = match.groups?.['body'] ?? '';
  if (looksLikeCode(body)) return undefined;
  if (CALL_EXPRESSION.test(body) || TRAILING_COMMA.test(body)) return undefined;
  return text.trim();
}

/** Where the scan stands relative to the runner's own framing (see the module doc). */
type Scan = {
  /** True while the lines being read are the runner's own block rather than quoted source. */
  runnerContext: boolean;
  /** True when the previous non-empty line was a frame naming ONLY frozen files. */
  afterFrozenFrame: boolean;
};

function bound(text: string): string {
  return text.length <= MAX_LINE_CHARS ? text : `${text.slice(0, MAX_LINE_CHARS)}…`;
}

/**
 * Summarize a failing rung's output down to what the contract author may safely see: frames naming
 * ONLY the frozen verification files, plus at most one bounded assertion line. See the module doc —
 * an unrecognized shape yields `''`, which the caller renders as a withheld-output notice.
 *
 * `root` is the scratch copy's directory: given it, a frame counts as frozen only when it resolves
 * INSIDE the copy onto a frozen path exactly (see {@link namesFrozenFile}).
 */
export function sanitizeRungOutput(raw: string, frozen: readonly string[], root?: string): string {
  const lines = stripAnsi(raw)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''));
  const kept: string[] = [];
  let message: string | undefined;
  // The output opens with the runner's own banner, never mid-source, so the scan starts inside
  // runner-composed context; the first line of quoted source or the first foreign frame closes it.
  const scan: Scan = { runnerContext: true, afterFrozenFrame: false };
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    if (text.trim().length === 0) continue;
    const here: Scan = { ...scan };
    if (GUTTER_LINE.test(text) || CARET_LINE.test(text)) {
      // The runner drew this gutter/caret: whatever follows the block is its own output again.
      scan.runnerContext = true;
      scan.afterFrozenFrame = false;
      continue;
    }
    const refs = fileRefs(text);
    if (refs.length > 0) {
      const frozenOnly = refs.every((r) => namesFrozenFile(r, frozen, root));
      // A frame naming a NON-frozen file is a location header for source goaly must not show, so it
      // closes runner context; a frozen-only frame opens it.
      scan.runnerContext = frozenOnly;
      scan.afterFrozenFrame = frozenOnly;
      // Frames are capped, but the scan continues: a runner that prints many frozen frames before
      // its summary must not crowd out the one assertion line the author actually needs.
      if (kept.length >= MAX_LINES) continue;
      // Only the LOCATION survives — the runner may have appended reference-authored free text.
      if (frozenOnly && !looksLikeCode(text)) kept.push(bound(frameLocation(text).trim()));
      continue;
    }
    // Names no file at all: the pytest traceback body, jest's `> 5 | …` marker, a bare runner
    // banner. Refused unless PROVABLY runner-composed (see the module doc).
    const marked = RUNNER_MARKER.test(text);
    scan.runnerContext = marked || (here.runnerContext && !looksLikeCode(text));
    scan.afterFrozenFrame = false;
    if (message !== undefined) continue;
    if (!marked && !here.runnerContext) continue;
    // The caret below closes a block whose source this line belongs to, whoever printed the header.
    if (lines[i + 1] !== undefined && CARET_LINE.test(lines[i + 1] ?? '')) continue;
    message = assertionLine(text, marked || here.afterFrozenFrame);
    if (message !== undefined) kept.push(bound(message));
  }
  return kept.join('\n').trim();
}
