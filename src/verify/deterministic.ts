import type { Verdict } from '../domain/verdict';
import type { Verifier } from './verifier';
import type { Workspace } from '../workspace/workspace';

/** Max chars of failure output (stderr or stdout) folded into the verdict detail. */
const DETAIL_OUTPUT_LIMIT = 2000;

/**
 * Exit codes that mean the verify command could not be RUN (rather than ran and reported a real
 * failure), so a non-zero with one of these is an unevaluable verdict, not a genuine red:
 *   124  the conventional `timeout(1)` code goaly surfaces when it kills a command for exceeding
 *        `--verify-timeout-ms` (see git-workspace `realExec`) — the check never finished.
 *   126  the command was found but is not executable (a permission / not-a-program error).
 *   127  command not found / a spawn error goaly maps to 127 (git-workspace catch path).
 *   137  SIGKILL (128+9) — killed (OOM / forced kill), so the check did not complete.
 *   143  SIGTERM (128+15) — terminated before completing.
 * These are the RELIABLE, structural half of the classification; the textual signatures below are a
 * conservative best-effort for the common case where a fetch/resolve failure still exits 1.
 */
const EXECUTION_ERROR_EXIT_CODES: ReadonlySet<number> = new Set([124, 126, 127, 137, 143]);

/**
 * Conservative output signatures that indicate the verify COMMAND itself could not run — the tool,
 * a dependency, or a network fetch of one failed — as opposed to the command running and an
 * assertion failing. Deliberately narrow: each is a launch/resolution/fetch error that almost never
 * appears as the substance of a legitimate test failure. We intentionally OMIT generic transport
 * errors like ECONNREFUSED/ETIMEDOUT (those are plausibly the subject of a real network-code test);
 * the streak threshold ({@link import('../domain/config').StuckPolicy.unevaluableThreshold}) is the
 * real safety net, and misclassifying only costs a re-run, never a wrong green (fail-closed holds).
 */
const EXECUTION_ERROR_SIGNATURES: readonly RegExp[] = [
  /\bcommand not found\b/i,
  /: not found\b/,
  /\bno such file or directory\b/i,
  /\bcannot find module\b/i,
  /\bcannot find package\b/i,
  /\bERR_MODULE_NOT_FOUND\b/,
  /\bMODULE_NOT_FOUND\b/,
  /\bgetaddrinfo\b/i,
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bregistry\.npmjs\.org\b/i,
  /\bnpm error code E(?:NOTFOUND|AI_AGAIN|NETWORK)\b/i,
  /\bERR_PNPM_/,
  /\b407 (?:proxy|authentication required)\b/i,
  /\bunable to get local issuer certificate\b/i,
  /\bSELF_SIGNED_CERT_IN_CHAIN\b/,
  /\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b/,
  /\bno test files? found\b/i,
  /\[goaly\] command timed out\b/i,
];

/**
 * Decide whether a non-zero deterministic result is a could-not-EVALUATE error (the command failed
 * to run) rather than a genuine red (the command ran and the bar isn't met). Returns a short reason
 * when it is unevaluable, else null. Pure. See {@link Verdict.evaluable}: an unevaluable verdict is
 * still fail-closed (`pass: false`) — this only changes a red's CLASSIFICATION so a persistent
 * could-not-run surfaces as `CONTRACT_UNEVALUABLE` instead of a misleading no-diff/repeat abort.
 */
export function executionErrorReason(exitCode: number, output: string): string | null {
  if (EXECUTION_ERROR_EXIT_CODES.has(exitCode)) {
    return `the verify command could not run (exit ${exitCode})`;
  }
  if (EXECUTION_ERROR_SIGNATURES.some((re) => re.test(output))) {
    return 'the verify command could not run (a missing tool, dependency, or network fetch failed)';
  }
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
    const fullOutput = r.stderr || r.stdout;
    const output = fullOutput.slice(0, DETAIL_OUTPUT_LIMIT);
    // Distinguish "the command ran and the bar isn't met" (a genuine red) from "the command could
    // not run" (an environment failure goaly should surface as CONTRACT_UNEVALUABLE, never blame on
    // the worker's code). The error reason is scanned over the FULL output so a signature past the
    // detail truncation still counts. Still fail-closed: `pass` stays false either way.
    const errorReason = executionErrorReason(r.exitCode, fullOutput);
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
