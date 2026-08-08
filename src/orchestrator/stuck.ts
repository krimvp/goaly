import type { DiffHash } from '../domain/ids';
import type { LoopCtx } from './state';

/**
 * Stuck detection (ARCHITECTURE "Stuck detection") — pure over the histories stored in
 * `LoopCtx`. `maxIterations` is the blunt backstop handled in DECIDE; these detectors
 * bail *before* it with an informative reason so an outer wrapper or human can escalate.
 */

/** The kind of stuck condition, so DECIDE can apply reason-specific policy (e.g. excuse a no-diff). */
export type StuckKind =
  | 'budget'
  | 'crash'
  | 'unevaluable'
  | 'no-diff'
  | 'timeout-no-diff'
  | 'oscillation'
  | 'repeat';

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
 *
 * Issue #119 — the excuse is now BOUNDED for the timeout case. `crashed` (already governed by the
 * harness-crash streak) and `truncated` (a per-run turn cap, not a wall-clock kill — follow-on F's
 * documented maxIterations/budget backstop still applies) keep the unbounded excuse; a `timeout` is
 * excused only while the timeout-no-diff streak is still SHORT of its threshold, so the typed
 * `timeout-no-diff` abort below takes over exactly where the excuse ends. At the default threshold
 * (2) that is issue #54's single excused turn.
 */
function noDiffExcusedByRun(ctx: LoopCtx): boolean {
  if (ctx.lastRunStatus === 'crashed' || ctx.lastRunStatus === 'truncated') return true;
  if (ctx.lastRunStatus !== 'timeout') return false;
  return timeoutNoDiffStreak(ctx) < ctx.config.stuckPolicy.timeoutNoDiffThreshold;
}

/**
 * How many of the most recent iterations BOTH timed out and left the working tree unchanged
 * (issue #119) — the single fact behind both the capped no-diff excuse and the typed
 * `timeout-no-diff` abort, so the excuse ends exactly where the abort begins.
 *
 * Pure over `LoopCtx`. The CURRENT iteration is read from `lastRunStatus`/`lastNoDiff` (the
 * authoritative pair the reducer just recorded); earlier iterations are folded off the parallel
 * `runStatusHistory` + `diffHashHistory` (an iteration changed nothing iff its post-run hash equals
 * the previous iteration's). The walk stops at index 0 because iteration 1's no-diff is unknowable
 * from the histories — the pre-run baseline hash is not in them — which is the conservative
 * direction: it can only DELAY the abort by one iteration, never fire it early.
 */
function timeoutNoDiffStreak(ctx: LoopCtx): number {
  if (ctx.lastRunStatus !== 'timeout' || !ctx.lastNoDiff) return 0;
  const statuses = ctx.runStatusHistory;
  const hashes = ctx.diffHashHistory;
  let streak = 1;
  for (let i = statuses.length - 2; i >= 1; i -= 1) {
    if (statuses[i] !== 'timeout') break;
    if (!unchangedAt(hashes, i)) break;
    streak += 1;
  }
  return streak;
}

