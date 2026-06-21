import type { ApprovalVerdict } from '../domain/verdict';
import type { ApprovalInput } from '../domain/events';

/**
 * Seam #3 — Gate B. Verdict-shaped but a separate seam: veto-only, fed INDEPENDENT inputs
 * (goal + frozen rubric + diff + verdicts), never the worker's self-justification. Defaults
 * to reject on uncertainty — a false green ends the run wrongly; a false red costs one
 * iteration. DONE requires two keys: the frozen verifier passes AND this does not veto.
 */
export interface Approver {
  review(input: ApprovalInput): Promise<ApprovalVerdict>;
}
