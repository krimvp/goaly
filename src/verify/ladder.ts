import type { Verdict } from '../domain/verdict';
import type { Workspace } from '../workspace/workspace';
import type { Verifier } from './verifier';

/**
 * Composite Verifier (ARCHITECTURE "The Verifier unification"). Runs an ordered list of
 * rung verifiers cheapest-first (deterministic rungs placed before judge rungs by the
 * caller) with short-circuit semantics, so an early deterministic failure never wastes a
 * judge/LLM call.
 *
 * Fail-closed: a rung that THROWS is treated as a hard failure (`pass: false`,
 * `confidence: 1`) and short-circuits — a malformed grader is never a green.
 */
export class Ladder implements Verifier {
  readonly #rungs: readonly Verifier[];

  /** @param rungs Ordered rung verifiers (deterministic before judge, by the caller). */
  constructor(rungs: Verifier[]) {
    this.#rungs = [...rungs];
  }

  async verify(workspace: Workspace, goal: string, rubric: string): Promise<Verdict> {
    const confidences: number[] = [];
    const rungsTotal = this.#rungs.length;

    for (let i = 0; i < this.#rungs.length; i++) {
      const rung = this.#rungs[i]!;
      let verdict: Verdict;
      try {
        verdict = await rung.verify(workspace, goal, rubric);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        // Fail-closed: an exploding grader short-circuits as a hard red. The `i` rungs BEFORE the
        // throw passed, so the depth score is `i` (issue #85 graded ranking).
        return {
          pass: false,
          confidence: 1,
          detail: `rung error (fail-closed): ${msg}`,
          rungsPassed: i,
          rungsTotal,
        };
      }

      // First failing rung short-circuits — later (more expensive) rungs are not run. The `i` rungs
      // before it passed, so the candidate's depth score is `i` (graded ranking, issue #85).
      if (!verdict.pass) return { ...verdict, rungsPassed: i, rungsTotal };

      confidences.push(verdict.confidence);
    }

    // All rungs passed (an empty list is vacuously green: pass, confidence 1). Depth = every rung.
    const confidence = confidences.length === 0 ? 1 : Math.min(...confidences);
    return {
      pass: true,
      confidence,
      detail: `all ${rungsTotal} checks passed`,
      rungsPassed: rungsTotal,
      rungsTotal,
    };
  }
}
