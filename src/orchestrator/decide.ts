import type { LoopCtx, RemediationLedger } from './state';
import type { Verdict, ApprovalVerdict } from '../domain';
import { detectStuck } from './stuck';
import { planRemediation } from './remediate';

/**
 * The outcome of one DECIDE evaluation — pure data the reducer turns into a state +
 * commands. No LLM, no IO, no clock. A `CONTINUE` may carry a `remediation` ledger
 * (improvement plan 4.2): the reducer folds it into the next `LoopCtx` so the spent
 * self-recovery is part of the replayable state.
 */
export type Decision =
  | { kind: 'CONTINUE'; feedback: string; source: 'verifier' | 'veto'; remediation?: RemediationLedger }
  | { kind: 'DONE' }
  | { kind: 'FAILED'; reason: string }
  | { kind: 'ABORTED'; reason: string };

/**
 * DECIDE — the DESIGN truth table (DESIGN "Phase 2", ARCHITECTURE "State machine"):
 *
 *   ladder.pass && !veto            → DONE                 (two keys turned)
 *   stuck                           → ABORTED (with reason — bail before the cap)
 *   iteration >= maxIterations      → FAILED
 *   !ladder.pass                    → CONTINUE (verifier detail as feedback)
 *   ladder.pass && veto             → CONTINUE (veto reason as feedback)
 *
 * `approval` is `null` when the ladder failed (Sign-off never ran — no judge/veto wasted).
 * Success (DONE) is checked first so a goal genuinely met on the last allowed iteration
 * is declared DONE, never FAILED. Stuck is preferred over the hard cap because it carries
 * an actionable reason.
 */
export function decide(
  ctx: LoopCtx,
  ladder: Verdict,
  approval: ApprovalVerdict | null,
): Decision {
  // Two independent keys: the frozen verifier passes AND the approver does not veto.
  if (ladder.pass && approval !== null && !approval.veto) {
    return { kind: 'DONE' };
  }

  // We would otherwise CONTINUE — apply the terminal backstops first. `detectStuck` is pure over the
  // histories; the one reason-specific excuse that needs the in-flight verdict/approval lives HERE
  // (issue #54): a `no-diff` abort is excused when the agent had no fair chance to act on a FRESH,
  // correctable Sign-off veto (green ladder, a veto whose reason the just-run turn was NOT yet given).
  // Only `no-diff` is excusable — budget / crash / unevaluable / oscillation / repeat always abort.
  const stuck = detectStuck(ctx);
  if (stuck !== null && !(stuck.kind === 'no-diff' && freshVeto(ctx, ladder, approval))) {
    // Opt-in bounded self-recovery (improvement plan 4.2): a remediable stuck condition may be
    // converted into ONE more guided attempt instead of an abort. Pure policy; the returned ledger
    // rides the CONTINUE so replay reproduces the spend exactly.
    const remediation = planRemediation(ctx, stuck);
    if (remediation !== null) {
      return {
        kind: 'CONTINUE',
        feedback: remediation.feedback,
        source: 'verifier',
        remediation: remediation.ledger,
      };
    }
    return {
      kind: 'ABORTED',
      reason:
        ctx.remediations.total > 0
          ? `${stuck.message} (auto-remediation: ${ctx.remediations.total} self-recovery attempt(s) already spent)`
          : stuck.message,
    };
  }

  // A spent no-diff remediation refunds the iteration its unchanged turn burned (plan 4.2) —
  // `remediations.noDiff` is 0 or 1, so the cap moves by at most one.
  if (ctx.iteration >= ctx.config.maxIterations + ctx.remediations.noDiff) {
    return {
      kind: 'FAILED',
      reason: `reached maxIterations (${ctx.config.maxIterations}) without satisfying the contract`,
    };
  }

  // Continue: feed back the verifier detail (failed ladder) or the veto reason.
  if (!ladder.pass) {
    return { kind: 'CONTINUE', feedback: ladder.detail, source: 'verifier' };
  }
  // ladder.pass && veto
  return {
    kind: 'CONTINUE',
    feedback: approval?.reason ?? 'rejected by the approval gate',
    source: 'veto',
  };
}

/**
 * The in-flight half of the no-diff excuse (issue #54): a green ladder blocked only by a FRESH
 * Sign-off veto — one the just-run turn was NOT already answering (`ctx.feedbackSource !== 'veto'`)
 * — so the worker has not yet had a real turn to act on a veto-class critique. One-shot by
 * construction: the excused turn's feedback is recorded as `source: 'veto'`, so a second
 * consecutive no-diff-on-veto aborts. Keyed on the feedback's SOURCE, not its text: an LLM
 * approver rewords its veto every round, so a reason-string comparison would classify every veto
 * as fresh and let a worker that never edits burn the whole iteration budget in approver spend.
 * Pure; lives in DECIDE because it needs the in-flight `ladder`/`approval` the reducer is deciding on.
 */
function freshVeto(ctx: LoopCtx, ladder: Verdict, approval: ApprovalVerdict | null): boolean {
  if (ladder.pass !== true || approval?.veto !== true) return false;
  return ctx.feedbackSource !== 'veto';
}
