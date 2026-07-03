import { z } from 'zod';

/**
 * The unified verdict shape. The state machine cannot tell whether a `Verdict` came
 * from an exit code, a test run, or an LLM quorum — that is the whole point of the
 * Verifier unification (ARCHITECTURE "The Verifier unification").
 */
export const Verdict = z.object({
  pass: z.boolean(),
  /** 1 for deterministic checks; (0,1) for fuzzy/judge checks. */
  confidence: z.number().min(0).max(1),
  /** Human/agent-readable explanation, fed back as next-iteration prompt on failure. */
  detail: z.string(),
  /**
   * How far up a frozen {@link Ladder} this verdict got (best-of-N graded ranking, issue #85):
   * the number of rungs that PASSED before the short-circuit (all of them on a green). Optional so
   * every non-ladder producer/consumer is unaffected (a bare deterministic/judge verdict omits it).
   * Populated only by `Ladder.verify`; the tournament ranks candidates by it (deeper beats shallower)
   * at ZERO extra execution cost — it is just the position where the short-circuit stopped.
   */
  rungsPassed: z.number().int().min(0).optional(),
  /** The frozen ladder's total rung count (the denominator for {@link rungsPassed}). */
  rungsTotal: z.number().int().min(0).optional(),
  /**
   * `false` marks a COULD-NOT-EVALUATE verdict — the bar was never actually tested to a real
   * pass/fail. The verification could not be RUN: the verify command itself failed to execute (a
   * missing tool / exit 127, a network or package-manager error, a timeout/kill), or the LLM judge
   * errored, returned no parseable verdict, or overflowed its context. This is STILL fail-closed —
   * an unevaluable verdict always carries `pass: false` and is NEVER a green — it only adds the
   * signal that the failure is a verification-ENVIRONMENT failure, not evidence the worker's code is
   * wrong. The orchestrator uses it to surface an honest `CONTRACT_UNEVALUABLE` terminal instead of
   * mistaking a checker that can't run for "your code is broken" (a misleading no-diff/repeat abort
   * that would discard a possibly-correct tree). Optional and defaults to evaluable: omit it for a
   * normal pass/fail, so every existing producer/consumer is unaffected.
   */
  evaluable: z.boolean().optional(),
});
export type Verdict = z.infer<typeof Verdict>;

/**
 * True when a verdict is a could-not-evaluate result (see {@link Verdict.evaluable}): the bar was
 * not actually tested, as opposed to evaluated-and-failed. An omitted `evaluable` means evaluable
 * (the normal pass/fail case), so only an explicit `false` counts. A passing verdict is never
 * unevaluable.
 */
export function isUnevaluable(verdict: Verdict): boolean {
  return verdict.evaluable === false && !verdict.pass;
}

/**
 * Structured output forced from a single LLM judge sample (temperature 0).
 * `.refine` enforces consistency: failing criteria is empty iff the sample passed —
 * the schema, not the prompt, guarantees a coherent verdict.
 */
export const JudgeOutput = z
  .object({
    pass: z.boolean(),
    confidence: z.number().min(0).max(1),
    failing_criteria: z.array(z.string()),
  })
  .refine((o) => (o.failing_criteria.length === 0) === o.pass, {
    message: 'failing_criteria must be empty iff pass is true',
    path: ['failing_criteria'],
  });
export type JudgeOutput = z.infer<typeof JudgeOutput>;

/**
 * Sign-off verdict. Veto-only: the approver can stop a green from becoming DONE, but
 * can never promote a red. `reason` is required exactly when vetoing (feedback for
 * the next iteration). Fail-closed: an unparseable approver response becomes a veto.
 */
export const ApprovalVerdict = z
  .object({
    veto: z.boolean(),
    reason: z.string().optional(),
  })
  .refine((v) => !v.veto || (v.reason !== undefined && v.reason.length > 0), {
    message: 'a veto must carry a non-empty reason',
    path: ['reason'],
  });
export type ApprovalVerdict = z.infer<typeof ApprovalVerdict>;

/**
 * Operator edits to the contract's operator-editable FIELDS at the Seal review station
 * (ADR 0016). Deliberately has NO `goal` field — a goal change re-scopes the run and goes through
 * the LLM `revise` path, so the goal is unrepresentable here by construction (the same trick that
 * keeps the frozen contract unreachable through `RUN_EXTENDED`). Every field is optional: an
 * absent field keeps the compiled value.
 */
export const SealEditPatch = z
  .object({
    /** Replace the one-time setup command; `null` clears it; absent keeps it. */
    setup: z.union([z.string().min(1), z.null()]).optional(),
    /** Replace the overall rubric (may be empty, matching `CompiledContract.rubric`). */
    rubric: z.string().optional(),
    /**
     * Replace deterministic rung commands by index into `contract.rungs`. An index that is out of
     * range or points at a judge rung fails the refreeze closed (never a silent partial apply).
     */
    commands: z
      .array(z.object({ index: z.number().int().min(0), command: z.string().min(1) }).strict())
      .optional(),
  })
  .strict();
export type SealEditPatch = z.infer<typeof SealEditPatch>;

/**
 * Seal decision over the freshly compiled (and about-to-be-frozen) contract. Four
 * mutually exclusive outcomes:
 *  - `approve`: the freeze stands and the loop starts.
 *  - `reject`: abort the run (the loop never starts).
 *  - `revise`: re-author the contract with the human's free-text feedback, then re-present
 *    at Seal. This is *pre-approval* renegotiation only — the contract that finally enters
 *    the loop is still frozen and never rewritten mid-loop (invariant #2). Each revise round
 *    produces its own logged `contractHash`; only the approved one is ever verified against.
 *  - `edited`: the operator changed artifacts MANUALLY (authored verification files on disk,
 *    and/or contract fields via `patch`) — re-read the files, re-pin their hashes, apply the
 *    patch, re-freeze a NEW contract (new `contractHash`, logged), and re-present at Seal
 *    (ADR 0016). Costs no LLM tokens and does not consume the `maxSealRevisions` cap; still
 *    strictly pre-approval, so the freeze semantics are identical to `revise`.
 */
export const SealDecision = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approve') }),
  z.object({ kind: z.literal('reject'), reason: z.string().min(1) }),
  z.object({ kind: z.literal('revise'), feedback: z.string().min(1) }),
  z.object({ kind: z.literal('edited'), patch: SealEditPatch.optional() }),
]);
export type SealDecision = z.infer<typeof SealDecision>;
