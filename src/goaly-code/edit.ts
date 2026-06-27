/**
 * The pure core of `edit_file` — the single largest determinant of how many iterations an SDK-harness
 * run takes (spec §2.6). A naive exact-only string replace thrashes: the model copies text with a
 * stray trailing space or a different indent and the edit fails, burning a turn. So this implements a
 * deliberate ladder — exact first, then whitespace-tolerant line matching — and, crucially, returns
 * a CLEAR, ACTIONABLE error string for every failure mode (not found / not unique / empty / no-op) so
 * the model can recover on the next turn instead of guessing. `write_file` remains the escape hatch.
 *
 * It is a pure function over strings (no IO), which is why it can carry the heaviest unit-test table
 * in the slice.
 */

/** The outcome of attempting an edit. A failure carries a model-readable `reason`, never throws. */
export type EditResult =
  | { ok: true; content: string; strategy: 'exact' | 'whitespace' }
  | { ok: false; reason: string };

/** Count non-overlapping occurrences of `needle` in `haystack` (needle is non-empty here). */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count += 1;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

/** Start indices where `oldLines` matches a whole-line window of `lines` under `eq` (per line). */
function lineBlockMatches(
  lines: string[],
  oldLines: string[],
  eq: (a: string, b: string) => boolean,
): number[] {
  const matches: number[] = [];
  const last = lines.length - oldLines.length;
  for (let i = 0; i <= last; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (!eq(lines[i + j]!, oldLines[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push(i);
  }
  return matches;
}

/**
 * Splice `newString` in place of `oldLen` lines starting at `start`, preserving the file's line-ending
 * style: a CRLF file's kept lines already carry their `\r` (we split only on `\n`), so we append `\r`
 * to each INSERTED line too — otherwise an LF `new_string` would smear LF endings into a CRLF file.
 */
function spliceLines(lines: string[], start: number, oldLen: number, newString: string, crlf: boolean): string {
  const newLines = newString.split('\n').map((l) => (crlf && !l.endsWith('\r') ? `${l}\r` : l));
  return [...lines.slice(0, start), ...newLines, ...lines.slice(start + oldLen)].join('\n');
}

/**
 * Apply a single `old_string` → `new_string` edit to `content`, trying strategies in order:
 *   1. EXACT substring occurring exactly once (the common, intended case).
 *   2. When the exact substring occurs MORE than once, fall back to whole-LINE-block matching: a
 *      `old_string` that is a full, genuinely-unique line is often a substring of a longer indented
 *      line too (raw counting would falsely reject it as "not unique"). If exactly one whole-line
 *      block matches, that is the intended edit; otherwise it is truly ambiguous → fail closed.
 *   3. WHITESPACE-TOLERANT line matching — compare each line trimmed, so a leading-indent or
 *      trailing-whitespace mismatch still lands (also the path for an LF old_string into a CRLF file).
 * Each failure returns a reason that tells the model exactly how to retry. Line endings are preserved.
 */
export function applyEdit(content: string, oldString: string, newString: string): EditResult {
  if (oldString.length === 0) {
    return { ok: false, reason: 'old_string must not be empty — use write_file to create or overwrite a file' };
  }
  if (oldString === newString) {
    return { ok: false, reason: 'old_string and new_string are identical — there is no change to make' };
  }

  const crlf = content.includes('\r\n');
  const lines = content.split('\n');
  const oldLines = oldString.split('\n');

  // 1. Exact substring.
  const exact = countOccurrences(content, oldString);
  if (exact === 1) {
    return { ok: true, content: content.split(oldString).join(newString), strategy: 'exact' };
  }
  if (exact > 1) {
    // Disambiguate by whole-line equality: a unique full line can be a substring of another line.
    const blocks = lineBlockMatches(lines, oldLines, (a, b) => a === b);
    if (blocks.length === 1) {
      return { ok: true, content: spliceLines(lines, blocks[0]!, oldLines.length, newString, crlf), strategy: 'exact' };
    }
    return {
      ok: false,
      reason: `old_string is not unique (${exact} exact matches) — include more surrounding context so it matches exactly one location`,
    };
  }

  // 2. Whitespace-tolerant, line-based.
  const matches = lineBlockMatches(lines, oldLines, (a, b) => a.trim() === b.trim());
  if (matches.length === 1) {
    return { ok: true, content: spliceLines(lines, matches[0]!, oldLines.length, newString, crlf), strategy: 'whitespace' };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: `old_string matches ${matches.length} locations when ignoring whitespace — include more surrounding context to disambiguate`,
    };
  }
  return {
    ok: false,
    reason:
      'old_string not found in the file (tried exact and whitespace-tolerant matching) — re-read the file to copy the exact text, or use write_file to replace the whole file',
  };
}
