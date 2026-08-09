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
 *    frames), or
 * 2. the FIRST line matching one of the recognized assertion/error shapes below, carrying no
 *    file-ish token at all AND not sitting inside a runner's location-header block.
 *
 * Everything else is dropped — including lines that name no file, which is exactly the default that
 * leaked pytest traceback bodies and jest's `> 5 | …` marker line past the previous line-by-line
 * blacklist. A kept line is stripped of ANSI escapes, truncated to {@link MAX_LINE_CHARS}, and
 * dropped if it lexically parses as code by the checks below; at most {@link MAX_LINES} survive.
 *
 * The single assertion slot is CONTEXT-SENSITIVE, not purely lexical. Node's uncaught-exception
 * block prints
 *
 * ```
 * /scratch/src/reference.mjs:7        ← header (dropped: names a non-frozen file)
 *     expected: SECRET(n) * 7 + 1,    ← a RAW SOURCE LINE, naming no file
 *               ^                     ← caret (dropped)
 * ```
 *
 * and that middle line is reference source, not a message the runner composed. So a no-file
 * candidate is refused when its previous non-empty line is a location header naming a NON-frozen
 * file, or when the next line is the caret that closes such a block.
 *
 * HONEST LIMITS. This is a lexical + local-context filter, not a proof:
 * - the one kept assertion line is whatever the runner put in the message, so a reference that
 *   throws with a secret *as its message* still surfaces that message (bounded to one truncated
 *   line, dropped if it looks like code or like an expression, and dropped when it sits inside a
 *   location-header block). It is NOT proven to be free of reference-implementation text: a line
 *   that both looks like a runner message and stands outside any header block is kept, whoever
 *   composed it.
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
 * A runner's own `expected …` / `Expected: …` summary line. Unmarked, this shape is also what a
 * fixture/table literal in the reference implementation looks like (`expected: SECRET(n) * 7,`), so
 * it is only trusted once a frame naming a FROZEN file has already been seen in the same output —
 * i.e. the runner really is reporting on the bar.
 */
const EXPECTED_LINE = /^\s*expected\b[:\s]\s*(?<body>.*)$/i;

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
  const slashed = line.match(SLASH_REF) ?? [];
  const bare = line.replace(SLASH_REF, ' ').match(FILE_LINE_REF) ?? [];
  return [...slashed, ...bare].map((t) => t.replace(/(?::\d+)+$/, ''));
}

/** True when the text lexically parses as source code rather than as a message about a failure. */
function looksLikeCode(text: string): boolean {
  return CODE_OPENER.test(text) || CODE_TOKEN.test(text) || ASSIGNMENT.test(text);
}

/**
 * The line itself when it is a recognized assertion/error message that is not code; else nothing.
 * `sawFrozenFrame` gates the unmarked `expected …` shape (see {@link EXPECTED_LINE}).
 */
function assertionLine(text: string, sawFrozenFrame: boolean): string | undefined {
  const match =
    ERROR_LINE.exec(text) ??
    PYTEST_ASSERT_LINE.exec(text) ??
    (sawFrozenFrame ? EXPECTED_LINE.exec(text) : null);
  if (match === null) return undefined;
  const body = match.groups?.['body'] ?? '';
  if (looksLikeCode(body)) return undefined;
  if (CALL_EXPRESSION.test(body) || TRAILING_COMMA.test(body)) return undefined;
  return text.trim();
}

/**
 * True when a no-file line sits INSIDE a runner's location-header block, i.e. it is a RAW SOURCE
 * LINE of the file the header named rather than a message the runner composed. Two signals, either
 * of which is enough:
 *
 *  - the previous non-empty line carries a file-ish token that is NOT frozen (the header goaly just
 *    dropped — node prints `<path>:LINE` immediately above the offending source line), or
 *  - the next line is the caret that closes such a block.
 *
 * A header naming ONLY frozen files is deliberately not a trigger: the source under it is the bar's
 * own, which the author wrote and may see.
 */
function insideLocationBlock(
  previous: string | undefined,
  next: string | undefined,
  frozen: readonly string[],
  root: string | undefined,
): boolean {
  if (next !== undefined && CARET_LINE.test(next)) return true;
  if (previous === undefined) return false;
  const refs = fileRefs(previous);
  return refs.length > 0 && refs.some((r) => !namesFrozenFile(r, frozen, root));
}

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
  let sawFrozenFrame = false;
  // The previous NON-EMPTY line, tracked before any filtering: the location header that makes a
  // no-file line a source line is itself dropped, so the context must be read off the raw stream.
  let previous: string | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    if (text.trim().length === 0) continue;
    const before = previous;
    previous = text;
    if (GUTTER_LINE.test(text) || CARET_LINE.test(text)) continue;
    const refs = fileRefs(text);
    if (refs.length > 0) {
      const frozenOnly = refs.every((r) => namesFrozenFile(r, frozen, root));
      if (frozenOnly) sawFrozenFrame = true;
      // Frames are capped, but the scan continues: a runner that prints many frozen frames before
      // its summary must not crowd out the one assertion line the author actually needs.
      if (kept.length >= MAX_LINES) continue;
      if (frozenOnly && !looksLikeCode(text)) kept.push(bound(text.trim()));
      continue;
    }
    // Names no file at all: the pytest traceback body, jest's `> 5 | …` marker, a bare runner
    // banner. Dropped by default — only ONE recognized assertion line is allowed through, and only
    // when it is not sitting inside a location-header block (see `insideLocationBlock`).
    if (message !== undefined) continue;
    if (insideLocationBlock(before, lines[i + 1], frozen, root)) continue;
    message = assertionLine(text, sawFrozenFrame);
    if (message !== undefined) kept.push(bound(message));
  }
  return kept.join('\n').trim();
}
