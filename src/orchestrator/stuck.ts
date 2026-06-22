import type { LoopCtx } from './state';

/**
 * Stuck detection (ARCHITECTURE "Stuck detection") — pure over the histories stored in
 * `LoopCtx`. `maxIterations` is the blunt backstop handled in DECIDE; these detectors
 * bail *before* it with an informative reason so an outer wrapper or human can escalate.
 *
 * Returns a human-readable reason string, or `null` if no stuck condition is met.
 */
export type StuckReason = string;

/**
 * Volatile-token scrubbers applied (in order) before whitespace is collapsed, so a failure line
 * that is identical except for a timestamp / PID / hex id / temp path still compares equal for
 * repeat-failure detection. Each replaces the variable run with a stable placeholder. Kept
 * conservative: only patterns that are unmistakably run-to-run noise, never plain digit runs (which
 * could be a meaningful "3 of 5 tests failed" count whose change is real signal).
 */
const VOLATILE_PATTERNS: readonly (readonly [RegExp, string])[] = [
  // ISO-8601 date-times (with optional fractional seconds / timezone), e.g. 2026-06-22T14:03:11.482Z.
  [/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
  // Bare wall-clock times, e.g. 14:03:11 or 14:03:11.482.
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<TS>'],
  // Hex memory addresses / pointers, e.g. 0x7ffe1a2b.
  [/\b0x[0-9a-fA-F]+\b/g, '<HEX>'],
  // OS temp paths (unix /tmp, macOS /var/folders, plus the goaly temp index), e.g. /tmp/pytest-abc.
  [/(?:\/tmp|\/var\/folders|\/var\/tmp)\/\S+/g, '<TMP>'],
  [/\bgoaly-idx-\S+/g, '<TMP>'],
  // PIDs, when explicitly labelled so we don't swallow meaningful counts: pid=1234 / PID 1234.
  [/\b(pid)[=:]?\s*\d+/gi, '$1=<N>'],
  // Long hex runs (sha/object ids, uuids' hex chunks), 7+ chars — rare in real prose.
  [/\b[0-9a-fA-F]{7,}\b/g, '<HEX>'],
];

/**
 * Normalize verifier detail so cosmetically-different-but-equal failures compare equal. Collapses
 * whitespace AND scrubs volatile tokens (timestamps, PIDs, hex ids, temp paths) so a failure line
 * that only differs by such noise still trips repeat-failure detection.
 */
export function normalizeDetail(detail: string): string {
  let out = detail;
  for (const [pattern, replacement] of VOLATILE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.trim().replace(/\s+/g, ' ');
}

export function detectStuck(ctx: LoopCtx): StuckReason | null {
  // Budget — independent of iteration count.
  if (ctx.lastBudget?.exceeded === true) {
    return 'budget exceeded';
  }

  // No-diff — the most recent iteration left the working tree unchanged.
  if (ctx.config.stuckPolicy.noDiff && ctx.lastNoDiff && ctx.iteration >= 1) {
    return 'no-diff: working tree unchanged after an iteration';
  }

  // Oscillation — diff hash cycles with a short period (A,B,A,B; A,B,C,A,B,C; …).
  if (ctx.config.stuckPolicy.oscillation) {
    const period = oscillationPeriod(ctx.diffHashHistory);
    if (period !== null) {
      return `oscillation: diff hash cycling with period ${period}`;
    }
  }

  // Repeat-failure — the same normalized verifier failure N times in a row.
  const threshold = ctx.config.stuckPolicy.repeatFailureThreshold;
  if (isRepeating(ctx.verifierDetailHistory, threshold)) {
    return `repeat-failure: identical verifier failure ${threshold} times in a row`;
  }

  return null;
}

/**
 * The largest period worth chasing. A real loop that oscillates does so over a SMALL cycle
 * (the agent keeps undoing then redoing the same handful of states); a long apparent cycle is
 * better left to `maxIterations`. We require two full back-to-back cycles before calling it.
 */
const MAX_OSCILLATION_PERIOD = 4;

/**
 * Detect period-N oscillation: the diff-hash history ends in two identical consecutive blocks
 * of length `p` (so the last `2p` entries are `X·X`), for the smallest `2 ≤ p ≤ MAX_OSCILLATION_PERIOD`,
 * where the block is not constant (a constant tail is no-diff/repeat territory, not oscillation).
 * Returns the detected period, or `null`. Pure over the history.
 */
function oscillationPeriod(history: readonly string[]): number | null {
  const n = history.length;
  for (let p = 2; p <= MAX_OSCILLATION_PERIOD; p += 1) {
    if (n < 2 * p) break;
    if (isRepeatingBlock(history, p)) return p;
  }
  return null;
}

/** True when the last `2p` entries are two identical blocks of length `p` that aren't constant. */
function isRepeatingBlock(history: readonly string[], p: number): boolean {
  const n = history.length;
  let distinct = false;
  const first = history[n - 2 * p];
  for (let i = 0; i < p; i += 1) {
    const earlier = history[n - 2 * p + i];
    const later = history[n - p + i];
    if (earlier !== later) return false;
    if (earlier !== first) distinct = true;
  }
  return distinct;
}

function isRepeating(history: readonly string[], threshold: number): boolean {
  if (history.length < threshold) return false;
  const tail = history.slice(history.length - threshold);
  const first = tail[0];
  return tail.every((d) => d === first);
}
