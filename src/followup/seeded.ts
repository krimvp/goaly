import type { ContractInput, RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';
import type { VerifierCompiler } from '../compile/compiler';
import type { Planner } from '../plan/planner';

/**
 * Capability C wiring — weave a follow-up's prior-run COMPACTION (see {@link compactRun}) into the
 * authoring `feedback` of the compiler and planner, WITHOUT touching the pure reducer.
 *
 * The seed is prior-run context that should inform EVERY authoring attempt, so it is combined with
 * whatever feedback the command already carries: a Seal "revise" note, or a compile-retry hint
 * (issue #51). The reducer keeps emitting `COMPILE_VERIFIER` / `COMPILE_PLAN` exactly as before
 * (including the first one with no feedback); these decorators sit at the composition root and inject
 * the seed as the call crosses the seam. The freeze is unaffected — each attempt is still frozen and
 * Sealed on its own (invariants #2/#3).
 *
 * A RESUME CAN STILL RE-AUTHOR. Compile is once per run LOG, not once per process: a crash before
 * `CONTRACT_COMPILED` was persisted, or a Seal "revise" round, brings the resumed run back through
 * `compile()`. The seed is a composition-root value and `--from-run` is refused with `--resume`, so
 * it cannot arrive from the command line then — it must be RECONSTRUCTIBLE FROM THE RUN-LOG HEADER,
 * which is why the follow-up's predecessor and its bounded compaction are recorded there
 * (`RunFollowup`; the `--recontract` sibling rebuilds its repair brief from `RunProvenance`). A
 * header that predates those fields cannot be rebuilt, and the resume path says so out loud rather
 * than quietly authoring a fresh bar with no prior-run context.
 */

/** Prepend the seed to the command feedback (or use it alone when the command carried none). */
export function combineFeedback(seed: string, feedback: string | undefined): string {
  return feedback !== undefined && feedback.length > 0 ? `${seed}\n\n${feedback}` : seed;
}

/** Wrap a {@link VerifierCompiler} so the prior-run seed rides every `compile()` as feedback. */
export class SeededCompiler implements VerifierCompiler {
  readonly #inner: VerifierCompiler;
  readonly #seed: string;
  constructor(inner: VerifierCompiler, seed: string) {
    this.#inner = inner;
    this.#seed = seed;
  }
  compile(input: ContractInput, feedback?: string): Promise<CompiledContract> {
    return this.#inner.compile(input, combineFeedback(this.#seed, feedback));
  }
}

/** Wrap a {@link Planner} so the prior-run seed rides every `plan()` as feedback (phased follow-ups). */
export class SeededPlanner implements Planner {
  readonly #inner: Planner;
  readonly #seed: string;
  constructor(inner: Planner, seed: string) {
    this.#inner = inner;
    this.#seed = seed;
  }
  plan(config: RunConfig, feedback?: string): Promise<PhasePlan> {
    return this.#inner.plan(config, combineFeedback(this.#seed, feedback));
  }
}
