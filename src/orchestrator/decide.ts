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
 * `approval` is `null` when the ladder failed (Gate B never ran — no judge/veto wasted).
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

  // We would otherwise CONTINUE — apply the terminal backstops first.
  const stuck = detectStuck(ctx);
  if (stuck !== null) {
    return { kind: 'ABORTED', reason: stuck };
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
