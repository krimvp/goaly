import type { Verdict } from '../domain/verdict';
import type { Verifier } from './verifier';
import type { Workspace } from '../workspace/workspace';

/** Max chars of failure output (stderr or stdout) folded into the verdict detail. */
const DETAIL_OUTPUT_LIMIT = 2000;

/**
 * A deterministic verifier: runs a shell command and maps exit code 0 → pass.
 * Confidence is always 1 — there is no fuzziness in an exit code.
 */
export class DeterministicVerifier implements Verifier {
  readonly #command: string;
  readonly #label: string | undefined;

  constructor(command: string, label?: string) {
    this.#command = command;
    this.#label = label;
  }

  async verify(workspace: Workspace, _goal: string, _rubric: string): Promise<Verdict> {
    const r = await workspace.run(this.#command);
    const name = this.#label ?? this.#command;
    const pass = r.exitCode === 0;
    if (pass) {
      return { pass: true, confidence: 1, detail: `${name}: exit 0` };
    }
    const output = (r.stderr || r.stdout).slice(0, DETAIL_OUTPUT_LIMIT);
    return {
      pass: false,
      confidence: 1,
      detail: `${name}: exit ${r.exitCode}\n${output}`,
    };
  }
}
