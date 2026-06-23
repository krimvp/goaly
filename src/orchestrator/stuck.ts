import type { LoopCtx } from './state';
import type { Verdict, ApprovalVerdict } from '../domain';

/**
 * The in-flight decision context (issue #54): the verdict + approval the reducer is deciding on right
 * now. Threaded into stuck detection so a no-diff iteration whose ONLY blocker is a fresh, correctable
 * veto isn't aborted before the agent gets one real turn to act on it. Optional so callers that only
 * test the history-based detectors (budget / oscillation / repeat-failure) need not supply it.
 */
export type DecisionContext = {
  readonly ladder: Verdict;
  readonly approval: ApprovalVerdict | null;
};

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

/**
 * Issue #54 — a no-diff iteration is EXCUSED (not yet terminal) when the agent never had a fair
 * chance to act, so we don't discard a correct, actionable signal before one real turn:
 *  - the previous turn was killed by a harness TIMEOUT (it never got to edit), or
 *  - the deterministic ladder is GREEN and the only blocker is a FRESH Sign-off veto the agent has not
 *    yet seen — its reason differs from the feedback the just-run turn was given (`ctx.feedback`).
 * A veto is the system's most valuable signal (it catches what the tests miss); aborting before the
 * worker can respond wastes the run AND throws away a correct critique. The excuse is one-shot: a
 * SECOND unproductive no-diff trips (the veto reason now equals the prior feedback, or the turn
 * completed rather than timing out), and budget / maxIterations / repeat-failure remain backstops, so
 * the loop still terminates and a red is never turned green.
 */
function noDiffExcused(ctx: LoopCtx, current?: DecisionContext): boolean {
  if (ctx.lastRunStatus === 'timeout') return true;
  if (current?.ladder.pass === true && current.approval?.veto === true) {
    const reason = current.approval.reason ?? '';
    return reason !== (ctx.feedback ?? '');
  }
  return false;
}

export function detectStuck(ctx: LoopCtx, current?: DecisionContext): StuckReason | null {
  // Budget — independent of iteration count.
  if (ctx.lastBudget?.exceeded === true) {
    return 'budget exceeded';
  }

  // No-diff — the most recent iteration left the working tree unchanged. Excused once (issue #54)
  // when the agent never got a fair chance to act on a correct signal (see noDiffExcused).
  if (
    ctx.config.stuckPolicy.noDiff &&
    ctx.lastNoDiff &&
    ctx.iteration >= 1 &&
    !noDiffExcused(ctx, current)
  ) {
    return 'no-diff: working tree unchanged after an iteration';
  }

  // Oscillation — diff hash cycles with a short period (A,B,A,B; A,B,C,A,B,C; …).
  if (ctx.config.stuckPolicy.oscillation) {
    const period = oscillationPeriod(ctx.diffHashHistory);
    if (period !== null) {
      return `oscillation: diff hash cycling with period ${period}`;
    }
  }

  // Repeat-failure — the same normalized verifier failure N times in a row. This is keyed PURELY on
  // the verifier-failure signature (`verifierDetailHistory`), independent of the working-tree diff
  // hash: a worker that churns unrelated files every turn (so the diff hash keeps moving) but never
  // changes the verifier outcome is still caught here. The abort names the repeated signature so the
  // failure is diagnosable and points at where the fix really is.
  const threshold = ctx.config.stuckPolicy.repeatFailureThreshold;
  if (isRepeating(ctx.verifierDetailHistory, threshold)) {
    const signature = ctx.verifierDetailHistory[ctx.verifierDetailHistory.length - 1] ?? '';
    return repeatFailureReason(threshold, signature);
  }

  return null;
}

/** Cap the signature folded into the abort reason so a large verifier dump doesn't bloat the run log. */
const SIGNATURE_REASON_LIMIT = 500;

/**
 * The repeat-failure abort reason (Fix #3 — issue: stuck on a byte-identical verifier error). Keeps the
 * legacy `repeat-failure` marker for back-compat, adds the typed `STUCK_REPEATED_FAILURE` label, names
 * the repeated (already-normalized) signature, and hints where the fix actually lies — so a worker that
 * keeps editing unrelated files while the same error repeats is told to look at the file in the error,
 * the contract, or the setup, rather than churning on.
 */
function repeatFailureReason(threshold: number, signature: string): StuckReason {
  const sig =
    signature.length > SIGNATURE_REASON_LIMIT
      ? `${signature.slice(0, SIGNATURE_REASON_LIMIT)}…`
      : signature;
  return (
    `repeat-failure (STUCK_REPEATED_FAILURE): the same verifier error has repeated ${threshold} ` +
    'times in a row despite code changes — the fix likely lies in the file named in the error, or in ' +
    `the contract/setup, not in churning unrelated files. Repeated failure signature: ${sig}`
  );
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
