import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';
import type { ContractHash, SessionId, DiffHash } from '../domain/ids';
import type { Verdict, BudgetSnapshot, HarnessRunResult } from '../domain';

/**
 * The position of one phase within a frozen plan (issue #48). Threaded through the per-phase states
 * (COMPILING → … → the loop) so the reducer can, when a phase reaches both keys, derive the NEXT
 * phase's config and advance — all WITHOUT the plan ever being rewritten (it is carried by reference).
 *
 * `index` ranges `0 .. plan.phases.length`: `index < length` is a sub-goal phase; `index === length`
 * is the final cumulative ACCEPTANCE phase (scoped to the ORIGINAL goal/verifier — see `phaseConfigFor`).
 * Absent on a classic single-contract run (`LoopCtx.phase === undefined`), so that path is unchanged.
 */
export type PhaseCtx = {
  /** The ORIGINAL run config — the source of inherited knobs AND the acceptance phase's goal/verifier. */
  readonly baseConfig: RunConfig;
  /** The frozen plan (carried by reference; never reassigned — the plan-level freeze, invariant #2). */
  readonly plan: PhasePlan;
  /** 0-based phase index; `plan.phases.length` denotes the final cumulative acceptance phase. */
  readonly index: number;
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
  /**
   * Per-iteration verifier evaluability, in order (drives consecutive-unevaluable detection): `true`
   * when the frozen ladder produced a real pass/fail that iteration, `false` when it could not be
   * evaluated (the verify command failed to run / the judge errored — see {@link Verdict.evaluable}).
   * Append-only like {@link runStatusHistory}; a real evaluation (pass or genuine fail) pushes `true`
   * and so breaks any could-not-evaluate streak.
   */
  readonly verifierEvaluableHistory: readonly boolean[];
  /** Whether the most recent iteration left the working tree unchanged. */
  readonly lastNoDiff: boolean;
  /** Status of the most recent agent run (surfaced as feedback when not 'completed'). */
  readonly lastRunStatus: HarnessRunResult['status'] | undefined;
  /** Per-run harness statuses, in order (drives consecutive-crash detection). */
  readonly runStatusHistory: readonly HarnessRunResult['status'][];
  /** Output of the most recent agent run — surfaced verbatim when a crash streak aborts the run. */
  readonly lastRunOutput: string | undefined;
  readonly lastBudget: BudgetSnapshot | undefined;
  /** The ladder verdict of the current iteration (set in VERIFYING, read at Sign-off). */
  readonly lastVerdict: Verdict | undefined;
  /** Feedback text threaded into the next agent prompt. */
  readonly feedback: string | undefined;
  /**
   * Where the current `feedback` came from: `'verifier'` (a red ladder's detail) or `'veto'` (a
   * green-ladder Sign-off veto reason). Drives the one-shot no-diff excuse (issue #54): a no-diff
   * iteration is excused for a veto only when the just-run turn was NOT already answering a veto —
   * an LLM approver rewords its veto every round, so comparing reason strings would renew the
   * excuse forever and burn maxIterations of approver spend on a worker that never edits.
   */
  readonly feedbackSource: 'verifier' | 'veto' | undefined;
  /**
   * The phase position within a frozen plan (issue #48), or undefined on a classic single-contract
   * run. When set, a phase reaching both keys ADVANCES (checkpoint + next phase's compile) instead of
   * declaring the whole run DONE — only the final acceptance phase's DONE ends the run.
   */
  readonly phase: PhaseCtx | undefined;
};

export type OrchestratorState =
  | {
      /** The PLAN phase (issue #48): author the frozen, ordered plan of sub-goals. Phased runs only. */
      readonly tag: 'PLANNING';
      readonly config: RunConfig;
      /** How many plan "revise" rounds have already happened (0 on the first authoring). */
      readonly reviseRound: number;
    }
  | {
      /** The plan Seal: approve / reject / revise the frozen plan. Phased only. */
      readonly tag: 'AWAIT_PLAN_SEAL';
      readonly config: RunConfig;
      readonly plan: PhasePlan;
      readonly reviseRound: number;
    }
  | {
      /**
       * Between phases (issue #48): a phase reached both keys; the Driver is taking an internal
       * checkpoint (#47) before compiling the next phase. Carries the just-completed phase position;
       * the next index is `phase.index + 1`.
       */
      readonly tag: 'ADVANCING_PHASE';
      readonly phase: PhaseCtx;
      /** Iterations the just-completed phase took (for reporting continuity; never a backstop). */
      readonly lastIteration: number;
    }
  | {
      readonly tag: 'COMPILING';
      readonly config: RunConfig;
      readonly reviseRound: number;
      /** How many bounded compile-retry rounds have already happened this authoring (issue #51). */
      readonly compileRound: number;
      /** The phase position when this compile belongs to a phased run (issue #48); else undefined. */
      readonly phase?: PhaseCtx;
    }
  | {
      readonly tag: 'AWAIT_SEAL';
      readonly config: RunConfig;
      readonly contract: CompiledContract;
      /** How many Seal "revise" rounds have already happened (0 on the first presentation). */
      readonly reviseRound: number;
      /** The phase position when this contract belongs to a phased run (issue #48); else undefined. */
      readonly phase?: PhaseCtx;
    }
  | {
      /**
       * One-time prepare phase (Fix #1 setup + Fix #2 pre-flight): runs after SEAL approval and
       * before iteration 1. Entered only when the contract has a `setup` command or authored
       * `generatedFiles` to pre-flight; otherwise the machine goes straight to the first agent turn.
       */
      readonly tag: 'PREPARING';
      readonly config: RunConfig;
      readonly contract: CompiledContract;
      /** The phase position when this prepare belongs to a phased run (issue #48); else undefined. */
      readonly phase?: PhaseCtx;
    }
  | { readonly tag: 'RUNNING_AGENT'; readonly ctx: LoopCtx }
  | { readonly tag: 'VERIFYING'; readonly ctx: LoopCtx }
  | { readonly tag: 'AWAIT_SIGNOFF'; readonly ctx: LoopCtx }
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
    case 'AWAIT_SIGNOFF':
      return state.ctx.iteration;
    case 'DONE':
    case 'FAILED':
    case 'ABORTED':
      return state.iterations;
    case 'ADVANCING_PHASE':
      return state.lastIteration;
    case 'COMPILING':
    case 'AWAIT_SEAL':
    case 'PREPARING':
    case 'PLANNING':
    case 'AWAIT_PLAN_SEAL':
      return 0;
  }
}

/**
 * Build the initial loop context once Seal approves the frozen contract. `phase` is set for a phased
 * run (issue #48) and undefined for a classic single-contract run; either way the per-iteration loop
 * is identical — only the DONE transition differs (advance-vs-terminate), handled in the reducer.
 */
export function initialCtx(
  config: RunConfig,
  contract: CompiledContract,
  phase?: PhaseCtx,
): LoopCtx {
  return {
    config,
    contract,
    iteration: 0,
    // Follow-up session inheritance (Capability C): seed the FIRST turn's session from the config
    // when set (so the agent resumes its prior working memory), else undefined — the unchanged
    // fresh-session behavior. After turn 1, `stepRunningAgent` overwrites it with the real id.
    sessionId: config.seedSessionId,
    diffHashHistory: [],
    verifierDetailHistory: [],
    verifierEvaluableHistory: [],
    lastNoDiff: false,
    lastRunStatus: undefined,
    runStatusHistory: [],
    lastRunOutput: undefined,
    lastBudget: undefined,
    lastVerdict: undefined,
    feedback: undefined,
    feedbackSource: undefined,
    phase,
  };
}
