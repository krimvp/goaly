import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { ContractHash, SessionId, DiffHash } from '../domain/ids';
import type { Verdict, BudgetSnapshot, HarnessRunResult } from '../domain';

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
  /** The ladder verdict of the current iteration (set in VERIFYING, read at Sign-off). */
  readonly lastVerdict: Verdict | undefined;
  /** Feedback text threaded into the next agent prompt. */
  readonly feedback: string | undefined;
};

export type OrchestratorState =
  | {
      readonly tag: 'COMPILING';
      readonly config: RunConfig;
      readonly reviseRound: number;
      /** How many bounded compile-retry rounds have already happened this authoring (issue #51). */
      readonly compileRound: number;
    }
  | {
      readonly tag: 'AWAIT_SEAL';
      readonly config: RunConfig;
      readonly contract: CompiledContract;
      /** How many Seal "revise" rounds have already happened (0 on the first presentation). */
      readonly reviseRound: number;
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
    case 'COMPILING':
    case 'AWAIT_SEAL':
      return 0;
  }
}

/** Build the initial loop context once Seal approves the frozen contract. */
export function initialCtx(config: RunConfig, contract: CompiledContract): LoopCtx {
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
  };
}
