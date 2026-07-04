import { z } from 'zod';

/**
 * One adversarial-review finding against a pre-Seal artifact (a phase plan or a compiled
 * contract). `critical` findings trigger a bounded re-author round; `minor` ones ride along as
 * context but never trigger one on their own. `lens` names the review perspective that produced
 * the finding; `fix` is concrete revision guidance for the re-author.
 */
export const CritiqueFinding = z.object({
  severity: z.enum(['critical', 'minor']),
  lens: z.string().min(1).optional(),
  /** What is wrong — the concrete gaming vector / flaw the critic found. */
  claim: z.string().min(1),
  /** Concrete revision guidance for the next authoring attempt. */
  fix: z.string().min(1).optional(),
});
export type CritiqueFinding = z.infer<typeof CritiqueFinding>;

/**
 * Structured output forced from one adversarial critic. `.refine` enforces coherence the same way
 * {@link JudgeOutput} does: a `revise` verdict must carry at least one finding — the schema, not
 * the prompt, guarantees a critic can't demand a revision without saying why.
 */
export const CritiqueOutput = z
  .object({
    verdict: z.enum(['pass', 'revise']),
    findings: z.array(CritiqueFinding).default([]),
  })
  .refine((o) => o.verdict === 'pass' || o.findings.length > 0, {
    message: 'a revise verdict must carry at least one finding',
    path: ['findings'],
  });
export type CritiqueOutput = z.infer<typeof CritiqueOutput>;

/**
 * One refuter's vote on a green verifier ladder (the verify-time adversarial rung). Mirrors
 * {@link ApprovalVerdict}'s shape discipline: a refutation must say what it found. Fail-closed at
 * the consumer — an unparseable/thrown refuter COUNTS AS refuted (green→red, never red→green).
 */
export const RefuterVote = z
  .object({
    refuted: z.boolean(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1).optional(),
  })
  .refine((v) => !v.refuted || (v.reason !== undefined && v.reason.length > 0), {
    message: 'a refutation must carry a non-empty reason',
    path: ['reason'],
  });
export type RefuterVote = z.infer<typeof RefuterVote>;

/** The critical findings across a whole critic panel, deduped by claim (stable order). */
export function criticalFindings(outputs: readonly CritiqueOutput[]): CritiqueFinding[] {
  const seen = new Set<string>();
  const out: CritiqueFinding[] = [];
  for (const finding of outputs.flatMap((o) => o.findings)) {
    if (finding.severity !== 'critical' || seen.has(finding.claim)) continue;
    seen.add(finding.claim);
    out.push(finding);
  }
  return out;
}

/**
 * Render a panel's critical findings as the free-text `feedback` string both authoring seams
 * (`Planner.plan` / `VerifierCompiler.compile`) already accept from a Seal "revise" round.
 * Deterministic: same findings ⇒ same string, so a replayed authoring attempt sees identical input.
 */
export function renderCritiqueFeedback(findings: readonly CritiqueFinding[]): string {
  const lines = findings.map((f, i) => {
    const lens = f.lens !== undefined ? `[${f.lens}] ` : '';
    const fix = f.fix !== undefined ? ` Fix: ${f.fix}` : '';
    return `${i + 1}. ${lens}${f.claim}${fix}`;
  });
  const noun = findings.length === 1 ? 'issue' : 'issues';
  return [
    `Adversarial review found ${findings.length} critical ${noun} with the previous attempt:`,
    ...lines,
  ].join('\n');
}
