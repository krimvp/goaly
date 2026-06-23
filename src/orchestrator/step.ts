import type { OrchestratorEvent, Command, HarnessRunResult } from '../domain/events';
import type { RunConfig } from '../domain/config';
import type { CompiledContract, Rung } from '../domain/contract';
import type { OrchestratorState, LoopCtx } from './state';
import { initialCtx } from './state';
import { decide, type Decision } from './decide';
import { normalizeDetail } from './stuck';

/**
 * The pure reducer — the product's intelligence. `step(state, event) -> [state, Command[]]`
 * is synchronous, holds no adapters, and returns no Promise: it *cannot* call an LLM, read
 * a clock, or spawn a process. All fuzziness already happened in the Driver before the Event
 * was built. This is "zero LLM in control flow" as a type-level guarantee, not a discipline.
 */
export type StepResult = readonly [OrchestratorState, Command[]];

/** Seed the machine: COMPILING + a single COMPILE_VERIFIER command. */
export function initial(config: RunConfig): StepResult {
  return [
    { tag: 'COMPILING', config, reviseRound: 0, compileRound: 0 },
    [{ tag: 'COMPILE_VERIFIER', config }],
  ];
}

export function step(state: OrchestratorState, event: OrchestratorEvent): StepResult {
  switch (state.tag) {
    case 'COMPILING':
      return stepCompiling(state.config, state.reviseRound, state.compileRound, event);
    case 'AWAIT_GATE_A':
      return stepAwaitGateA(state.config, state.contract, state.reviseRound, event);
    case 'RUNNING_AGENT':
      return stepRunningAgent(state.ctx, event);
    case 'VERIFYING':
      return stepVerifying(state.ctx, event);
    case 'AWAIT_GATE_B':
      return stepAwaitGateB(state.ctx, event);
    case 'DONE':
    case 'FAILED':
    case 'ABORTED':
      throw new Error(`step() called on terminal state ${state.tag}`);
  }
}

function stepCompiling(
  config: RunConfig,
  reviseRound: number,
  compileRound: number,
  event: OrchestratorEvent,
): StepResult {
  switch (event.tag) {
    case 'CONTRACT_COMPILED':
      return [
        { tag: 'AWAIT_GATE_A', config, contract: event.contract, reviseRound },
        [{ tag: 'REQUEST_GATE_A', contract: event.contract }],
      ];
    case 'COMPILE_FAILED': {
      // Bounded compile-retry-with-feedback (issue #51): a correctable authoring mistake (bad path,
      // transient parse miss) shouldn't discard a valid plan. Re-author with the error as guidance,
      // up to maxCompileRetries, before failing. The reducer stays pure — it only emits a
      // feedback-carrying re-compile command; the Driver performs the recompile. Exhausting the
      // budget is still a typed FAILED (fail-closed), never a skipped check.
      if (compileRound < config.maxCompileRetries) {
        return [
          { tag: 'COMPILING', config, reviseRound, compileRound: compileRound + 1 },
          [{ tag: 'COMPILE_VERIFIER', config, feedback: compileRetryFeedback(event.reason) }],
        ];
      }
      return [
        { tag: 'FAILED', reason: event.reason, iterations: 0, contractHash: undefined },
        [],
      ];
    }
    default:
      throw invalidTransition('COMPILING', event);
  }
}

/** Turn a COMPILE_FAILED reason into actionable re-authoring guidance for the next compile attempt. */
function compileRetryFeedback(reason: string): string {
  return (
    `The previous attempt to author the verification failed: ${reason}. ` +
    "Author verification that runs over the repo's existing tooling, and write any helper files " +
    'inside the workspace using relative paths only.'
  );
}

function stepAwaitGateA(
  config: RunConfig,
  contract: CompiledContract,
  reviseRound: number,
  event: OrchestratorEvent,
): StepResult {
  if (event.tag !== 'GATE_A_DECIDED') throw invalidTransition('AWAIT_GATE_A', event);

  switch (event.decision.kind) {
    case 'approve': {
      const ctx = initialCtx(config, contract);
      return startIteration(ctx, buildInitialPrompt(contract), undefined);
    }
    case 'reject':
      return [
        {
          tag: 'ABORTED',
          reason: event.decision.reason,
          iterations: 0,
          contractHash: contract.contractHash,
        },
        [],
      ];
    case 'revise': {
      // Pre-approval renegotiation: bounded by maxGateARevisions so the loop always terminates.
      // The reducer stays pure — it only emits a re-compile command carrying the human's
      // feedback; the Driver performs the recompile and a fresh CONTRACT_COMPILED returns here.
      if (reviseRound + 1 > config.maxGateARevisions) {
        return [
          {
            tag: 'ABORTED',
            reason: `Gate A revision cap (${config.maxGateARevisions}) reached without approval`,
            iterations: 0,
            contractHash: contract.contractHash,
          },
          [],
        ];
      }
      // A fresh human-driven authoring round resets the compile-retry counter (issue #51): the
      // per-attempt error budget is independent of the pre-approval revise budget.
      return [
        { tag: 'COMPILING', config, reviseRound: reviseRound + 1, compileRound: 0 },
        [{ tag: 'COMPILE_VERIFIER', config, feedback: event.decision.feedback }],
      ];
    }
  }
}

