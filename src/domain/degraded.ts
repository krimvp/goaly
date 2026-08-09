import { z } from 'zod';

/**
 * Typed DEGRADED-MODE label for a run (issue #125).
 *
 * Invariant #3 ("two keys for DONE") is satisfied *mechanically* whenever the frozen ladder and the
 * Sign-off approver both run — but it is defeated *statistically* when both keys are drawn from the
 * same model with the same priors, on a bar that same model authored. goaly already warns about that
 * at startup; a warning addressed to an absent operator (`--autonomous` exists so nobody is watching)
 * is a record, not a control. So the collapse is ALSO recorded here: a typed value written once into
 * the run-log header and surfaced wherever the run is reported (terminal summary, `goaly runs show`,
 * the UI's header feed), so a DONE from a self-judged run is *labelled* as such and a downstream
 * consumer can treat it with the appropriate suspicion.
 *
 * This is a LABEL, never a gate: it never weakens (or strengthens) the two keys, never enters the
 * frozen contract, and never reaches the reducer. It is compose-time wiring, like `harness`.
 */

/**
 * The degraded modes goaly can label.
 *
 * `independence-unverified` is deliberately a SEPARATE kind from `self-judged`, not a softer wording
 * of it: the two describe different epistemic states. `self-judged` is a collapse goaly OBSERVED (it
 * compared two known model ids and they matched). `independence-unverified` is a collapse goaly
 * CANNOT RULE OUT — the Sign-off approver was left on the LLM provider's own default model, whose id
 * goaly has no way to resolve, so "different from the agent's model" is unproven. Reporting the
 * second as the first would overclaim; reporting it as independent would underclaim, which is the
 * failure this kind exists to prevent.
 *
 * `self-approved` is the third distinct state: the Sign-off approver OBSERVABLY runs the model that
 * wrote the code, while the judge rung runs a different one. Only ONE of the two keys is affected,
 * so it is not `self-judged` — but the key it affects is the one whose whole job is to be a skeptic
 * about the agent's own work, so it is not "independent" either. It used to produce NO label at all
 * (any independent pair suppressed the whole thing), which is exactly the silent degradation this
 * type exists to prevent: the second key WAS the model that wrote the code, and nothing in the run
 * header, the summary or `goaly runs show` said so.
 */
export const DEGRADED_MODE_KINDS = ['self-judged', 'self-approved', 'independence-unverified'] as const;

export const DegradedMode = z.object({
  /**
   * `self-judged`: the coding agent, the LLM judge rung and the Sign-off approver all resolved to the
   * SAME KNOWN model. `self-approved`: the approver resolved to the CODING AGENT's model while the
   * judge rung resolved to a different one. `independence-unverified`: they may have collapsed — the
   * approver runs on the provider's own default and goaly cannot tell whether that default is the
   * agent's model.
   */
  kind: z.enum(DEGRADED_MODE_KINDS),
  /**
   * For `self-judged`: the one model every role resolved to; ABSENT ⇒ the tool's own default model.
   * For `self-approved`: the model the coding agent and the Sign-off approver share.
   * For `independence-unverified`: the model the coding agent and the judge rung share — the model
   * the approver's unresolvable default MIGHT also be.
   */
  model: z.string().min(1).optional(),
  /** The success bar was LLM-AUTHORED (`--generate`) rather than a user-supplied `--verify-cmd`. */
  generate: z.boolean(),
  /** Seal was auto-accepted (`--autonomous`) — no human reviewed the frozen bar. */
  autonomous: z.boolean(),
});
export type DegradedMode = z.infer<typeof DegradedMode>;

/**
 * How bad each kind is, for reconciling two labels. Observed beats unproven, and more collapsed
 * roles beat fewer: `independence-unverified` is a collapse that could not be ruled out;
 * `self-approved` is an OBSERVED collapse of the second key onto the model that wrote the code;
 * `self-judged` is that plus the judge rung, i.e. every role on one model. All are worse than no
 * label.
 */
const SEVERITY: Record<DegradedMode['kind'], number> = {
  'independence-unverified': 1,
  'self-approved': 2,
  'self-judged': 3,
};

/**
 * The label a run as a WHOLE has earned, given the label it started with and the one the current
 * invocation resolves to. The header is written once at run start, but the models a run uses are
 * re-resolved from EVERY invocation's flags — so `--resume` with different (or absent) model flags
 * silently changes which keys run. Taking the more severe of the two keeps the record honest in
 * both directions: a resume that collapses the keys further upgrades the label, and a resume that
 * repairs the wiring does NOT erase the iterations that already ran degraded.
 *
 * Pure and total; ties keep the EXISTING label so a no-op resume never rewrites the header.
 */
export function mostDegraded(
  recorded: DegradedMode | undefined,
  current: DegradedMode | undefined,
): DegradedMode | undefined {
  if (recorded === undefined) return current;
  if (current === undefined) return recorded;
  return SEVERITY[current.kind] > SEVERITY[recorded.kind] ? current : recorded;
}

/** Structural equality of two labels (absent included) — what decides whether a resume must warn. */
export function sameDegradedMode(
  a: DegradedMode | undefined,
  b: DegradedMode | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.kind === b.kind &&
    a.model === b.model &&
    a.generate === b.generate &&
    a.autonomous === b.autonomous
  );
}

/** Short, stable tag for a degraded mode (the headline in one-line reports). */
export function degradedModeTag(d: DegradedMode): string {
  switch (d.kind) {
    case 'self-judged':
      return 'SELF-JUDGED';
    case 'self-approved':
      return 'SELF-APPROVED';
    case 'independence-unverified':
      return 'INDEPENDENCE-UNVERIFIED';
  }
}

/**
 * The human-facing explanation printed under the tag: what collapsed, why the reader should care,
 * and the exact flag that fixes it. Pure string building so both the terminal summary and
 * `goaly runs show` render the identical label.
 */
export function degradedModeDetail(d: DegradedMode): string {
  const shape = [d.generate ? '--generate' : undefined, d.autonomous ? '--autonomous' : undefined]
    .filter((s): s is string => s !== undefined)
    .join(' ');
  const suffix = shape.length > 0 ? ` (${shape})` : '';
  const remedy =
    'Pass --approver-model <other-model> (or --approver-models) for an independent second key.';
  if (d.kind === 'self-approved') {
    return (
      `the Sign-off approver — the SECOND KEY for DONE — ran the same model as the coding agent ` +
      `that wrote the code (${d.model ?? 'one model (the tool default)'})${suffix}; only the LLM ` +
      'judge rung ran a different one. The skeptic and the author are one distribution, so the ' +
      `second key adds little independent evidence. ${remedy}`
    );
  }
  if (d.kind === 'independence-unverified') {
    return (
      `the coding agent and the LLM judge rung ran on ${d.model ?? 'one model'}${suffix}, and the ` +
      "Sign-off approver ran on the LLM provider's OWN DEFAULT model, whose id goaly cannot resolve " +
      '— so it could not confirm the second key is a different model. Independence is UNVERIFIED, ' +
      `not established: if that default is ${d.model ?? 'the same model'}, both keys share one ` +
      `distribution. ${remedy}`
    );
  }
  return (
    `the coding agent, the LLM judge rung and the Sign-off approver all ran on ` +
    `${d.model ?? 'one model (the tool default)'}${suffix} — ` +
    'the two keys are not independent, so treat this run with the corresponding suspicion. ' +
    `${remedy}`
  );
}
