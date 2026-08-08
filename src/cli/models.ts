import { z } from 'zod';
import type { LlmProviderChoice } from './flags/harness-flags';

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
  /** Model for the adversarial critics/refuters (`--adversarial`); follows the LLM-step cascade. */
  criticModel: z.string().trim().min(1).optional(),
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
  /** One shared model for the adversarial critics/refuters; follows the same LLM-step cascade. */
  critic: string | undefined;
  /** Model for the `--explain` observer (issue #8); follows the same LLM-step cascade. */
  explain: string | undefined;
  /**
   * Issue #125: set when the Sign-off approver DECLINED to inherit the agent's `--model` and was
   * defaulted to the LLM provider's own model instead, so the second key is distinct from the model
   * that wrote the code. Carries the agent model it declined, for the loud log. Absent ⇒ the
   * ordinary cascade ran (nothing to announce).
   */
  approverIndependentFrom?: string;
};

/**
 * LLM providers that have NO default model of their own — omitting the model there is a fail-closed
 * config error (`makeLlmProvider`), not "the tool's own default". The approver-independence default
 * below is therefore skipped for them: it must never turn a working wiring into a refused run.
 */
const PROVIDERS_WITHOUT_DEFAULT_MODEL: readonly LlmProviderChoice[] = ['openai'];

/**
 * Whether the environment permits an approver model DISTINCT from the agent's (issue #125): only
 * when a global `--model` names the agent's model AND the LLM provider has a default model of its
 * own to fall back to. `--llm-model` and `--approver-model(s)` are deliberate statements about the
 * review roles and are always obeyed.
 */
function canIndependentApprover(sel: ModelSelection, provider: LlmProviderChoice | undefined): boolean {
  if (sel.model === undefined) return false; // only one model is in play — nothing to be distinct from
  if (sel.approverModel !== undefined || sel.approverModels !== undefined) return false;
  if (sel.llmModel !== undefined) return false;
  if (provider === undefined) return false;
  return !PROVIDERS_WITHOUT_DEFAULT_MODEL.includes(provider);
}

/**
 * Apply the cascade. For each LLM step the precedence is
 * `per-step flag → --llm-model → --model → tool default`; the harness only follows `--model`. The
 * model is an execution/wiring concern — it never enters the frozen contract.
 *
 * ONE deliberate exception (issue #125): the Sign-off approver does not inherit a bare `--model`.
 * `--model X` picks the CODING AGENT's model, and letting the second key inherit it collapses the
 * agent, the judge rung and the approver onto one distribution — invariant #3 satisfied
 * mechanically while defeated statistically. So when `opts.llmProvider` has a default model of its
 * own, the approver falls back to THAT (a distinct, always-available model) and the swap is recorded
 * in {@link ResolvedModels.approverIndependentFrom} for a loud log. Best-effort by construction:
 * goaly compares the models it was ASKED for, and cannot resolve a CLI's own default model id — a
 * `--model` that happens to name that same default is not detectable. `--approver-model` (or
 * `--approver-models`) always wins, and passing the agent's model there restores the old inheriting
 * behavior explicitly. Callers that omit `opts` keep the pure cascade.
 */
export function resolveModels(
  sel: ModelSelection,
  opts: { llmProvider?: LlmProviderChoice } = {},
): ResolvedModels {
  const llm = sel.llmModel ?? sel.model;
  const independent = canIndependentApprover(sel, opts.llmProvider);
  return {
    harness: sel.model,
    compiler: sel.compilerModel ?? llm,
    judge: sel.judgeModel ?? llm,
    approver: sel.approverModel ?? (independent ? undefined : llm),
    // The per-reviewer list is an explicit override, never cascaded from --model/--llm-model.
    approverModels: sel.approverModels,
    planner: sel.plannerModel ?? llm,
    critic: sel.criticModel ?? llm,
    explain: sel.explainModel ?? llm,
    ...(independent && sel.model !== undefined ? { approverIndependentFrom: sel.model } : {}),
  };
}
