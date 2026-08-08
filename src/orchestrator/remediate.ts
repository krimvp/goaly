import type { LoopCtx, RemediationLedger } from './state';
import type { StuckReason } from './stuck';

/**
 * Bounded stuck self-recovery (improvement plan 4.2), PURE like everything else in the reducer.
 * With `--auto-remediate-stuck` the run may spend at most {@link MAX_STUCK_REMEDIATIONS}
 * remediations — one per remediable kind:
 *
 *  - `no-diff`   → one retry with a canned change-your-approach hint; the burned no-diff
 *                  iteration is refunded (DECIDE's cap check adds `ledger.noDiff`).
 *  - `repeat`    → the repeat-failure threshold is effectively raised by one (the detector adds
 *                  `ledger.repeat`), buying exactly one more attempt on a fresh hint.
 *  - `crash`     → the harness-crash threshold is effectively raised by one, buying one more
 *                  attempt after the driver-level retry was already exhausted.
 *
 * NEVER remediated: `unevaluable` (a verification-ENVIRONMENT failure — retrying cannot fix a
 * missing tool), `budget` (an operator cap), and `oscillation` (a cycle a canned hint has already
 * demonstrably failed to break). Those abort exactly as without the flag.
 */

/** Hard per-run cap on remediations (one per remediable kind — the cap makes the bound explicit). */
export const MAX_STUCK_REMEDIATIONS = 3;

/** Prefix every remediation feedback carries — greppable in prompts, logs, and transcripts. */
export const REMEDIATION_MARKER = 'AUTO-REMEDIATION';

export type Remediation = { readonly ledger: RemediationLedger; readonly feedback: string };

/**
 * Decide whether (and how) to remediate `stuck` instead of aborting. Returns `null` when the run
 * must abort: remediation disabled, the kind is not remediable, that kind was already remediated,
 * or the per-run cap is spent.
 */
export function planRemediation(ctx: LoopCtx, stuck: StuckReason): Remediation | null {
  if (!ctx.config.stuckPolicy.autoRemediate) return null;
  const ledger = ctx.remediations;
  if (ledger.total >= MAX_STUCK_REMEDIATIONS) return null;

  const used = `${ledger.total + 1}/${MAX_STUCK_REMEDIATIONS}`;
  if (stuck.kind === 'no-diff' && ledger.noDiff === 0) {
    return {
      ledger: { ...ledger, total: ledger.total + 1, noDiff: ledger.noDiff + 1 },
      feedback:
        `${REMEDIATION_MARKER} ${used} (no-diff): your last turn changed NOTHING in the working ` +
        'tree. Try a genuinely different approach this turn: re-read the goal and the verifier ' +
        'output, pick a different file or strategy, and make a concrete edit. A second unchanged ' +
        'turn aborts the run.',
    };
  }
  if (stuck.kind === 'repeat' && ledger.repeat === 0) {
    return {
      ledger: { ...ledger, total: ledger.total + 1, repeat: ledger.repeat + 1 },
      feedback:
        `${REMEDIATION_MARKER} ${used} (repeat-failure): the SAME verifier error has now repeated ` +
        `across consecutive iterations. One extra attempt is granted. ${stuck.message}`,
    };
  }
  if (stuck.kind === 'crash' && ledger.crash === 0) {
    return {
      ledger: { ...ledger, total: ledger.total + 1, crash: ledger.crash + 1 },
      feedback:
        `${REMEDIATION_MARKER} ${used} (harness-crash): the previous agent invocations exited ` +
        'abnormally without completing a turn. One extra attempt is granted — if this one crashes ' +
        'too, the run aborts with the harness error.',
    };
  }
  return null;
}
