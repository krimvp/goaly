import type { LoopCtx, RemediationLedger } from './state';
import type { Verdict, ApprovalVerdict } from '../domain';
import { detectStuck, type StuckReason } from './stuck';
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
  /**
   * In-loop contract-fault adjudication (issue #116): the run IS terminating on a repeat-failure
   * streak, but the evidence for "the frozen bar itself is defective" now exists, so spend ONE
   * read-only classification before choosing the abort's label. `fallbackReason` is exactly the
   * `ABORTED.reason` this same ctx would otherwise carry, so every failure mode downstream lands on
   * today's output byte-for-byte.
   */
  | { kind: 'ADJUDICATE'; signature: string; repeatCount: number; fallbackReason: string }
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
    // In-loop contract-fault adjudication (issue #116). Placed AFTER remediation (a spent
    // `--auto-remediate-stuck` retry is cheaper than an LLM call and may still green) and BEFORE the
    // abort (which it can only relabel, never avert). Pure: it emits a Decision the reducer turns
    // into ONE Command; the Driver performs the read-only call.
    if (suspectsContractFault(ctx, stuck)) {
      return {
        kind: 'ADJUDICATE',
        signature: lastSignature(ctx),
        repeatCount: ctx.config.stuckPolicy.repeatFailureThreshold + ctx.remediations.repeat,
        fallbackReason: abortReason(ctx, stuck),
      };
    }
    return { kind: 'ABORTED', reason: abortReason(ctx, stuck) };
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
 * The abort text a stuck condition produces — the ONE place it is built, so the adjudication
 * passthrough (issue #116) can carry it verbatim and a `defective: false` verdict is provably
 * byte-identical to the pre-#116 behavior.
 */
function abortReason(ctx: LoopCtx, stuck: StuckReason): string {
  return ctx.remediations.total > 0
    ? `${stuck.message} (auto-remediation: ${ctx.remediations.total} self-recovery attempt(s) already spent)`
    : stuck.message;
}

/**
 * Is this repeat-failure streak plausibly the FROZEN BAR's fault rather than the worker's (issue
 * #116)? Contract soundness is otherwise classified exactly once, at t=0, on a tree with no
 * implementation in it — the moment of least evidence, where an unsatisfiable frozen assertion and
 * an honest "not written yet" red are indistinguishable. This gate names the moment the evidence
 * finally exists, using ONLY facts the reducer already holds (invariant #1):
 *
 *  - `repeat` and nothing else: it is the one detector keyed on the verifier SIGNATURE, so it says
 *    "the same check keeps saying the same thing" rather than "the worker looks idle".
 *  - once per run (`ctx.adjudicated`): bounded, replayable, and immune to a re-tripping resume.
 *  - an authored bar exists AND the signature names one of its frozen paths: there is something
 *    concrete to accuse, and the accusation is attributable.
 *  - the tree is populated: the evidence ("a real implementation exists and this still reds").
 */
function suspectsContractFault(ctx: LoopCtx, stuck: StuckReason): boolean {
  if (stuck.kind !== 'repeat') return false;
  if (ctx.adjudicated) return false;
  if (ctx.contract.generatedFiles.length === 0) return false;
  if (!treePopulated(ctx)) return false;
  return matchedGeneratedFiles(ctx).length > 0;
}

/** The most recent normalized verifier-failure signature (empty when there is no failure history). */
export function lastSignature(ctx: LoopCtx): string {
  return ctx.verifierDetailHistory[ctx.verifierDetailHistory.length - 1] ?? '';
}

/**
 * The frozen `generatedFiles` paths the repeated signature points at — by full path OR by basename,
 * since runners frequently print only the file name. Exported so the ABORTED reason can name the
 * same files the gate matched on. Pure string work over data the reducer already holds; per
 * invariant #8 this deliberately does NOT live in `detectStuck`, which stays purely history-driven.
 */
export function matchedGeneratedFiles(ctx: LoopCtx): readonly string[] {
  const signature = lastSignature(ctx);
  if (signature.length === 0) return [];
  return ctx.contract.generatedFiles
    .map((f) => f.path)
    .filter((path) => signature.includes(path) || signature.includes(basename(path)));
}

/** Last path segment (a pure, separator-only split — no `node:path` in the reducer). */
function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? path;
}

/**
 * The pure, replayable proxy for "the tree is non-trivially populated": the worker changed the tree
 * at least once during this run, so ≥2 DISTINCT post-run hashes were recorded. APPROXIMATION, by
 * necessity — the reducer cannot look at the tree (invariant #1) and a real emptiness probe would be
 * IO. It errs conservative in the safe direction: a worker that never edited anything falls through
 * to today's abort, so the feature can only fire when there is genuinely an implementation to weigh.
 */
function treePopulated(ctx: LoopCtx): boolean {
  return new Set(ctx.diffHashHistory).size >= 2;
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
