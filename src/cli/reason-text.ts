import {
  COMPILE_FAILED_MARKER,
  DRIVER_ERROR_MARKER,
  PLAN_FAILED_MARKER,
  QUOTED_TEXT_LEAD_INS,
} from '../orchestrator/reason-quote';
import { CONTRACT_SOUND_MARKER } from '../orchestrator/stuck';

/**
 * Separating goaly's OWN words in an abort reason from the text it merely QUOTES.
 *
 * A terminal reason often carries external evidence so the failure is diagnosable: the repeated
 * verifier-failure signature, an adjudicator's prose, the harness's last stderr, a setup command's
 * output. All of that is WORKER-REACHABLE — a test name or an assertion message becomes part of the
 * reason — so anything that makes a DECISION from the reason (today: the CLI's next-step hint) must
 * read only the part goaly authored. Otherwise a test called `handles no-diff` can pick the hint,
 * and the operator is pointed at a flag that cannot continue their run.
 *
 * The reducer holds up its half of the bargain (see `src/orchestrator/reason-quote.ts`, whose rules
 * `src/orchestrator/reason-boundary.test.ts` enforces over every builder): every quote starts at one
 * of a handful of fixed lead-ins, and every typed marker is emitted BEFORE the first quote. So the
 * goaly-authored part is simply the prefix that ends at the earliest lead-in — a boundary the worker
 * cannot move, because moving it earlier only removes ITS OWN text from view.
 *
 * The Driver holds up its half too: its own terminal `ABORTED` reasons are built by the same module
 * (`bootstrapFailedReason` / `driverErrorReason`), so a caught exception's text — reachable with
 * worker-influenced content, since the last-resort catch wraps the `--phased` between-phase
 * checkpoint — is quoted rather than claimed.
 *
 * Scope, honestly: the prefix is goaly's own words plus values frozen before the loop began (the
 * contract's authored paths, a phased run's sealed sub-goal title). Exactly ONE reason is still
 * passed through whole with no lead-in — a human's Seal/plan-Seal rejection — so for that one the
 * "prefix" is the entire reason: a human's words, not goaly's, and not the worker's. The
 * `COMPILE_FAILED`/`PLAN_FAILED` authoring messages used to be in that bucket, described as pre-loop
 * text the worker never touches; that was untrue under `--phased` (phase N+1 is compiled after phase
 * N's worker turns), so they now carry a lead-in of their own.
 */
export function goalyAuthoredReason(reason: string): string {
  let cut = reason.length;
  for (const leadIn of QUOTED_TEXT_LEAD_INS) {
    const at = reason.indexOf(leadIn);
    if (at >= 0 && at < cut) cut = at;
  }
  return reason.slice(0, cut);
}

/** How the adjudicated-SOUND marker was framed in reasons written before it moved ahead of the quote. */
const LEGACY_SOUND_MARKER = `[${CONTRACT_SOUND_MARKER}]`;

/**
 * The text the next-step hint table is matched against: {@link goalyAuthoredReason}, plus ONE
 * back-compat rescue.
 *
 * Reasons written before the ordering rule existed put the `CONTRACT_ADJUDICATED_SOUND` marker
 * AFTER the quoted failure signature, so the trusted prefix of such a log no longer contains it and
 * the run would get the repeat-failure hint — the dead-end `--stuck-repeat-threshold` advice that
 * marker exists to prevent. When the trusted prefix has no marker of its own, the bracketed legacy
 * marker is therefore still honored from the full reason.
 *
 * That rescue is the one place worker-authored text can still influence the hint, and the claim
 * here is deliberately narrow: a signature that reproduces goaly's bracketed marker verbatim can
 * select the SOUND hint on an ordinary repeat-failure abort. That hint names no threshold and no
 * destructive action — it says "keep the tree and carry the goal forward with --from-run", which is
 * valid advice for a repeat-failure abort too — so the worst case is a milder hint, not a dead end.
 *
 * It is narrowed further by {@link OWN_MARKERS}: the rescue exists for legacy repeat-failure
 * reasons, so a reason whose trusted prefix already carries a DIFFERENT typed marker of its own is
 * never rescued. That keeps the marker-carrying reasons (driver aborts, authoring failures) out of
 * the one path where quoted text has a say at all.
 */
const OWN_MARKERS: readonly string[] = [
  DRIVER_ERROR_MARKER,
  COMPILE_FAILED_MARKER,
  PLAN_FAILED_MARKER,
];

export function hintSubject(reason: string): string {
  const owned = goalyAuthoredReason(reason);
  if (owned.length === reason.length) return owned; // nothing was quoted: the whole reason is ours
  if (owned.includes(CONTRACT_SOUND_MARKER)) return owned;
  if (OWN_MARKERS.some((marker) => owned.includes(marker))) return owned;
  return reason.includes(LEGACY_SOUND_MARKER) ? `${CONTRACT_SOUND_MARKER} ${owned}` : owned;
}
