import type { Command, OrchestratorEvent } from '../domain/events';
import type { Logger } from '../log/logger';

/**
 * Translate a performed Event into leveled diagnostics. Content that may carry repo text or
 * secrets (prompts, harness output, verifier detail, the diff) is kept at `debug` only — `info`
 * stays content-free (statuses, counts, hashes, decisions).
 */
export function logEvent(
  log: Logger,
  command: Command,
  event: OrchestratorEvent,
  iteration?: number,
): void {
  // The per-iteration beats carry the turn number so a run's log reads as a sequence, not a
  // stream of identical lines; the one-time beats (compile, seal, prepare) have no iteration.
  const it = iteration !== undefined ? { iteration } : {};
  switch (event.tag) {
    case 'PLAN_COMPILED':
      // Log the frozen plan LOUDLY so the decomposition is auditable (the plan-level analogue of the
      // CONTRACT_COMPILED audit line). Phase goals may carry repo text — keep them at debug.
      log.info('plan compiled', {
        planHash: event.plan.planHash,
        phases: event.plan.phases.length,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
      });
      log.debug('plan phases', { goals: event.plan.phases.map((p) => p.goal) });
      return;
    case 'PLAN_FAILED':
      log.error('plan failed', { reason: event.reason });
      return;
    case 'PLAN_SEAL_DECIDED':
      log.info('plan seal decided', { decision: event.decision.kind });
      return;
    case 'PHASE_ADVANCED':
      log.info('phase advanced (checkpoint taken)', { tree: event.tree });
      return;
    case 'CONTRACT_COMPILED':
      log.info('contract compiled', {
        contractHash: event.contract.contractHash,
        rungs: event.contract.rungs.length,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
      });
      return;
    case 'COMPILE_FAILED':
      log.error('compile failed', { reason: event.reason });
      return;
    case 'SEAL_DECIDED':
      log.info('seal decided', { decision: event.decision.kind });
      return;
    case 'WORKSPACE_PREPARED':
      log.info('workspace prepared', {
        status: event.prepared.status,
        setupRan: event.setupRan,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
      });
      // The detail of a fail-closed outcome may carry repo text / tool output — keep it at debug.
      if (event.prepared.status !== 'proceed') {
        log.debug('prepare detail', { detail: event.prepared.detail });
      }
      return;
    case 'AGENT_RAN':
      log.info('agent ran', {
        ...it,
        status: event.run.status,
        changed: event.prevDiffHash !== event.diffHash,
        ...(event.budget.tokensSpent !== undefined ? { tokensSpent: event.budget.tokensSpent } : {}),
        ...(event.budget.tokensEstimated !== undefined
          ? { tokensEstimated: event.budget.tokensEstimated }
          : {}),
        ...(event.budget.tokensUnknown === true ? { tokensUnknown: true } : {}),
        budgetExceeded: event.budget.exceeded,
      });
      if (command.tag === 'RUN_AGENT') {
        // Prompt CONTENT stays out of logs; its size is a safe diagnostic signal.
        log.debug('agent prompt', { promptChars: command.prompt.length });
      }
      return;
    case 'VERIFIED':
      log.info('verified', {
        ...it,
        pass: event.verdict.pass,
        confidence: event.verdict.confidence,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
      });
      log.debug('verdict detail', { detail: event.verdict.detail });
      return;
    case 'CONTRACT_ADJUDICATED':
      // Issue #116: the one-shot in-loop re-adjudication of the FROZEN bar. The boolean verdict is
      // content-free, so it is `info`; the reason may quote repo text, so it stays at `debug` like
      // every other content-bearing field.
      log.info('contract adjudicated', {
        ...it,
        defective: event.defective,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
      });
      log.debug('adjudication reason', { reason: event.reason });
      return;
    case 'SIGNOFF_DECIDED':
      log.info('sign-off decided', {
        ...it,
        veto: event.approval.veto,
        ...(event.llm !== undefined ? { llmTokens: event.llm.tokens } : {}),
        ...(event.approval.reason !== undefined ? { reason: event.approval.reason } : {}),
      });
      return;
  }
}
