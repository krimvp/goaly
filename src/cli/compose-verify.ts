import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { Verifier } from '../verify/verifier';
import type { LlmProvider } from '../llm/provider';
import { Ladder } from '../verify/ladder';
import { AdversarialReviewRung } from '../verify/adversarial-rung';
import { DeterministicVerifier } from '../verify/deterministic';
import { GeneratedFilesGuard } from '../verify/generated-guard';
import { JudgeVerifier } from '../verify/judge';
import { AgentApprover } from '../verify/agent-approver';
import type { StreamPhase } from '../agent-cli/stream';
import type { ResolvedModels } from './models';

/**
 * The VERIFICATION-side wiring: the frozen contract's rungs → a runnable Ladder (first key), and
 * the Sign-off approver (second key). Extracted from `compose.ts` so the composition root stays
 * about wiring seams together, not about which concrete verifier backs each rung.
 */

/**
 * Turn the frozen contract's ordered rungs into a Ladder of concrete verifiers. An optional
 * `verifyTimeoutMs` caps each deterministic command — including an artifact-running smoke command
 * (issue #53), which is just another deterministic rung (a timeout is a fail-closed FAIL); the model
 * and timeout are wiring and never alter the frozen rungs themselves.
 *
 * `adversarial` (the `--adversarial` refuter panel) APPENDS a built-in {@link AdversarialReviewRung}
 * after every frozen rung — the same non-contract-rung precedent as the guard below: part of the
 * ladder, never part of `contractHash`. The ladder's short-circuit means it runs only on an
 * all-green frozen bar (so its LLM spend occurs only on candidate greens — under `--candidates > 1`
 * that is per green candidate, deliberately: its red feeds the graded selection) and it can only
 * FAIL that green, never promote a red.
 */
export function buildLadder(
  contract: CompiledContract,
  llm: LlmProvider,
  verifyTimeoutMs?: number,
  adversarial?: { llm: LlmProvider; refuters: number },
): Verifier {
  const rungs: Verifier[] = contract.rungs.map((rung) =>
    rung.kind === 'deterministic'
      ? new DeterministicVerifier(rung.command, rung.label, verifyTimeoutMs)
      : new JudgeVerifier({
          rubric: rung.rubric,
          quorum: rung.quorum,
          confidenceFloor: rung.confidenceFloor,
          llm,
        }),
  );
  // Pin compiler-authored verification files: a guard runs FIRST and fails closed if
  // any frozen generated file was modified/removed, so the worker can't rewrite the bar the frozen
  // command measures. No generated files ⇒ no guard (the common --verify-cmd path is unchanged).
  if (contract.generatedFiles.length > 0) {
    rungs.unshift(new GeneratedFilesGuard(contract.generatedFiles));
  }
  if (adversarial !== undefined && adversarial.refuters > 0) {
    rungs.push(new AdversarialReviewRung({ llm: adversarial.llm, refuters: adversarial.refuters }));
  }
  return new Ladder(rungs);
}

/**
 * Build the Sign-off approver (second key). With `--approver-models m1,m2,…` (follow-up to issue #84)
 * the panel gains REAL per-reviewer model independence: one `'approve'`-metered provider per model
 * (every panel call still attributes to the approver layer — no new spend category), passed as the
 * approver's `reviewers`. When the user did NOT pin `--approver-quorum`, the quorum defaults to the
 * model count (`AgentApprover` applies that default from the reviewers list). The single `llm` stays
 * the back-compat fallback. Absent ⇒ the single-model approver, byte-for-byte unchanged.
 *
 * `--approver-lenses` (issue #84 OQ4) replaces the cycled default lens taxonomy with an
 * operator-supplied one (forwarded only when set); absent ⇒ the AgentApprover's DEFAULT_LENSES.
 */
export function buildApprover(
  config: RunConfig,
  models: ResolvedModels,
  llmFor: (model: string | undefined, phase: StreamPhase) => LlmProvider,
): AgentApprover {
  const reviewers = (models.approverModels ?? []).map((m) => llmFor(m, 'approve'));
  // Only forward an explicit `--approver-quorum`. When a model list is given and the user left the
  // quorum at its default 1, the approver defaults the quorum to the model count instead.
  const quorumExplicit = reviewers.length === 0 || config.approver.quorum > 1;
  return new AgentApprover({
    llm: llmFor(models.approver, 'approve'),
    diversityTemperature: config.approver.diversityTemperature,
    ...(reviewers.length > 0 ? { reviewers } : {}),
    ...(quorumExplicit ? { quorum: config.approver.quorum } : {}),
    // Operator-supplied review lenses (issue #84 OQ4): forward when set so they replace the default
    // taxonomy the AgentApprover cycles; absent ⇒ the approver uses DEFAULT_LENSES as today.
    ...(config.approver.lenses !== undefined ? { lenses: config.approver.lenses } : {}),
  });
}
