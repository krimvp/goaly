import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { Plan } from '../domain/plan';
import type { ContractHash, SessionId, DiffHash } from '../domain/ids';
import type { Verdict, BudgetSnapshot, HarnessRunResult } from '../domain';

/**
 * Progress through a FROZEN phased plan (issue #48). Carried by reference through every per-phase
 * state so a phase IS a normal frozen-contract run that happens to know which phase it is. The plan
 * is never rewritten by any transition — only the bounded, gated revise path re-authors it. The
 * `baseConfig` (the ORIGINAL run config) is the pure source from which each per-phase config is
 * derived, so the whole machine stays reconstructable from the run-log header alone (resume #7).
 */
export type PlanProgress = {
  /** The original, unscoped run config — `phaseConfig()` derives each phase from it. */
  readonly baseConfig: RunConfig;
  /** The frozen, hashed plan of sub-goals. */
  readonly plan: Plan;
  /** Which phase is executing: 0..plan.phases.length. `=== plan.phases.length` ⇒ acceptance. */
  readonly phaseIndex: number;
  /** Sum of agent iterations from already-completed phases (for whole-run iteration accounting). */
  readonly priorIterations: number;
};

/**
 * The loop's accumulated context. Every field is reconstructable purely from the event
 * stream, which is what makes resume == replay-fold. The frozen `contract` is carried by
 * reference and never reassigned — the reducer has no transition that rewrites it.
 *
 * "Maybe-absent" fields are typed `T | undefined` (always set) rather than optional, so
 * transitions can spread+override without tripping `exactOptionalPropertyTypes`.
 */
export type LoopCtx = {
  readonly config: RunConfig;
  readonly contract: CompiledContract;
  /** Count of completed agent runs (0 before the first run). */
  readonly iteration: number;
  readonly sessionId: SessionId | undefined;
  /** Post-run workspace hashes, in order (drives oscillation detection). */
  readonly diffHashHistory: readonly DiffHash[];
  /** Normalized details of FAILED verifier verdicts (drives repeat-failure detection). */
  readonly verifierDetailHistory: readonly string[];
  /** Whether the most recent iteration left the working tree unchanged. */
  readonly lastNoDiff: boolean;
  /** Status of the most recent agent run (surfaced as feedback when not 'completed'). */
  readonly lastRunStatus: HarnessRunResult['status'] | undefined;
  readonly lastBudget: BudgetSnapshot | undefined;
  /** The ladder verdict of the current iteration (set in VERIFYING, read at Gate B). */
  readonly lastVerdict: Verdict | undefined;
  /** Feedback text threaded into the next agent prompt. */
  readonly feedback: string | undefined;
  /**
   * Phased-plan progress (issue #48), or `undefined` for the classic single-contract run. When set,
   * a phase reaching DONE checkpoints and advances instead of ending the run; only the final
   * cumulative acceptance phase reaching DONE (both keys) ends the whole run as DONE.
   */
  readonly plan: PlanProgress | undefined;
};

export type OrchestratorState =
  | {
      /** Phased mode only (issue #48): authoring the frozen plan of sub-goals. */
      readonly tag: 'PLANNING';
      readonly config: RunConfig;
      /** How many plan-gate "revise" rounds have already happened (0 on the first authoring). */
      readonly reviseRound: number;
    }
  | {
      /** Phased mode only: the plan gate (plan-level Gate A) decides over the frozen plan. */
      readonly tag: 'AWAIT_PLAN_GATE';
      readonly config: RunConfig;
      readonly plan: Plan;
      readonly reviseRound: number;
    }
  | {
      /** Phased mode only: a phase finished (both keys); checkpointing before the next phase. */
      readonly tag: 'CHECKPOINTING';
      readonly progress: PlanProgress;
    }
  | {
      readonly tag: 'COMPILING';
      readonly config: RunConfig;
      readonly reviseRound: number;
      /** Phased-plan progress when this compile is a phase of a plan; undefined otherwise. */
      readonly plan: PlanProgress | undefined;
    }
  | {
      readonly tag: 'AWAIT_GATE_A';
      readonly config: RunConfig;
      readonly contract: CompiledContract;
      /** How many Gate A "revise" rounds have already happened (0 on the first presentation). */
      readonly reviseRound: number;
      /** Phased-plan progress when this contract is a phase of a plan; undefined otherwise. */
      readonly plan: PlanProgress | undefined;
    }
  | { readonly tag: 'RUNNING_AGENT'; readonly ctx: LoopCtx }
  | { readonly tag: 'VERIFYING'; readonly ctx: LoopCtx }
  | { readonly tag: 'AWAIT_GATE_B'; readonly ctx: LoopCtx }
  | { readonly tag: 'DONE'; readonly iterations: number; readonly contractHash: ContractHash }
  | {
      readonly tag: 'FAILED';
      readonly reason: string;
      readonly iterations: number;
      readonly contractHash: ContractHash | undefined;
    }
  | {
      readonly tag: 'ABORTED';
      readonly reason: string;
      readonly iterations: number;
      readonly contractHash: ContractHash | undefined;
    };

export type TerminalTag = 'DONE' | 'FAILED' | 'ABORTED';

export function isTerminal(
  state: OrchestratorState,
): state is Extract<OrchestratorState, { tag: TerminalTag }> {
  return state.tag === 'DONE' || state.tag === 'FAILED' || state.tag === 'ABORTED';
}

/**
 * Completed-iteration count for ANY state — pure over the state alone. The single source of
 * truth shared by the Driver (outcomes) and the read-only run-inspection projection, so an
 * inspected run reports the same iteration count the Driver computed. 0 before the loop starts.
 */
export function iterationCount(state: OrchestratorState): number {
  switch (state.tag) {
    case 'RUNNING_AGENT':
    case 'VERIFYING':
    case 'AWAIT_GATE_B':
      // In a phased run, add the iterations already spent by completed phases (whole-run count).
      return (state.ctx.plan?.priorIterations ?? 0) + state.ctx.iteration;
    case 'CHECKPOINTING':
      return state.progress.priorIterations;
    case 'DONE':
    case 'FAILED':
    case 'ABORTED':
      return state.iterations;
    case 'PLANNING':
    case 'AWAIT_PLAN_GATE':
    case 'COMPILING':
    case 'AWAIT_GATE_A':
      return 0;
  }
}

/**
 * Build the initial loop context once Gate A approves the frozen contract. In a phased run (issue
 * #48) `plan` carries the frozen-plan progress so this phase knows which phase it is; it is
 * `undefined` for the classic single-contract run.
 */
export function initialCtx(
  config: RunConfig,
  contract: CompiledContract,
  plan?: PlanProgress,
): LoopCtx {
  return {
    config,
    contract,
    iteration: 0,
    sessionId: undefined,
    diffHashHistory: [],
    verifierDetailHistory: [],
    lastNoDiff: false,
    lastRunStatus: undefined,
    lastBudget: undefined,
    lastVerdict: undefined,
    feedback: undefined,
    plan,
  };
}
