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

/** Whether the window of `lines` starting at `start` equals `target` element-by-element. */
function windowMatches(lines: string[], start: number, target: string[]): boolean {
  for (let j = 0; j < target.length; j++) {
    if (lines[start + j] !== target[j]) return false;
  }
  return true;
}

/** All start indices where the trimmed `oldLines` block matches a trimmed window of `lines`. */
function whitespaceMatches(lines: string[], oldLines: string[]): number[] {
  const trimmed = lines.map((l) => l.trim());
  const target = oldLines.map((l) => l.trim());
  const matches: number[] = [];
  const last = lines.length - oldLines.length;
  for (let i = 0; i <= last; i++) {
    if (windowMatches(trimmed, i, target)) matches.push(i);
  }
  return matches;
}

/**
 * Apply a single `old_string` → `new_string` edit to `content`, trying strategies in order:
 *   1. EXACT substring — must occur exactly once (the common, intended case).
 *      - 0 occurrences → fall through to whitespace matching;
 *      - >1 occurrences → fail-closed "not unique" so an ambiguous edit is never silently applied.
 *   2. WHITESPACE-TOLERANT line matching — compare each line trimmed, so a leading-indent or
 *      trailing-whitespace mismatch still lands. Must match exactly one line block.
 * Each failure returns a reason that tells the model exactly how to retry.
 */
export function applyEdit(content: string, oldString: string, newString: string): EditResult {
  if (oldString.length === 0) {
    return { ok: false, reason: 'old_string must not be empty — use write_file to create or overwrite a file' };
  }
  if (oldString === newString) {
    return { ok: false, reason: 'old_string and new_string are identical — there is no change to make' };
  }

  // 1. Exact.
  const exact = countOccurrences(content, oldString);
  if (exact === 1) {
    return { ok: true, content: content.split(oldString).join(newString), strategy: 'exact' };
  }
  if (exact > 1) {
    return {
      ok: false,
      reason: `old_string is not unique (${exact} exact matches) — include more surrounding context so it matches exactly one location`,
    };
  }

  // 2. Whitespace-tolerant, line-based.
  const lines = content.split('\n');
  const oldLines = oldString.split('\n');
  const matches = whitespaceMatches(lines, oldLines);
  if (matches.length === 1) {
    const i = matches[0]!;
    const rebuilt = [...lines.slice(0, i), ...newString.split('\n'), ...lines.slice(i + oldLines.length)];
    return { ok: true, content: rebuilt.join('\n'), strategy: 'whitespace' };
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
