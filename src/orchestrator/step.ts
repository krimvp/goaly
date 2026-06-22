import type { OrchestratorEvent, Command, HarnessRunResult } from '../domain/events';
import type { RunConfig } from '../domain/config';
import type { CompiledContract, Rung } from '../domain/contract';
import type { Plan } from '../domain/plan';
import { phaseConfig, isAcceptancePhase } from '../domain/plan';
import type { OrchestratorState, LoopCtx, PlanProgress } from './state';
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

/**
 * Seed the machine. A phased run (issue #48) starts at PLANNING + a single PLAN command; the classic
 * single-contract run starts at COMPILING + a single COMPILE_VERIFIER command.
 */
export function initial(config: RunConfig): StepResult {
  if (config.phased) {
    return [
      { tag: 'PLANNING', config, reviseRound: 0 },
      [{ tag: 'PLAN', config }],
    ];
  }
  return [
    { tag: 'COMPILING', config, reviseRound: 0, plan: undefined },
    [{ tag: 'COMPILE_VERIFIER', config }],
  ];
}

export function step(state: OrchestratorState, event: OrchestratorEvent): StepResult {
  switch (state.tag) {
    case 'PLANNING':
      return stepPlanning(state.config, state.reviseRound, event);
    case 'AWAIT_PLAN_GATE':
      return stepAwaitPlanGate(state.config, state.plan, state.reviseRound, event);
    case 'CHECKPOINTING':
      return stepCheckpointing(state.progress, event);
    case 'COMPILING':
      return stepCompiling(state.config, state.reviseRound, state.plan, event);
    case 'AWAIT_GATE_A':
      return stepAwaitGateA(state.config, state.contract, state.reviseRound, state.plan, event);
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

// ---- phased: PLAN → plan gate → (phases) → ACCEPT ------------------------

function stepPlanning(config: RunConfig, reviseRound: number, event: OrchestratorEvent): StepResult {
  switch (event.tag) {
    case 'PLAN_COMPILED':
      return [
        { tag: 'AWAIT_PLAN_GATE', config, plan: event.plan, reviseRound },
        [{ tag: 'REQUEST_PLAN_GATE', plan: event.plan }],
      ];
    case 'PLAN_FAILED':
      // Fail-closed (invariant #4): an unparseable / over-long plan is a typed FAILED, never a skip.
      return [{ tag: 'FAILED', reason: event.reason, iterations: 0, contractHash: undefined }, []];
    default:
      throw invalidTransition('PLANNING', event);
  }
}

function stepAwaitPlanGate(
  config: RunConfig,
  plan: Plan,
  reviseRound: number,
  event: OrchestratorEvent,
): StepResult {
  if (event.tag !== 'PLAN_GATE_DECIDED') throw invalidTransition('AWAIT_PLAN_GATE', event);

  switch (event.decision.kind) {
    case 'approve':
      // Freeze stands. Start phase 0 — derive its scoped config and compile its own contract.
      return startPhase(
        { baseConfig: config, plan, phaseIndex: 0, priorIterations: 0 },
      );
    case 'reject':
      return [
        { tag: 'ABORTED', reason: event.decision.reason, iterations: 0, contractHash: undefined },
        [],
      ];
    case 'revise': {
      // Bounded, gated re-plan — never an automatic "make it easier" (mirrors Gate A revise). The
      // reducer only emits a re-plan command carrying the human's feedback; the Driver re-plans.
      if (reviseRound + 1 > config.maxGateARevisions) {
        return [
          {
            tag: 'ABORTED',
            reason: `plan revision cap (${config.maxGateARevisions}) reached without approval`,
            iterations: 0,
            contractHash: undefined,
          },
          [],
        ];
      }
      return [
        { tag: 'PLANNING', config, reviseRound: reviseRound + 1 },
        [{ tag: 'PLAN', config, feedback: event.decision.feedback }],
      ];
    }
  }
}

function stepCheckpointing(progress: PlanProgress, event: OrchestratorEvent): StepResult {
  if (event.tag !== 'PHASE_CHECKPOINTED') throw invalidTransition('CHECKPOINTING', event);
  // The checkpoint advanced the diff baseline; move to the next phase (which may be acceptance).
  return startPhase({ ...progress, phaseIndex: progress.phaseIndex + 1 });
}

/** Begin a phase: derive its scoped config from the frozen plan and compile its own contract. */
function startPhase(progress: PlanProgress): StepResult {
  const cfg = phaseConfig(progress.baseConfig, progress.plan, progress.phaseIndex);
  return [
    { tag: 'COMPILING', config: cfg, reviseRound: 0, plan: progress },
    [{ tag: 'COMPILE_VERIFIER', config: cfg }],
  ];
}

// ---- per-phase loop (reused unchanged for the single-contract run) --------

function stepCompiling(
  config: RunConfig,
  reviseRound: number,
  plan: PlanProgress | undefined,
  event: OrchestratorEvent,
): StepResult {
  switch (event.tag) {
    case 'CONTRACT_COMPILED':
      return [
        { tag: 'AWAIT_GATE_A', config, contract: event.contract, reviseRound, plan },
        [{ tag: 'REQUEST_GATE_A', contract: event.contract }],
      ];
    case 'COMPILE_FAILED':
      // A phase whose contract won't even compile fails the whole run (no silent skip).
      return [
        {
          tag: 'FAILED',
          reason: withPhase(plan, event.reason),
          iterations: plan?.priorIterations ?? 0,
          contractHash: undefined,
        },
        [],
      ];
    default:
      throw invalidTransition('COMPILING', event);
  }
}

function stepAwaitGateA(
  config: RunConfig,
  contract: CompiledContract,
  reviseRound: number,
  plan: PlanProgress | undefined,
  event: OrchestratorEvent,
): StepResult {
  if (event.tag !== 'GATE_A_DECIDED') throw invalidTransition('AWAIT_GATE_A', event);

  switch (event.decision.kind) {
    case 'approve': {
      const ctx = initialCtx(config, contract, plan);
      return startIteration(ctx, buildInitialPrompt(contract), undefined);
    }
    case 'reject':
      return [
        {
          tag: 'ABORTED',
          reason: withPhase(plan, event.decision.reason),
          iterations: plan?.priorIterations ?? 0,
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
            iterations: plan?.priorIterations ?? 0,
            contractHash: contract.contractHash,
          },
          [],
        ];
      }
      return [
        { tag: 'COMPILING', config, reviseRound: reviseRound + 1, plan },
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
  // Whole-run iteration count: in a phased run, sum the completed phases' iterations.
  const iterations = (ctx.plan?.priorIterations ?? 0) + ctx.iteration;
  switch (decision.kind) {
    case 'CONTINUE': {
      const next: LoopCtx = { ...ctx, feedback: decision.feedback };
      const prompt = buildLoopPrompt(ctx.contract, decision.feedback, ctx.lastRunStatus);
      return startIteration(next, prompt, ctx.sessionId);
    }
    case 'DONE':
      return phaseDone(ctx, iterations);
    case 'FAILED':
      return [
        {
          tag: 'FAILED',
          reason: withPhase(ctx.plan, decision.reason),
          iterations,
          contractHash: ctx.contract.contractHash,
        },
        [],
      ];
    case 'ABORTED':
      return [
        {
          tag: 'ABORTED',
          reason: withPhase(ctx.plan, decision.reason),
          iterations,
          contractHash: ctx.contract.contractHash,
        },
        [],
      ];
  }
}

/**
 * A phase satisfied both keys. For the classic single-contract run (`plan === undefined`) and for the
 * FINAL cumulative acceptance phase, this is whole-run DONE. For any earlier phase, the run is NOT
 * done: take a checkpoint (#47) to scope the next phase's diff, then advance. This is the heart of
 * invariant #3 under decomposition — the whole run is DONE only when the cumulative acceptance
 * contract passes both keys, so phases passing individually can't green a goal whose whole fails.
 */
function phaseDone(ctx: LoopCtx, iterations: number): StepResult {
  const progress = ctx.plan;
  if (progress === undefined || isAcceptancePhase(progress.plan, progress.phaseIndex)) {
    return [{ tag: 'DONE', iterations, contractHash: ctx.contract.contractHash }, []];
  }
  return [
    { tag: 'CHECKPOINTING', progress: { ...progress, priorIterations: iterations } },
    [{ tag: 'CHECKPOINT_PHASE' }],
  ];
}

/** A short, human-readable label for the current phase (for terminal reasons). */
function phaseLabel(progress: PlanProgress): string {
  return isAcceptancePhase(progress.plan, progress.phaseIndex)
    ? 'cumulative acceptance phase'
    : `phase ${progress.phaseIndex + 1}/${progress.plan.phases.length}`;
}

/** Prefix a terminal reason with the failing phase when in a phased run; pass through otherwise. */
function withPhase(plan: PlanProgress | undefined, reason: string): string {
  return plan === undefined ? reason : `${phaseLabel(plan)}: ${reason}`;
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
