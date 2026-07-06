import type { OrchestratorEvent, Command, HarnessRunResult } from '../domain/events';
import type { RunConfig, VerifierIntent } from '../domain/config';
import { pickGatePolicy, pickLoopPolicy, pickDriverWiring } from '../domain/config';
import type { CompiledContract, Rung } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';
import type { OrchestratorState, LoopCtx, PhaseCtx } from './state';
import { initialCtx } from './state';
import { decide, type Decision } from './decide';
import { normalizeDetail } from './stuck';
import { TRUNCATED_JSON_MARKER } from '../util/json-extract';

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
    case 'edited':
      // Manual editing applies to CONTRACT artifacts only (ADR 0016); no plan gate ever emits
      // `edited` (the shared SealDecision schema merely allows it structurally). Defense in
      // depth: a hand-crafted event fails closed to a typed ABORTED, never a silent approve.
      return [
        {
          tag: 'ABORTED',
          reason: 'manual plan editing is not supported at the plan Seal — use revise',
          iterations: 0,
          contractHash: undefined,
        },
        [],
      ];
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
  // A sub-goal phase: FRESH contract inputs authored per sub-goal (goal/verifier/rubric), but the
  // SAME operational policy as the run — inherited wholesale by lifetime VIEW (gate / loop / wiring)
  // rather than re-listed field by field, plus the setup/judge knobs a sub-goal still needs. `phased`
  // is cleared. The view spreads keep this honest: a new RunConfig field lands in exactly one view and
  // is inherited automatically, so a phase config can't silently drop a field. (Delta-verify is in the
  // wiring view; the Driver reads the OUTER run's `deltaVerify`, so the phase just round-trips it.)
  const sub = phase.plan.phases[phase.index]!;
  const verifier: VerifierIntent = {
    kind: 'generate',
    ...(sub.intent !== undefined ? { intent: sub.intent } : {}),
  };
  return {
    ...pickGatePolicy(base),
    ...pickLoopPolicy(base),
    ...pickDriverWiring(base),
    goal: sub.goal,
    verifier,
    noSetup: base.noSetup,
    judge: base.judge,
    // (The Sign-off panel — issue #84 — rides in via pickDriverWiring(base): it's pure wiring, not
    // frozen into the contract, so each phase's Sign-off uses the same panel.)
    ...(sub.rubric !== undefined ? { rubric: sub.rubric } : {}),
    phased: false,
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
  const base =
    `The previous attempt to author the verification failed: ${reason}. ` +
    "Author verification that runs over the repo's existing tooling, and write any helper files " +
    'inside the workspace using relative paths only.';
  // A truncation-shaped failure (see TRUNCATED_JSON_MARKER) means the LAST attempt explored the repo
  // too long and ran out of turns/output budget before finishing its JSON answer. The generic
  // "author verification" guidance above isn't enough on its own — spell out the actual fix so the
  // retry doesn't repeat the same over-exploration trajectory (the compiler also forces a fresh
  // session for this case rather than resuming the exhausted one — see agent-compiler.ts).
  if (reason.includes(TRUNCATED_JSON_MARKER)) {
    return (
      base +
      ' Do NOT re-explore the repository from scratch — you already gathered enough context last ' +
      'time. Go straight to emitting the complete JSON object as your first and only substantive ' +
      'output this turn.'
    );
  }
  return base;
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
          [
            {
              tag: 'PREPARE_WORKSPACE',
              contract,
              installMissingTools: config.installMissingTools,
              setupAuthored: setupIsAuthored(config, contract),
            },
          ],
        ];
      }
      const ctx = initialCtx(config, contract, phase);
      // `ctx.sessionId` is the inherited seed (Capability C) when set, else undefined (the unchanged
      // fresh-session start). After turn 1 the real returned id takes over (stepRunningAgent).
      return startIteration(ctx, buildInitialPrompt(contract), ctx.sessionId);
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
    case 'edited': {
      // Manual-edit refreeze (ADR 0016): the operator changed the authored files on disk and/or
      // sent a field patch. NOT counted against maxSealRevisions — that cap protects LLM spend,
      // and a refreeze costs zero tokens while each round requires an explicit human action at an
      // already-unbounded human gate, so it is unbounded by design. compileRound resets like
      // revise's (issue #51): a fresh human-driven round gets a fresh per-attempt error budget.
      // The reducer stays pure: it only NAMES the effect over data it already holds (the parked
      // contract + the event's patch); the Driver re-reads/re-hashes/re-freezes and a fresh
      // CONTRACT_COMPILED returns here for re-presentation.
      return [
        {
          tag: 'COMPILING',
          config,
          reviseRound,
          compileRound: 0,
          ...(phase !== undefined ? { phase } : {}),
        },
        [
          {
            tag: 'REFREEZE_CONTRACT',
            contract,
            ...(event.decision.patch !== undefined ? { patch: event.decision.patch } : {}),
          },
        ],
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
 * Was this contract's `setup` COMPILER-AUTHORED (under `--generate`) rather than user-supplied via
 * `--setup-cmd`? Pure wiring derived from config + contract (Fix A) — NOT stored in the frozen contract
 * (that would churn `contractHash`). A setup exists AND the user did not supply `--setup-cmd` ⇒ the
 * compiler authored it, so a failure is best-effort. A user `--setup-cmd` (which the compiler freezes
 * verbatim into `contract.setup`) stays fatal. Holds across all paths: a phased sub-goal config never
 * carries `setupCmd` (always authored), while the acceptance phase inherits it from the base config.
 */
function setupIsAuthored(config: RunConfig, contract: CompiledContract): boolean {
  return contract.setup !== undefined && config.setupCmd === undefined;
}

/**
 * The prepare phase resolved (Fix #1 / #2). The Driver already ran setup once and pre-flighted the
 * deterministic rungs; the reducer only routes the typed outcome:
 *  - `proceed`          → start iteration 1 (setup was clean / absent; pre-flight passed or failed as
 *                         an honest red — the implementation is simply missing, which the loop fixes).
 *  - `setup-failed`     → FAILED (typed SETUP_FAILED) — never hand the worker a broken environment.
 *  - `contract-unsound` → FAILED (typed CONTRACT_UNSOUND) — the frozen verification is defective, not
 *                         the implementation: it either can't even run (a broken authored verifier) or
 *                         already passes vacuously on a from-scratch tree (the compiler authored the
 *                         solution into the frozen set / the bar tests nothing). No worker tokens are
 *                         spent chasing a contract defect.
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
      // Carry the inherited session seed (Capability C) into the first turn when set; else undefined
      // (unchanged). After turn 1 the real returned id takes over (stepRunningAgent).
      return startIteration(
        ctx,
        buildInitialPrompt(contract, prepared.installTools, prepared.setupHint),
        ctx.sessionId,
      );
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
            'CONTRACT_UNSOUND: the frozen verification is unsound — the defect is in the authored ' +
              `verification, not the implementation — ${prepared.detail}`,
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
    // (e.g. pass→veto→fail) can't be mistaken for "N identical failures in a row". A pass is by
    // definition a real evaluation, so it appends `true` and breaks any could-not-evaluate streak.
    const next: LoopCtx = {
      ...ctx,
      lastVerdict: verdict,
      verifierDetailHistory: [],
      verifierEvaluableHistory: [...ctx.verifierEvaluableHistory, true],
    };
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

  // Failed ladder: record the normalized failure AND whether it was a real evaluation or a
  // could-not-evaluate (an unevaluable verdict carries `evaluable: false`), then DECIDE (Sign-off
  // never runs). The evaluability history drives the consecutive-unevaluable stuck detector.
  const next: LoopCtx = {
    ...ctx,
    lastVerdict: verdict,
    verifierDetailHistory: [...ctx.verifierDetailHistory, normalizeDetail(verdict.detail)],
    verifierEvaluableHistory: [...ctx.verifierEvaluableHistory, verdict.evaluable !== false],
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

/**
 * Start one loop iteration. Exactly ONE command either way (the Driver `commands.length === 1`
 * invariant). With `--candidates N` (N>1, issue #85) emit `RUN_AGENT_BEST_OF` so the Driver runs a
 * best-of-N tournament and feeds back the winner's `AGENT_RAN` — decided PURELY from config, so the
 * reducer stays pure and `stepRunningAgent` is unchanged (it never learns K existed). N===1 emits
 * `RUN_AGENT` byte-for-byte as before (no markers, the classic single attempt).
 */
function startIteration(
  ctx: LoopCtx,
  prompt: string,
  sessionId: LoopCtx['sessionId'],
): StepResult {
  const candidates = ctx.config.candidates;
  const command: Command =
    candidates > 1
      ? { tag: 'RUN_AGENT_BEST_OF', prompt, sessionId, candidates }
      : { tag: 'RUN_AGENT', prompt, sessionId };
  return [{ tag: 'RUNNING_AGENT', ctx }, [command]];
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

function buildInitialPrompt(
  contract: CompiledContract,
  installTools?: readonly string[],
  setupHint?: string,
): string {
  return [
    '# Goal',
    contract.goal,
    '',
    buildBootstrapSection(contract, installTools),
    buildSetupNoteSection(setupHint),
    '# Frozen success contract (you cannot modify it)',
    'Your work is accepted only when ALL of the following pass:',
    describeRungs(contract.rungs),
    contract.rubric ? `\nOverall rubric:\n${contract.rubric}` : '',
    '',
    'Make the changes needed to satisfy the contract. Do not weaken or rewrite the checks themselves.',
    '',
    VERIFICATION_DIVISION_OF_LABOR,
  ].join('\n');
}

/**
 * The division-of-labor note carried by every worker prompt. The worker's ONE job each turn is to
 * EDIT the tree toward the goal; goaly runs the frozen contract itself after the turn and feeds the
 * result back next iteration. Spelling this out prevents the failure mode where the agent treats
 * "run the verification command" as a required submit step and — when that command can't run in its
 * environment — burns the whole turn flailing on it and ends with no edits (a no-diff stall). Running
 * its own quick checks is fine; getting stuck on one is not.
 */
const VERIFICATION_DIVISION_OF_LABOR = [
  '# How verification works (do not run it yourself to "submit")',
  'goaly runs the frozen success contract above for you AUTOMATICALLY after this turn ends, and gives',
  'you the result on the next turn. You do NOT need to run the verification command to submit your',
  'work — your job each turn is to EDIT the code toward the goal. Running your own quick checks is',
  'fine, but if a command is unavailable or blocked in this environment, do NOT get stuck on it:',
  'make your best-effort code changes and end the turn. A turn that changes no files makes no progress.',
].join('\n');

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

/**
 * The setup note prepended to the first prompt when a COMPILER-AUTHORED setup command failed and the
 * prepare phase degraded to best-effort proceed (Fix A). It tells the agent the bootstrap was attempted,
 * presupposes scaffolding that does not exist yet, and must be scaffolded + run by the agent. Empty when
 * there is no such hint (setup ran clean, was absent, or was a fatal user `--setup-cmd`).
 */
function buildSetupNoteSection(setupHint?: string): string {
  if (setupHint === undefined || setupHint.length === 0) return '';
  return ['# Setup note', setupHint, ''].join('\n');
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
    '',
    VERIFICATION_DIVISION_OF_LABOR,
  ].join('\n');
}

function invalidTransition(stateTag: string, event: OrchestratorEvent): Error {
  return new Error(`invalid transition: event ${event.tag} in state ${stateTag}`);
}