function stepRunningAgent(ctx: LoopCtx, event: OrchestratorEvent): StepResult {
  if (event.tag !== 'AGENT_RAN') throw invalidTransition('RUNNING_AGENT', event);

  const next: LoopCtx = {
    ...ctx,
    iteration: ctx.iteration + 1,
    sessionId: event.run.sessionId,
    diffHashHistory: [...ctx.diffHashHistory, event.diffHash],
    lastNoDiff: event.prevDiffHash === event.diffHash,
    lastRunStatus: event.run.status,
    lastBudget: event.budget,
  };
  return [{ tag: 'VERIFYING', ctx: next }, [{ tag: 'RUN_VERIFIER', contract: next.contract }]];
}

function stepVerifying(ctx: LoopCtx, event: OrchestratorEvent): StepResult {
  if (event.tag !== 'VERIFIED') throw invalidTransition('VERIFYING', event);
  const verdict = event.verdict;

  if (verdict.pass) {
    // A passing ladder breaks any failure streak — clear the history so an interleaved green
    // (e.g. pass→veto→fail) can't be mistaken for "N identical failures in a row".
    const next: LoopCtx = { ...ctx, lastVerdict: verdict, verifierDetailHistory: [] };
    return [
      { tag: 'AWAIT_GATE_B', ctx: next },
      [
        {
          tag: 'REQUEST_GATE_B',
          goal: next.contract.goal,
          rubric: next.contract.rubric,
          verdicts: [verdict],
        },
      ],
    ];
  }

  // Failed ladder: record the normalized failure, then DECIDE (Gate B never runs).
  const next: LoopCtx = {
    ...ctx,
    lastVerdict: verdict,
    verifierDetailHistory: [...ctx.verifierDetailHistory, normalizeDetail(verdict.detail)],
  };
  return applyDecision(next, decide(next, verdict, null));
}

function stepAwaitGateB(ctx: LoopCtx, event: OrchestratorEvent): StepResult {
  if (event.tag !== 'GATE_B_DECIDED') throw invalidTransition('AWAIT_GATE_B', event);
  const verdict = ctx.lastVerdict;
  if (verdict === undefined) {
    throw new Error('AWAIT_GATE_B reached without a ladder verdict (corrupt state)');
  }
  return applyDecision(ctx, decide(ctx, verdict, event.approval));
}

/** Turn a pure Decision into the next state + commands. */
function applyDecision(ctx: LoopCtx, decision: Decision): StepResult {
  switch (decision.kind) {
    case 'CONTINUE': {
      const next: LoopCtx = { ...ctx, feedback: decision.feedback };
      const prompt = buildLoopPrompt(ctx.contract, decision.feedback, ctx.lastRunStatus);
      return startIteration(next, prompt, ctx.sessionId);
    }
    case 'DONE':
      return [
        { tag: 'DONE', iterations: ctx.iteration, contractHash: ctx.contract.contractHash },
        [],
      ];
    case 'FAILED':
      return [
        {
          tag: 'FAILED',
          reason: decision.reason,
          iterations: ctx.iteration,
          contractHash: ctx.contract.contractHash,
        },
        [],
      ];
    case 'ABORTED':
      return [
        {
          tag: 'ABORTED',
          reason: decision.reason,
          iterations: ctx.iteration,
          contractHash: ctx.contract.contractHash,
        },
        [],
      ];
  }
}

function startIteration(
  ctx: LoopCtx,
  prompt: string,
  sessionId: LoopCtx['sessionId'],
): StepResult {
  return [{ tag: 'RUNNING_AGENT', ctx }, [{ tag: 'RUN_AGENT', prompt, sessionId }]];
}

// ---- pure prompt builders -------------------------------------------------

function describeRungs(rungs: readonly Rung[]): string {
  return rungs
    .map((r, i) =>
      r.kind === 'deterministic'
        ? `${i + 1}. Run \`${r.command}\` — it must exit 0.`
        : `${i + 1}. Judged against the frozen rubric: ${r.rubric}`,
    )
    .join('\n');
}

function buildInitialPrompt(contract: CompiledContract): string {
  return [
    '# Goal',
    contract.goal,
    '',
    '# Frozen success contract (you cannot modify it)',
    'Your work is accepted only when ALL of the following pass:',
    describeRungs(contract.rungs),
    contract.rubric ? `\nOverall rubric:\n${contract.rubric}` : '',
    '',
    'Make the changes needed to satisfy the contract. Do not weaken or rewrite the checks themselves.',
  ].join('\n');
}

function buildLoopPrompt(
  contract: CompiledContract,
  feedback: string,
  runStatus?: HarnessRunResult['status'],
): string {
  const statusNote =
    runStatus !== undefined && runStatus !== 'completed'
      ? `Note: your previous run ended as '${runStatus}' (it did not finish cleanly) — pick up where it left off.\n\n`
      : '';
  return [
    '# Goal',
    contract.goal,
    '',
    '# The contract is not yet satisfied',
    `${statusNote}Feedback from verification:`,
    feedback,
    '',
    'Continue working toward the goal. Do not modify the success contract or its tests.',
  ].join('\n');
}

function invalidTransition(stateTag: string, event: OrchestratorEvent): Error {
  return new Error(`invalid transition: event ${event.tag} in state ${stateTag}`);
}
