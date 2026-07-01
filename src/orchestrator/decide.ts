import type { LoopCtx } from './state';
import type { Verdict, ApprovalVerdict } from '../domain';
import { detectStuck } from './stuck';

/**
 * The outcome of one DECIDE evaluation — pure data the reducer turns into a state +
 * commands. No LLM, no IO, no clock.
 */
export type Decision =
  | { kind: 'CONTINUE'; feedback: string }
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
    return { kind: 'ABORTED', reason: stuck.message };
  }

  if (ctx.iteration >= ctx.config.maxIterations) {
    return {
      kind: 'FAILED',
      reason: `reached maxIterations (${ctx.config.maxIterations}) without satisfying the contract`,
    };
  }

  // Continue: feed back the verifier detail (failed ladder) or the veto reason.
  if (!ladder.pass) {
    return { kind: 'CONTINUE', feedback: ladder.detail };
  }
  // ladder.pass && veto
  return {
    kind: 'CONTINUE',
    feedback: approval?.reason ?? 'rejected by the approval gate',
  };
}

/**
 * The in-flight half of the no-diff excuse (issue #54): a green ladder blocked only by a FRESH
 * Sign-off veto — one whose reason differs from the feedback the just-run turn was already given
 * (`ctx.feedback`) — so the worker has not yet had a real turn to act on it. One-shot by construction:
 * once that veto reason becomes the prior feedback, it no longer differs and the no-diff abort trips.
 * Pure; lives in DECIDE because it needs the in-flight `ladder`/`approval` the reducer is deciding on.
 */
function freshVeto(ctx: LoopCtx, ladder: Verdict, approval: ApprovalVerdict | null): boolean {
  if (ladder.pass !== true || approval?.veto !== true) return false;
  return (approval.reason ?? '') !== (ctx.feedback ?? '');
}
