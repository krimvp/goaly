import type { Verdict } from '../domain/verdict';
import type { Verifier } from './verifier';
import type { Workspace, CommandResult } from '../workspace/workspace';

/** Max chars of failure output (stderr or stdout) folded into the verdict detail. */
const DETAIL_OUTPUT_LIMIT = 2000;

/**
 * Decide whether a non-zero deterministic result is a could-not-EVALUATE error (the command never
 * produced a real pass/fail) rather than a genuine red (the command ran and the bar isn't met).
 *
 * Deliberately NOT a heuristic: we do not pattern-match exit codes or scrape error strings (those
 * rot and misfire). We classify only on facts goaly OWNS for certain — it imposed the timeout, and
 * it caught the spawn failure (see {@link import('../workspace/workspace').CommandResult}). Any other
 * non-zero exit is treated as a genuine, evaluable red. Other could-not-run causes are handled where
 * they actually belong, not by re-deriving them here: a missing toolchain is caught BEFORE the loop
 * by the `requiredTools` pre-flight (installed or a typed `TOOLS_MISSING` abort), and a verify
 * command that fetches from the network at run time is prevented at the source — the compiler authors
 * offline commands (install once in `setup`, invoke the local binary in the command).
 *
 * Returns a short reason when unevaluable, else null. Pure. See {@link Verdict.evaluable}: an
 * unevaluable verdict is still fail-closed (`pass: false`) — this only changes a red's CLASSIFICATION
 * so a persistent could-not-run surfaces as `CONTRACT_UNEVALUABLE` instead of a misleading
 * no-diff/repeat abort that discards possibly-correct work.
 */
export function executionErrorReason(result: CommandResult): string | null {
  if (result.timedOut === true) return 'the verify command timed out before it could finish';
  if (result.spawnFailed === true) return 'the verify command could not be started';
  return null;
}

/**
 * A deterministic verifier: runs a shell command and maps exit code 0 → pass.
 * Confidence is always 1 — there is no fuzziness in an exit code.
 */
export class DeterministicVerifier implements Verifier {
  readonly #command: string;
  readonly #label: string | undefined;
  readonly #timeoutMs: number | undefined;

  constructor(command: string, label?: string, timeoutMs?: number) {
    this.#command = command;
    this.#label = label;
    this.#timeoutMs = timeoutMs;
  }

  async verify(workspace: Workspace, _goal: string, _rubric: string): Promise<Verdict> {
    const r =
      this.#timeoutMs !== undefined
        ? await workspace.run(this.#command, { timeoutMs: this.#timeoutMs })
        : await workspace.run(this.#command);
    const name = this.#label ?? this.#command;
    const pass = r.exitCode === 0;
    if (pass) {
      return { pass: true, confidence: 1, detail: `${name}: exit 0` };
    }
    const output = (r.stderr || r.stdout).slice(0, DETAIL_OUTPUT_LIMIT);
    // Distinguish "the command ran and the bar isn't met" (a genuine red) from "the command could
    // not run" (an environment failure goaly should surface as CONTRACT_UNEVALUABLE, never blame on
    // the worker's code). Classified ONLY from facts goaly owns (it timed the command out / could not
    // start it), never guessed from the exit code or output. Still fail-closed: `pass` stays false.
    const errorReason = executionErrorReason(r);
    return {
      pass: false,
      confidence: 1,
      detail:
        errorReason !== null
          ? `${name}: ${errorReason} — exit ${r.exitCode}\n${output}`
          : `${name}: exit ${r.exitCode}\n${output}`,
      ...(errorReason !== null ? { evaluable: false } : {}),
    };
  }
}