/** True when the iteration at `idx` left the tree exactly as the previous iteration did. */
function unchangedAt(hashes: readonly DiffHash[], idx: number): boolean {
  const hash = hashes[idx];
  return hash !== undefined && hash === hashes[idx - 1];
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
  // A spent crash remediation (improvement plan 4.2) raises the effective threshold by one attempt.
  const crashThreshold = ctx.config.stuckPolicy.harnessCrashThreshold + ctx.remediations.crash;
  if (isCrashStreak(ctx.runStatusHistory, crashThreshold)) {
    return {
      kind: 'crash',
      message: harnessCrashReason(crashThreshold, ctx.lastRunOutput ?? '', ctx.lastRunHint),
    };
  }

  // Contract unevaluable — the frozen verifier ladder could not be EVALUATED to a real pass/fail
  // `unevaluableThreshold` times in a row (the verify command itself failed to run — a missing tool,
  // a network / package-manager error, a timeout/kill — or the LLM judge errored / overflowed). Like
  // the crash check, this is placed BEFORE no-diff / repeat / oscillation because all three are
  // DOWNSTREAM SYMPTOMS of a checker that can't run: on a tree the agent left unchanged the
  // unevaluable verdict reads as "no-diff", and the byte-identical can't-run error reads as
  // "repeat-failure" — both of which would blame (and discard) a possibly-correct tree for a
  // verification-ENVIRONMENT failure. Naming it CONTRACT_UNEVALUABLE keeps the run fail-closed (never
  // a green) while telling the user the work may be correct-but-unverified and what to fix.
  const unevalThreshold = ctx.config.stuckPolicy.unevaluableThreshold;
  if (isUnevaluableStreak(ctx.verifierEvaluableHistory, unevalThreshold)) {
    return {
      kind: 'unevaluable',
      message: contractUnevaluableReason(unevalThreshold, ctx.lastVerdict?.detail ?? ''),
    };
  }

  // Timeout + no-diff streak (issue #119) — the last `timeoutNoDiffThreshold` iterations were ALL
  // killed by the harness wall-clock cap AND all left the tree unchanged. Checked BEFORE the generic
  // no-diff (which the capped excuse would otherwise trip with a message blaming the agent) because
  // this is a harness/budget-shape failure like the crash streak: the turn is running out of TIME,
  // not out of ideas, so the abort names the two timeout flags instead of "the agent stopped editing".
  // Deliberately NOT gated on `stuckPolicy.noDiff` — that toggle exists to let a worker keep going
  // when it makes no edits, and must not silently re-open the unbounded ten-minute burn.
  const timeoutThreshold = ctx.config.stuckPolicy.timeoutNoDiffThreshold;
  if (timeoutNoDiffStreak(ctx) >= timeoutThreshold) {
    return { kind: 'timeout-no-diff', message: timeoutNoDiffReason(timeoutThreshold) };
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
  // failure is diagnosable and points at where the fix really is. A spent repeat remediation
  // (improvement plan 4.2) raises the effective threshold by one attempt.
  const threshold = ctx.config.stuckPolicy.repeatFailureThreshold + ctx.remediations.repeat;
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
 *
 * `hint` is a codec-recognised remediation the CLI named in its OWN output (see
 * {@link HarnessRunResult.hint}) — e.g. droid refusing an action at its `--auto` tier. When present
 * it REPLACES the generic install/auth advice, which in that situation is three dead ends: the CLI
 * is installed, authenticated and runnable, and the real fix was already in the log. The abort kind
 * and the fail-closed outcome are identical either way — only the guidance changes.
 */
function harnessCrashReason(threshold: number, output: string, hint?: string): string {
  const trimmed = output.trim();
  const snippet =
    trimmed.length > CRASH_OUTPUT_LIMIT ? `${trimmed.slice(0, CRASH_OUTPUT_LIMIT)}…` : trimmed;
  const tail = snippet.length > 0 ? ` Last harness output: ${snippet}` : '';
  const head =
    `STUCK_HARNESS_CRASH: the coding-agent harness exited abnormally ${threshold} times in a row — ` +
    'it never completed a turn, so this is not a problem with your code or the frozen contract. ';
  const advice =
    hint !== undefined && hint.length > 0
      ? hint
      : 'Check that the agent CLI is installed, authenticated, and runnable in this directory (try ' +
        'invoking it directly), then re-run — optionally with a different --harness.';
  return `${head}${advice}${tail}`;
}

/** True when the last `threshold` harness runs all crashed (a consecutive crash streak). */
function isCrashStreak(history: readonly string[], threshold: number): boolean {
  if (history.length < threshold) return false;
  const tail = history.slice(history.length - threshold);
  return tail.every((s) => s === 'crashed');
}

/**
 * True when the last `threshold` verifier evaluations were all could-not-evaluate (a consecutive
 * unevaluable streak). The history stores `evaluable` per iteration (`false` ⇒ the ladder could not
 * be run to a real pass/fail), so the streak is `threshold` trailing `false`s. A real evaluation
 * (pass or genuine fail) appends `true` and breaks it — exactly the crash-streak shape over a
 * different signal.
 */
function isUnevaluableStreak(history: readonly boolean[], threshold: number): boolean {
  if (history.length < threshold) return false;
  const tail = history.slice(history.length - threshold);
  return tail.every((evaluable) => evaluable === false);
}

/**
 * The contract-unevaluable abort reason: the frozen verifier ladder could not be evaluated to a real
 * pass/fail `threshold` times in a row. This is a verification-ENVIRONMENT failure (the check never
 * ran), NOT evidence the code is wrong — so the message says the working tree may in fact satisfy the
 * goal but is UNVERIFIED, points at the fix (install the tool, allow the verify command network, raise
 * --verify-timeout-ms, shrink the judge input with --delta-verify), and surfaces the verifier's own
 * last output so the real cause is visible. Still fail-closed upstream: an unevaluable contract is
 * never DONE.
 */
function contractUnevaluableReason(threshold: number, detail: string): string {
  const trimmed = detail.trim();
  const snippet =
    trimmed.length > CRASH_OUTPUT_LIMIT ? `${trimmed.slice(0, CRASH_OUTPUT_LIMIT)}…` : trimmed;
  const tail = snippet.length > 0 ? ` Last verifier output: ${snippet}` : '';
  return (
    `CONTRACT_UNEVALUABLE: the frozen verifier ladder could not be evaluated to a real pass/fail ` +
    `${threshold} times in a row — the check itself failed to RUN (a missing tool, a network / ` +
    'package-manager error, a timeout, or an LLM judge that errored or overflowed its context), so ' +
    'this is a verification-environment failure, not evidence your code is wrong. Your working tree ' +
    'may in fact satisfy the goal but is UNVERIFIED. Fix the verification environment (install the ' +
    'missing tool, allow network for the verify command, raise --verify-timeout-ms, or shrink the ' +
    `judge input with --delta-verify) and re-run, or run the frozen verify command yourself.${tail}`
  );
}

/**
 * The timeout-no-diff abort reason (issue #119): `threshold` consecutive iterations were killed by
 * the harness wall-clock cap and each left the working tree untouched. That is a RESOURCE-shape
 * failure, not evidence the code or the contract is wrong — the worker keeps being guillotined
 * mid-turn, so every further iteration costs a full timeout for nothing. The message therefore names
 * the two flags that actually fix it: the hard cap (`--harness-timeout-ms`) and the idle/heartbeat
 * cap (`--harness-idle-timeout-ms`), which only kills a turn once it has gone QUIET, so a
 * still-progressing agent is not cut off. Still fail-closed: a cut-off turn is a `timeout` run and
 * the run aborts — never a green.
 */
function timeoutNoDiffReason(threshold: number): string {
  return (
    `STUCK_TIMEOUT_NO_DIFF: the harness was killed by its wall-clock timeout ${threshold} times in ` +
    'a row and every one of those iterations left the working tree UNCHANGED — the agent is running ' +
    'out of TIME, not out of ideas, so more iterations at the same cap would burn the budget for ' +
    'nothing. Give a turn more room: raise --harness-timeout-ms (the hard cap), and/or set ' +
    '--harness-idle-timeout-ms so a still-progressing turn is only killed after it goes quiet. To ' +
    'tolerate a longer run of cut-off turns instead, raise --stuck-timeout-no-diff-threshold.'
  );
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
 * The typed marker opening a contract-defective abort (issue #116). Exported so the CLI's next-step
 * hint, the docs' outcome tables, and tests all key off ONE string rather than re-typing it.
 */
export const CONTRACT_DEFECTIVE_MARKER = 'CONTRACT_DEFECTIVE';

/**
 * The contract-defective abort reason (issue #116) — the sibling of {@link contractUnevaluableReason}.
 * That one means "the checker could not RUN"; this one means "the checker ran fine and is WRONG": an
 * adjudicator, given a tree that now contains a real implementation, judged that NO implementation
 * could satisfy the frozen assertion the worker keeps failing.
 *
 * The run was already terminating on a repeat-failure streak, so this only changes the LABEL — but
 * the label is the whole point: today's text tells the operator to raise `--stuck-repeat-threshold`,
 * which cannot possibly help against an unsatisfiable bar, and implies the (possibly correct) tree is
 * worthless. So the message names the frozen file(s) the signature pointed at, states plainly that
 * the implementation may be correct and the tree is worth keeping, and carries the original
 * repeat-failure text as context. It deliberately does NOT name a successor command: the reducer has
 * no `runId` (that is Driver identity, not loop state) — the CLI's next-step hint owns that.
 */
export function contractDefectiveReason(
  paths: readonly string[],
  verdictReason: string,
  fallbackReason: string,
): string {
  const named = paths.length > 0 ? paths.join(', ') : 'the frozen authored verification';
  const trimmed = verdictReason.trim();
  const why =
    trimmed.length > SIGNATURE_REASON_LIMIT
      ? `${trimmed.slice(0, SIGNATURE_REASON_LIMIT)}…`
      : trimmed;
  return (
    `${CONTRACT_DEFECTIVE_MARKER}: the frozen verification is DEFECTIVE — re-adjudicated in-loop ` +
    'against a tree that now contains a real implementation, the same assertion still reds, and no ' +
    `implementation could satisfy it. The defect is in ${named}, which is frozen, so the worker can ` +
    'never fix it. Your implementation may well be correct: KEEP the working tree — it was not ' +
    'rejected on its merits. Re-run with a corrected bar (an explicit --verify-cmd, or a refined ' +
    `goal) rather than more iterations against this one.${why.length > 0 ? ` Adjudicator: ${why}` : ''}` +
    ` Original stuck condition: ${fallbackReason}`
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
