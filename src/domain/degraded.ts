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

/** The degraded modes goaly can label. A union of one today; new kinds are added here. */
export const DEGRADED_MODE_KINDS = ['self-judged'] as const;

export const DegradedMode = z.object({
  /** `self-judged`: the coding agent, the LLM judge rung and the Sign-off approver share one model. */
  kind: z.enum(DEGRADED_MODE_KINDS),
  /** The one model every role resolved to; ABSENT ⇒ the tool's own default model. */
  model: z.string().min(1).optional(),
  /** The success bar was LLM-AUTHORED (`--generate`) rather than a user-supplied `--verify-cmd`. */
  generate: z.boolean(),
  /** Seal was auto-accepted (`--autonomous`) — no human reviewed the frozen bar. */
  autonomous: z.boolean(),
});
export type DegradedMode = z.infer<typeof DegradedMode>;

/** Short, stable tag for a degraded mode (the headline in one-line reports). */
export function degradedModeTag(d: DegradedMode): string {
  return d.kind === 'self-judged' ? 'SELF-JUDGED' : d.kind;
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
  return (
    `the coding agent, the LLM judge rung and the Sign-off approver all ran on ` +
    `${d.model ?? 'one model (the tool default)'}${shape.length > 0 ? ` (${shape})` : ''} — ` +
    'the two keys are not independent, so treat this run with the corresponding suspicion. ' +
    'Pass --approver-model <other-model> (or --approver-models) for an independent second key.'
  );
}
