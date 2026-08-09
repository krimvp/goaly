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
 *    file-ish token at all.
 *
 * Everything else is dropped — including lines that name no file, which is exactly the default that
 * leaked pytest traceback bodies and jest's `> 5 | …` marker line past the previous line-by-line
 * blacklist. A kept line is stripped of ANSI escapes, truncated to {@link MAX_LINE_CHARS}, and
 * dropped if it lexically parses as code by the checks below; at most {@link MAX_LINES} survive.
 *
 * HONEST LIMITS. This is a lexical filter, not a proof:
 * - the one kept assertion line is whatever the runner put in the message, so a reference that
 *   throws with a secret *as its message* still surfaces that message (bounded to one truncated
 *   line, and dropped if it looks like code). It cannot deliver a function body or a file path.
 * - {@link namesFrozenFile} matches a path SUFFIX, so a frame naming `…/<frozen path>` under any
 *   prefix counts as frozen. That is why the dry run drops a reference file by the SAME predicate:
 *   whatever this treats as frozen is never written into the scratch copy in the first place.
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

/** `AssertionError [ERR_ASSERTION]: …`, `ValueError: …`, `E   ValueError: …`, `1) Error: …`. */
const ERROR_LINE =
  /^\s*(?:E\s+)?(?:\d+\)\s*)?(?:[A-Za-z_][\w.]*)?(?:Error|Exception|Failure)(?:\s*\[[^\]\n]{0,60}\])?\s*:\s*(?<body>.*)$/;

/**
 * pytest's `E   assert …` marker line, and a runner's own `expected …` message. The bare
 * `assert …` form is deliberately NOT recognized: unprefixed, that is a traceback SOURCE line.
 */
const ASSERT_LINE = /^\s*(?:E\s+assert(?:ion)?\b|expected\b)[:\s]\s*(?<body>.*)$/i;

/** A statement/declaration opener — anchored, so it fires on source lines, not on prose. */
const CODE_OPENER =
  /^\s*(?:export|import|from|require|module|package|func|function|class|def|return|throw|raise|const|let|var|public|private|protected|static|async|await|yield|struct|interface|enum|type|new|lambda|if|elif|else|for|while|switch|case|try|catch|finally|with|fn|impl|use)\b/;

/** Function-literal / block tokens anywhere in the line (`fn.toString()` folded into a message). */
const CODE_TOKEN =
  /=>|\bfunction\s*[\w$]*\s*\(|\bclass\s+[\w$]+|\bdef\s+[\w$]+\s*\(|\blambda\b[^:\n]{0,40}:|[{;]\s*$/;

/** An assignment (`band = _band_for(amount)`, `const x = 1`) — `==`/`=>` are not assignments. */
const ASSIGNMENT = /^\s*(?:const|let|var)?\s*[\w$][\w$.\[\]'"]*\s*(?:\+|-|\*|\/|%|\|\||&&|\?\?)?=(?!=|>)/;

/** Drop ANSI escapes before matching, so a color code can never break an anchor. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Normalize a workspace-relative path for comparison: trim, drop a leading `./`. */
export function normalizeRel(p: string): string {
  const t = p.trim();
  return t.startsWith('./') ? t.slice(2) : t;
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
  const token = normalizeRel(relativize(ref, root));
  return frozen.some((f) => {
    const path = normalizeRel(f);
    if (path.length === 0) return false;
    return token === path || (root === undefined && token.endsWith(`/${path}`));
  });
}

/** A path inside `root`, expressed relative to it; anything else (or no root) is left alone. */
function relativize(ref: string, root: string | undefined): string {
  if (root === undefined) return ref;
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : ref;
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

/** The line itself when it is a recognized assertion/error message that is not code; else nothing. */
function assertionLine(text: string): string | undefined {
  const match = ERROR_LINE.exec(text) ?? ASSERT_LINE.exec(text);
  if (match === null) return undefined;
  const body = match.groups?.['body'] ?? '';
  if (looksLikeCode(body)) return undefined;
  return text.trim();
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
  const kept: string[] = [];
  let message: string | undefined;
  for (const line of stripAnsi(raw).split('\n')) {
    const text = line.replace(/\s+$/, '');
    if (text.trim().length === 0) continue;
    if (GUTTER_LINE.test(text) || CARET_LINE.test(text)) continue;
    const refs = fileRefs(text);
    if (refs.length > 0) {
      // Frames are capped, but the scan continues: a runner that prints many frozen frames before
      // its summary must not crowd out the one assertion line the author actually needs.
      if (kept.length >= MAX_LINES) continue;
      const frozenOnly = refs.every((r) => namesFrozenFile(r, frozen, root));
      if (frozenOnly && !looksLikeCode(text)) kept.push(bound(text.trim()));
      continue;
    }
    // Names no file at all: the pytest traceback body, jest's `> 5 | …` marker, a bare runner
    // banner. Dropped by default — only ONE recognized assertion line is allowed through.
    if (message !== undefined) continue;
    message = assertionLine(text);
    if (message !== undefined) kept.push(bound(message));
  }
  return kept.join('\n').trim();
}
