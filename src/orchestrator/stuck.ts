import type { LoopCtx } from './state';

/**
 * Stuck detection (ARCHITECTURE "Stuck detection") — pure over the histories stored in
 * `LoopCtx`. `maxIterations` is the blunt backstop handled in DECIDE; these detectors
 * bail *before* it with an informative reason so an outer wrapper or human can escalate.
 */

/** The kind of stuck condition, so DECIDE can apply reason-specific policy (e.g. excuse a no-diff). */
export type StuckKind = 'budget' | 'crash' | 'no-diff' | 'oscillation' | 'repeat';

/**
 * A detected stuck condition: a typed `kind` + the human-readable `message` (the audit / feedback
 * text). DECIDE keys reason-specific policy off `kind` (e.g. a fresh Sign-off veto excuses a `no-diff`
 * abort, but never a `budget`/`crash`/`repeat`); the `message` is what surfaces in the ABORTED reason.
 */
export type StuckReason = { readonly kind: StuckKind; readonly message: string };

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
 * Issue #54 (+ follow-on F) — the HISTORY-based half of the no-diff excuse: a no-diff iteration is
 * excused when the previous turn never got a fair chance to edit, namely when it was
 *  - killed by a harness TIMEOUT (wall-clock cap), or
 *  - CRASHED (the agent CLI exited abnormally without completing a turn), or
 *  - TRUNCATED (the agent hit its per-run turn cap mid-work — same spirit as a timeout: the work was
 *    cut off, not finished, so a no-diff on that iteration is "ran out of room," not "stuck").
 * In all three a misleading "no-diff" must not mask that the run was cut short — let the
 * timeout/truncated → maxIterations/budget backstop, or the crash → harness-crash streak, make the
 * call. A model that is *perpetually* truncated-with-no-diff still terminates at maxIterations/budget,
 * the correct backstop, rather than a premature no-diff abort on the first capped iteration. Pure over
 * `LoopCtx`. The OTHER half of the excuse — a green ladder blocked only by a FRESH Sign-off veto —
 * needs the in-flight verdict/approval and so lives in DECIDE (`decide.ts`), which holds them; this
 * keeps `detectStuck` purely history-driven.
 */
function noDiffExcusedByRun(ctx: LoopCtx): boolean {
  return (
    ctx.lastRunStatus === 'timeout' ||
    ctx.lastRunStatus === 'crashed' ||
    ctx.lastRunStatus === 'truncated'
  );
}

export function detectStuck(ctx: LoopCtx): StuckReason | null {
  // Budget — independent of iteration count.
  if (ctx.lastBudget?.exceeded === true) {
    return { kind: 'budget', message: 'budget exceeded' };
  }

  // Harness crash — the agent CLI exited abnormally N times in a row without ever completing a turn.
  // Checked BEFORE no-diff / repeat-failure because both of those are downstream symptoms of a crash
  // (the verifier runs on a tree the agent never finished editing) and would otherwise disguise an
  // environment/harness failure as "your code is wrong". Names the actual harness error, not the red.
  const crashThreshold = ctx.config.stuckPolicy.harnessCrashThreshold;
  if (isCrashStreak(ctx.runStatusHistory, crashThreshold)) {
    return { kind: 'crash', message: harnessCrashReason(crashThreshold, ctx.lastRunOutput ?? '') };
  }

  // No-diff — the most recent iteration left the working tree unchanged. Excused once (issue #54) by
  // the history half here (timeout/crash); the fresh-veto half is applied by DECIDE on a `no-diff` kind.
  if (
    ctx.config.stuckPolicy.noDiff &&
    ctx.lastNoDiff &&
    ctx.iteration >= 1 &&
    !noDiffExcusedByRun(ctx)
  ) {
    return { kind: 'no-diff', message: 'no-diff: working tree unchanged after an iteration' };
  }

  // Oscillation — diff hash cycles with a short period (A,B,A,B; A,B,C,A,B,C; …).
  if (ctx.config.stuckPolicy.oscillation) {
    const period = oscillationPeriod(ctx.diffHashHistory);
    if (period !== null) {
      return { kind: 'oscillation', message: `oscillation: diff hash cycling with period ${period}` };
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
    return { kind: 'repeat', message: repeatFailureReason(threshold, signature) };
  }

  return null;
}

/** Cap the harness-error snippet folded into the crash reason so a large dump doesn't bloat the log. */
const CRASH_OUTPUT_LIMIT = 500;

/**
 * The harness-crash abort reason: the agent CLI exited abnormally `threshold` times in a row without
 * completing a turn. This is an environment/harness failure (the agent never ran), NOT a problem with
 * the code or the frozen contract — so the message points the user at the harness, not at a downstream
 * verifier red, and surfaces the harness's own error output verbatim so the real cause is visible.
 */
function harnessCrashReason(threshold: number, output: string): string {
  const trimmed = output.trim();
  const snippet =
    trimmed.length > CRASH_OUTPUT_LIMIT ? `${trimmed.slice(0, CRASH_OUTPUT_LIMIT)}…` : trimmed;
  const tail = snippet.length > 0 ? ` Last harness output: ${snippet}` : '';
  return (
    `STUCK_HARNESS_CRASH: the coding-agent harness exited abnormally ${threshold} times in a row — ` +
    'it never completed a turn, so this is a harness/environment failure, not a problem with your ' +
    'code or the frozen contract. Check that the agent CLI is installed, authenticated, and runnable ' +
    'in this directory (try invoking it directly), then re-run — optionally with a different ' +
    `--harness.${tail}`
  );
}

/** True when the last `threshold` harness runs all crashed (a consecutive crash streak). */
function isCrashStreak(history: readonly string[], threshold: number): boolean {
  if (history.length < threshold) return false;
  const tail = history.slice(history.length - threshold);
  return tail.every((s) => s === 'crashed');
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
function repeatFailureReason(threshold: number, signature: string): string {
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
