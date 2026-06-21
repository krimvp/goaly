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
});
export type Verdict = z.infer<typeof Verdict>;

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
 * Gate B verdict. Veto-only: the approver can stop a green from becoming DONE, but
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

/** Gate A decision over the freshly compiled (and about-to-be-frozen) contract. */
export const GateDecision = z.object({
  approved: z.boolean(),
  reason: z.string().optional(),
});
export type GateDecision = z.infer<typeof GateDecision>;
