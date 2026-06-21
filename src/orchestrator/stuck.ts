import type { LoopCtx } from './state';

/**
 * Stuck detection (ARCHITECTURE "Stuck detection") — pure over the histories stored in
 * `LoopCtx`. `maxIterations` is the blunt backstop handled in DECIDE; these detectors
 * bail *before* it with an informative reason so an outer wrapper or human can escalate.
 *
 * Returns a human-readable reason string, or `null` if no stuck condition is met.
 */
export type StuckReason = string;

/** Normalize verifier detail so cosmetically-different-but-equal failures compare equal. */
export function normalizeDetail(detail: string): string {
  return detail.trim().replace(/\s+/g, ' ');
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

  // Oscillation — diff hash flip-flops A,B,A,B between two distinct states.
  if (ctx.config.stuckPolicy.oscillation && isOscillating(ctx.diffHashHistory)) {
    return 'oscillation: diff hash cycling between two states';
  }

  // Repeat-failure — the same normalized verifier failure N times in a row.
  const threshold = ctx.config.stuckPolicy.repeatFailureThreshold;
  if (isRepeating(ctx.verifierDetailHistory, threshold)) {
    return `repeat-failure: identical verifier failure ${threshold} times in a row`;
  }

  return null;
}

function isOscillating(history: readonly string[]): boolean {
  const n = history.length;
  if (n < 4) return false;
  const a = history[n - 4];
  const b = history[n - 3];
  const c = history[n - 2];
  const d = history[n - 1];
  // A,B,A,B with A != B.
  return a === c && b === d && a !== b;
}

function isRepeating(history: readonly string[], threshold: number): boolean {
  if (history.length < threshold) return false;
  const tail = history.slice(history.length - threshold);
  const first = tail[0];
  return tail.every((d) => d === first);
}
