import { z } from 'zod';

/**
 * Raw model-selection flags (all optional). `model` is the global default (harness + every LLM
 * step); `llmModel` overrides all LLM steps as a group; the per-step keys override a single step.
 * Validated at the CLI seam — non-empty after trimming, so a stray `--model ''` fails closed.
 */
export const ModelSelection = z.object({
  model: z.string().trim().min(1).optional(),
  llmModel: z.string().trim().min(1).optional(),
  judgeModel: z.string().trim().min(1).optional(),
  approverModel: z.string().trim().min(1).optional(),
  /**
   * Per-reviewer Sign-off models (follow-up to issue #84): a LIST of models, one `'approve'`-metered
   * provider per entry, cycled across the panel for REAL perspective independence. Each entry is
   * trimmed + non-empty (fail-closed). When set it supersedes the single {@link approverModel} for
   * the panel; absent ⇒ the single-model path. NOT part of the cascade — it is an explicit override.
   */
  approverModels: z.array(z.string().trim().min(1)).nonempty().optional(),
  compilerModel: z.string().trim().min(1).optional(),
  plannerModel: z.string().trim().min(1).optional(),
  /** Model for the optional `--explain` observer (issue #8); follows the same LLM-step cascade. */
  explainModel: z.string().trim().min(1).optional(),
});
export type ModelSelection = z.infer<typeof ModelSelection>;
export type ModelSelectionInput = z.input<typeof ModelSelection>;

/** Concrete model per seam after the cascade (undefined = that tool's own default). */
export type ResolvedModels = {
  harness: string | undefined;
  compiler: string | undefined;
  judge: string | undefined;
  approver: string | undefined;
  /**
   * Per-reviewer Sign-off models (follow-up to issue #84). When set (≥1 entry), compose builds one
   * `'approve'`-metered provider per model and passes them as the approver panel's `reviewers`;
   * `--approver-quorum`, when unset, defaults to this list's length. Absent ⇒ the single-model
   * approver. NOT cascaded — an explicit `--approver-models` override only.
   */
  approverModels: string[] | undefined;
  /** Model for the planner step (issue #48); follows the same LLM-step cascade. */
  planner: string | undefined;
  /** Model for the `--explain` observer (issue #8); follows the same LLM-step cascade. */
  explain: string | undefined;
};

/**
 * Apply the cascade. For each LLM step the precedence is
 * `per-step flag → --llm-model → --model → tool default`; the harness only follows `--model`. The
 * model is an execution/wiring concern — it never enters the frozen contract.
 */
export function resolveModels(sel: ModelSelection): ResolvedModels {
  const llm = sel.llmModel ?? sel.model;
  return {
    harness: sel.model,
    compiler: sel.compilerModel ?? llm,
    judge: sel.judgeModel ?? llm,
    approver: sel.approverModel ?? llm,
    // The per-reviewer list is an explicit override, never cascaded from --model/--llm-model.
    approverModels: sel.approverModels,
    planner: sel.plannerModel ?? llm,
    explain: sel.explainModel ?? llm,
  };
}
