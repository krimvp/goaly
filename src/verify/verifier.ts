import type { Verdict } from '../domain/verdict';
import type { Workspace } from '../workspace/workspace';

/**
 * Seam #2. The unified verifier interface — the state machine cannot distinguish a
 * deterministic exit-code check from an LLM quorum from the composite Ladder. A verifier
 * that errors must be fail-closed (`pass: false`); a malformed grader is never a green.
 */
export interface Verifier {
  verify(workspace: Workspace, goal: string, rubric: string): Promise<Verdict>;
}
