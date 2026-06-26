import type { OrchestratorEvent, Command, HarnessRunResult } from '../domain/events';
import type { RunConfig, VerifierIntent } from '../domain/config';
import type { CompiledContract, Rung } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';
import type { OrchestratorState, LoopCtx, PhaseCtx } from './state';
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
 * Seed the machine. A classic run starts at COMPILING; a phased run (issue #48) starts at PLANNING so
 * the goal is decomposed into a frozen plan BEFORE any contract is compiled. Exactly one command either
 * way (driver invariant).
 */
export function initial(config: RunConfig): StepResult {
  if (config.phased) {
    return [
      { tag: 'PLANNING', config, reviseRound: 0 },
      [{ tag: 'COMPILE_PLAN', config }],
    ];
  }
  return [
    { tag: 'COMPILING', config, reviseRound: 0, compileRound: 0 },
    [{ tag: 'COMPILE_VERIFIER', config }],
  ];
}

export function step(state: OrchestratorState, event: OrchestratorEvent): StepResult {
  switch (state.tag) {
    case 'PLANNING':
      return stepPlanning(state.config, state.reviseRound, event);
    case 'AWAIT_PLAN_SEAL':
      return stepAwaitPlanSeal(state.config, state.plan, state.reviseRound, event);
    case 'ADVANCING_PHASE':
      return stepAdvancingPhase(state.phase, event);
    case 'COMPILING':
      return stepCompiling(state.config, state.reviseRound, state.compileRound, state.phase, event);
    case 'AWAIT_SEAL':
      return stepAwaitSeal(state.config, state.contract, state.reviseRound, state.phase, event);
    case 'PREPARING':
      return stepPreparing(state.config, state.contract, state.phase, event);
    case 'RUNNING_AGENT':
      return stepRunningAgent(state.ctx, event);
    case 'VERIFYING':
      return stepVerifying(state.ctx, event);
    case 'AWAIT_SIGNOFF':
      return stepAwaitSignoff(state.ctx, event);
    case 'DONE':
    case 'FAILED':
    case 'ABORTED':
      throw new Error(`step() called on terminal state ${state.tag}`);
  }
}

// ---- phased: PLAN → plan Seal → phase loop → ACCEPT (issue #48) ------------

/**
 * PLAN — author the frozen plan. A `PLAN_COMPILED` advances to the plan Seal; a `PLAN_FAILED` is a
 * typed, fail-closed terminal FAILED (a planner error / unparseable / over-long plan is never a
 * skipped check). Re-planning is the bounded, gated revise path at the plan Seal, not an auto-retry.
 */
function stepPlanning(config: RunConfig, reviseRound: number, event: OrchestratorEvent): StepResult {
  switch (event.tag) {
    case 'PLAN_COMPILED':
      return [
        { tag: 'AWAIT_PLAN_SEAL', config, plan: event.plan, reviseRound },
        [{ tag: 'REQUEST_PLAN_SEAL', plan: event.plan }],
      ];
    case 'PLAN_FAILED':
      return [{ tag: 'FAILED', reason: event.reason, iterations: 0, contractHash: undefined }, []];
    default:
      throw invalidTransition('PLANNING', event);
  }
}

/**
 * Plan Seal. `--autonomous` moves only the PAUSE, not the freeze (invariant #5);
 * the gate still froze + logged the plan upstream.
 *  - approve → start phase 0: compile its contract (a normal frozen-contract run scoped to the sub-goal).
 *  - reject  → ABORTED (the loop never starts).
 *  - revise  → re-plan with the human's feedback, bounded by `maxPlanRevisions` (mirrors Seal revise).
 */
function stepAwaitPlanSeal(
  config: RunConfig,
  plan: PhasePlan,
  reviseRound: number,
  event: OrchestratorEvent,
): StepResult {
  if (event.tag !== 'PLAN_SEAL_DECIDED') throw invalidTransition('AWAIT_PLAN_SEAL', event);
  switch (event.decision.kind) {
    case 'approve': {
      const phase: PhaseCtx = { baseConfig: config, plan, index: 0 };
      return startPhaseCompile(phase);
    }
    case 'reject':
      return [
        { tag: 'ABORTED', reason: event.decision.reason, iterations: 0, contractHash: undefined },
        [],
      ];
    case 'revise': {
      if (reviseRound + 1 > config.maxPlanRevisions) {
        return [
          {
            tag: 'ABORTED',
            reason: `plan Seal revision cap (${config.maxPlanRevisions}) reached without approval`,
            iterations: 0,
            contractHash: undefined,
          },
          [],
        ];
      }
      return [
        { tag: 'PLANNING', config, reviseRound: reviseRound + 1 },
        [{ tag: 'COMPILE_PLAN', config, feedback: event.decision.feedback }],
      ];
    }
  }
}

/**
 * Between phases: the Driver checkpointed (issue #47) and returns the tree; advance to the next phase
 * and compile its contract. The next phase may be a sub-goal or, when the sub-goals are exhausted, the
 * final cumulative ACCEPTANCE phase (`index === plan.phases.length`) — `phaseConfigFor` derives either.
 */
function stepAdvancingPhase(phase: PhaseCtx, event: OrchestratorEvent): StepResult {
  if (event.tag !== 'PHASE_ADVANCED') throw invalidTransition('ADVANCING_PHASE', event);
  const next: PhaseCtx = { ...phase, index: phase.index + 1 };
  return startPhaseCompile(next);
}

/** Begin a phase: COMPILING its derived config, carrying the phase position for the eventual advance. */
function startPhaseCompile(phase: PhaseCtx): StepResult {
  const config = phaseConfigFor(phase);
  return [
    { tag: 'COMPILING', config, reviseRound: 0, compileRound: 0, phase },
    [{ tag: 'COMPILE_VERIFIER', config }],
  ];
}

/**
 * Derive the RunConfig for a phase from the frozen plan + the original config. A sub-goal phase
 * (`index < phases.length`) inherits the operational knobs (iterations, budget, stuck policy,
 * autonomy, judge quorum, …) but takes its goal/intent/rubric from the sub-goal and always authors
 * its own verification (`--generate`). The acceptance phase (`index === phases.length`) IS the
 * original goal + the user's original verifier intent (so `--verify-cmd "npm test"` becomes the
 * cumulative deterministic bar, or `--generate` authors cumulative acceptance on the original goal).
 * Pure and total; `phased` is cleared so the inner run is a normal single-contract run.
 */
function phaseConfigFor(phase: PhaseCtx): RunConfig {
  const base = phase.baseConfig;
  if (phase.index >= phase.plan.phases.length) {
    return { ...base, phased: false };
  }
  const sub = phase.plan.phases[phase.index]!;
  const verifier: VerifierIntent = {
    kind: 'generate',
    ...(sub.intent !== undefined ? { intent: sub.intent } : {}),
  };
  return {
    goal: sub.goal,
    verifier,
    noSetup: base.noSetup,
    installMissingTools: base.installMissingTools,
    autonomous: base.autonomous,
    maxSealRevisions: base.maxSealRevisions,
    maxCompileRetries: base.maxCompileRetries,
    maxIterations: base.maxIterations,
    phased: false,
    maxPhases: base.maxPhases,
    maxPlanRevisions: base.maxPlanRevisions,
    budget: base.budget,
    stuckPolicy: base.stuckPolicy,
    diffIgnore: base.diffIgnore,
    // Delta-verify is driven by the OUTER run config in the Driver loop (it reads `config.deltaVerify`
    // for the whole run, not per-phase); this inner phase contract just inherits the value for honest
    // round-tripping. Within a phase it advances only the judge's baseline; the approver baseline
    // advances at phase boundaries — so it composes with phasing (issue #49).
    deltaVerify: base.deltaVerify,
    judge: base.judge,
    ...(sub.rubric !== undefined ? { rubric: sub.rubric } : {}),
  };
}

function stepCompiling(
  config: RunConfig,
  reviseRound: number,
  compileRound: number,
  phase: PhaseCtx | undefined,
  event: OrchestratorEvent,
): StepResult {
  switch (event.tag) {
    case 'CONTRACT_COMPILED':
      return [
        {
          tag: 'AWAIT_SEAL',
          config,
          contract: event.contract,
          reviseRound,
          ...(phase !== undefined ? { phase } : {}),
        },
        [{ tag: 'REQUEST_SEAL', contract: event.contract }],
      ];
    case 'COMPILE_FAILED': {
      // Bounded compile-retry-with-feedback (issue #51): a correctable authoring mistake (bad path,
      // transient parse miss) shouldn't discard a valid plan. Re-author with the error as guidance,
      // up to maxCompileRetries, before failing. The reducer stays pure — it only emits a
      // feedback-carrying re-compile command; the Driver performs the recompile. Exhausting the
      // budget is still a typed FAILED (fail-closed), never a skipped check.
      if (compileRound < config.maxCompileRetries) {
        return [
          {
            tag: 'COMPILING',
            config,
            reviseRound,
            compileRound: compileRound + 1,
            ...(phase !== undefined ? { phase } : {}),
          },
          [{ tag: 'COMPILE_VERIFIER', config, feedback: compileRetryFeedback(event.reason) }],
        ];
      }
      // In a phased run a phase's compile failure fails the WHOLE run (no silent skip), named by phase.
      return [
        { tag: 'FAILED', reason: phaseReason(phase, event.reason), iterations: 0, contractHash: undefined },
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

function stepAwaitSeal(
  config: RunConfig,
  contract: CompiledContract,
  reviseRound: number,
  phase: PhaseCtx | undefined,
  event: OrchestratorEvent,
): StepResult {
  if (event.tag !== 'SEAL_DECIDED') throw invalidTransition('AWAIT_SEAL', event);

  switch (event.decision.kind) {
    case 'approve': {
      // One-time prepare phase (Fix #1 setup + Fix #2 pre-flight) — only when there is something to
      // prepare/check (a setup command, or authored verification files that could be unsound). The
      // common `--verify-cmd` contract has neither, so it goes straight to iteration 1 unchanged.
      if (needsPreparation(contract)) {
        return [
          { tag: 'PREPARING', config, contract, ...(phase !== undefined ? { phase } : {}) },
          [{ tag: 'PREPARE_WORKSPACE', contract, installMissingTools: config.installMissingTools }],
        ];
      }
      const ctx = initialCtx(config, contract, phase);
      return startIteration(ctx, buildInitialPrompt(contract), undefined);
    }
    case 'reject':
      return [
        {
          tag: 'ABORTED',
          reason: phaseReason(phase, event.decision.reason),
          iterations: 0,
          contractHash: contract.contractHash,
        },
        [],
      ];
    case 'revise': {
      // Pre-approval renegotiation: bounded by maxSealRevisions so the loop always terminates.
      // The reducer stays pure — it only emits a re-compile command carrying the human's
      // feedback; the Driver performs the recompile and a fresh CONTRACT_COMPILED returns here.
      if (reviseRound + 1 > config.maxSealRevisions) {
        return [
          {
            tag: 'ABORTED',
            reason: phaseReason(
              phase,
              `Seal revision cap (${config.maxSealRevisions}) reached without approval`,
            ),
            iterations: 0,
            contractHash: contract.contractHash,
          },
          [],
        ];
      }
      // A fresh human-driven authoring round resets the compile-retry counter (issue #51): the
      // per-attempt error budget is independent of the pre-approval revise budget.
      return [
        {
          tag: 'COMPILING',
          config,
          reviseRound: reviseRound + 1,
          compileRound: 0,
          ...(phase !== undefined ? { phase } : {}),
        },
        [{ tag: 'COMPILE_VERIFIER', config, feedback: event.decision.feedback }],
      ];
    }
  }
}

/**
 * Does this frozen contract need the one-time prepare phase? Yes when it carries a setup command to
 * run (Fix #1), authored verification files to pre-flight (Fix #2), or a required-tools manifest to
 * probe before the loop. A plain `--verify-cmd` contract over only shell builtins has none, so
 * preparation is skipped and the loop starts exactly as before — no new event for the common path.
 */
function needsPreparation(contract: CompiledContract): boolean {
  return (
    contract.setup !== undefined ||
    contract.generatedFiles.length > 0 ||
    contract.requiredTools.length > 0
  );
}

/**
 * The prepare phase resolved (Fix #1 / #2). The Driver already ran setup once and pre-flighted the
 * deterministic rungs; the reducer only routes the typed outcome:
 *  - `proceed`          → start iteration 1 (setup was clean / absent; pre-flight passed or failed as
 *                         an honest red — the implementation is simply missing, which the loop fixes).
 *  - `setup-failed`     → FAILED (typed SETUP_FAILED) — never hand the worker a broken environment.
 *  - `contract-unsound` → FAILED (typed CONTRACT_UNSOUND) — the frozen verification can't even run, so
 *                         no worker tokens are spent chasing a contract defect.
 */
function stepPreparing(
  config: RunConfig,
  contract: CompiledContract,
  phase: PhaseCtx | undefined,
  event: OrchestratorEvent,
): StepResult {
  if (event.tag !== 'WORKSPACE_PREPARED') throw invalidTransition('PREPARING', event);
  const prepared = event.prepared;
  switch (prepared.status) {
    case 'proceed': {
      const ctx = initialCtx(config, contract, phase);
      return startIteration(ctx, buildInitialPrompt(contract, prepared.installTools), undefined);
    }
    case 'tools-missing':
      return [
        {
          tag: 'FAILED',
          reason: phaseReason(
            phase,
            `TOOLS_MISSING: a tool the verification needs is not installed before any agent turn — ${prepared.detail}`,
          ),
          iterations: 0,
          contractHash: contract.contractHash,
        },
        [],
      ];
    case 'setup-failed':
      return [
        {
          tag: 'FAILED',
          reason: phaseReason(
            phase,
            `SETUP_FAILED: the workspace setup command failed before any agent turn — ${prepared.detail}`,
          ),
          iterations: 0,
          contractHash: contract.contractHash,
        },
        [],
      ];
    case 'contract-unsound':
      return [
        {
          tag: 'FAILED',
          reason: phaseReason(
            phase,
            'CONTRACT_UNSOUND: the frozen verification could not run against the prepared tree ' +
              `(the error originates in the authored verification, not the implementation) — ${prepared.detail}`,
          ),
          iterations: 0,
          contractHash: contract.contractHash,
        },
        [],
      ];
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
    runStatusHistory: [...ctx.runStatusHistory, event.run.status],
    lastRunOutput: event.run.output,
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
      { tag: 'AWAIT_SIGNOFF', ctx: next },
      [
        {
          tag: 'REQUEST_SIGNOFF',
          goal: next.contract.goal,
          rubric: next.contract.rubric,
          verdicts: [verdict],
        },
      ],
    ];
  }

  // Failed ladder: record the normalized failure, then DECIDE (Sign-off never runs).
  const next: LoopCtx = {
    ...ctx,
    lastVerdict: verdict,
    verifierDetailHistory: [...ctx.verifierDetailHistory, normalizeDetail(verdict.detail)],
  };
  return applyDecision(next, decide(next, verdict, null));
}

function stepAwaitSignoff(ctx: LoopCtx, event: OrchestratorEvent): StepResult {
  if (event.tag !== 'SIGNOFF_DECIDED') throw invalidTransition('AWAIT_SIGNOFF', event);
  const verdict = ctx.lastVerdict;
  if (verdict === undefined) {
    throw new Error('AWAIT_SIGNOFF reached without a ladder verdict (corrupt state)');
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
      return phaseDone(ctx);
    case 'FAILED':
      // A phase's failure fails the WHOLE run (decomposition can't skip a phase), named by phase.
      return [
        {
          tag: 'FAILED',
          reason: phaseReason(ctx.phase, decision.reason),
          iterations: ctx.iteration,
          contractHash: ctx.contract.contractHash,
        },
        [],
      ];
    case 'ABORTED':
      return [
        {
          tag: 'ABORTED',
          reason: phaseReason(ctx.phase, decision.reason),
          iterations: ctx.iteration,
          contractHash: ctx.contract.contractHash,
        },
        [],
      ];
  }
}

/**
 * A phase reached BOTH keys (issue #48). On a classic run this is the whole-run DONE. On a phased run:
 *  - a sub-goal or earlier phase (`index < phases.length`) → ADVANCE: checkpoint (#47) then compile the
 *    next phase. The whole run is NOT yet done — the cumulative acceptance still has to pass.
 *  - the final acceptance phase (`index === phases.length`) → whole-run DONE (both keys on the ORIGINAL
 *    goal). This is what stops decomposition greening a goal whose parts pass but whole doesn't.
 */
function phaseDone(ctx: LoopCtx): StepResult {
  const phase = ctx.phase;
  if (phase !== undefined && phase.index < phase.plan.phases.length) {
    return [
      { tag: 'ADVANCING_PHASE', phase, lastIteration: ctx.iteration },
      [{ tag: 'CHECKPOINT_AND_ADVANCE' }],
    ];
  }
  return [{ tag: 'DONE', iterations: ctx.iteration, contractHash: ctx.contract.contractHash }, []];
}

/**
 * Prefix a terminal reason with the phase position so a phased run's failures point at WHICH phase
 * (1-based, with the goal). The acceptance phase is named explicitly. A classic run (no phase) is
 * returned unchanged, so existing reasons/tests are byte-for-byte the same.
 */
function phaseReason(phase: PhaseCtx | undefined, reason: string): string {
  if (phase === undefined) return reason;
  const total = phase.plan.phases.length;
  if (phase.index >= total) return `acceptance phase (cumulative contract): ${reason}`;
  const sub = phase.plan.phases[phase.index];
  const goal = sub !== undefined ? ` (${sub.goal})` : '';
  return `phase ${phase.index + 1}/${total}${goal}: ${reason}`;
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

function buildInitialPrompt(contract: CompiledContract, installTools?: readonly string[]): string {
  return [
    '# Goal',
    contract.goal,
    '',
    buildBootstrapSection(contract, installTools),
    '# Frozen success contract (you cannot modify it)',
    'Your work is accepted only when ALL of the following pass:',
    describeRungs(contract.rungs),
    contract.rubric ? `\nOverall rubric:\n${contract.rubric}` : '',
    '',
    'Make the changes needed to satisfy the contract. Do not weaken or rewrite the checks themselves.',
  ].join('\n');
}

/**
 * The bootstrap instruction prepended to the first prompt when required tools are missing and goaly is
 * delegating their install to the agent (the default `--install-missing-tools` path). goaly skipped its
 * own one-time setup (it would only fail on the absent toolchain), so the agent must install the tools
 * AND run the project setup itself before the verification can pass. Empty when nothing is missing.
 */
function buildBootstrapSection(
  contract: CompiledContract,
  installTools?: readonly string[],
): string {
  if (installTools === undefined || installTools.length === 0) return '';
  const setupNote =
    contract.setup !== undefined
      ? ` Then run the project's one-time setup: \`${contract.setup}\`.`
      : '';
  return [
    '# Bootstrap required first',
    `The verification needs these tools, which are NOT installed on PATH: ${installTools.join(', ')}.`,
    `Install them first (you have shell access; use the standard installer and make sure each ends up on PATH).${setupNote}`,
    'Only then implement the goal — the verification cannot pass until the toolchain is present.',
    '',
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
