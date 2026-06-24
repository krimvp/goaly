import type { CompiledContract } from '../domain/contract';
import type { PreparedOutcome } from '../domain/events';
import type { Verdict } from '../domain/verdict';
import type { Workspace } from '../workspace/workspace';
import { DeterministicVerifier } from '../verify/deterministic';
import { noopLogger, type Logger } from '../log/logger';
import { errorMessage } from '../util/errors';

/** Default kill-timeout for the one-time setup command when none is configured (10 min, like the LLM steps). */
const DEFAULT_SETUP_TIMEOUT_MS = 600_000;
/** Max chars of setup / pre-flight output folded into a fail-closed reason, so the run log stays bounded. */
const DETAIL_LIMIT = 2000;

/** Per-step kill-timeouts for the prepare phase (pure wiring; absent ⇒ defaults / unbounded). */
export type PrepareTimeouts = { setupMs?: number; verifyMs?: number };

export type PrepareDeps = {
  workspace: Workspace;
  logger?: Logger;
  timeouts?: PrepareTimeouts;
};

export type PrepareResult = { prepared: PreparedOutcome; setupRan: boolean };

/**
 * The one-time prepare phase the Driver performs between SEAL approval and the first agent turn
 * (Fix #1 setup + Fix #2 pre-flight). Two sequential effects, each fail-closed:
 *
 *  1. SETUP (Fix #1): run the contract's one-time bootstrap command (e.g. `npm ci`) once. A non-zero
 *     exit — or a throw — is a typed `setup-failed`, so the worker never starts on a broken tree (the
 *     incident: a missing `node_modules` drove the worker to hand-roll brittle type shims).
 *  2. PRE-FLIGHT (Fix #2): run the deterministic rung(s) ONCE against the now-prepared tree to prove
 *     the FROZEN verification actually runs. A failure whose output points at an authored verification
 *     file is a `contract-unsound` defect (abort before spending a worker token); any other red is an
 *     HONEST red (the implementation is simply missing) → `proceed` to the loop.
 *
 * Pure data in, typed outcome out: the reducer routes the outcome; this function performs the effects.
 */
export async function prepareWorkspace(
  deps: PrepareDeps,
  contract: CompiledContract,
): Promise<PrepareResult> {
  const log = deps.logger ?? noopLogger;
  let setupRan = false;

  if (contract.setup !== undefined) {
    setupRan = true;
    const setupFailure = await runSetup(deps.workspace, contract.setup, deps.timeouts?.setupMs, log);
    if (setupFailure !== null) return { prepared: setupFailure, setupRan };
  }

  const prepared = await preflightDeterministic(deps, contract, log);
  return { prepared, setupRan };
}

/** Run the one-time setup command; return a `setup-failed` outcome on non-zero/throw, or null on success. */
async function runSetup(
  workspace: Workspace,
  setup: string,
  timeoutMs: number | undefined,
  log: Logger,
): Promise<Extract<PreparedOutcome, { status: 'setup-failed' }> | null> {
  log.info('running one-time workspace setup before the first agent turn', { command: setup });
  try {
    const r = await workspace.run(setup, { timeoutMs: timeoutMs ?? DEFAULT_SETUP_TIMEOUT_MS });
    if (r.exitCode === 0) return null;
    log.error('workspace setup failed (fail-closed → SETUP_FAILED)', { exitCode: r.exitCode });
    const output = (r.stderr || r.stdout).slice(0, DETAIL_LIMIT);
    return { status: 'setup-failed', detail: `\`${setup}\` exited ${r.exitCode}\n${output}` };
  } catch (e) {
    log.error('workspace setup threw (fail-closed → SETUP_FAILED)', { reason: errorMessage(e) });
    return { status: 'setup-failed', detail: `\`${setup}\` failed to run: ${errorMessage(e)}` };
  }
}

/**
 * Run the contract's deterministic rung(s) once and classify the result (Fix #2). Judge rungs are NOT
 * run here — pre-flight spends no LLM tokens; it only proves the deterministic, ungameable checks can
 * execute. A pre-flight infrastructure error is advisory (the real ladder runs fail-closed every
 * iteration), so it never aborts the run — it degrades to `proceed`.
 */
async function preflightDeterministic(
  deps: PrepareDeps,
  contract: CompiledContract,
  log: Logger,
): Promise<PreparedOutcome> {
  const deterministic = contract.rungs.filter((r) => r.kind === 'deterministic');
  if (deterministic.length === 0) return { status: 'proceed' };
  const verifyMs = deps.timeouts?.verifyMs;

  for (const rung of deterministic) {
    if (rung.kind !== 'deterministic') continue; // narrow (filtered above)
    let verdict: Verdict;
    try {
      const verifier = new DeterministicVerifier(rung.command, rung.label, verifyMs);
      verdict = await verifier.verify(deps.workspace, contract.goal, contract.rubric);
    } catch (e) {
      log.warn('pre-flight check errored (advisory only) — proceeding to the worker loop', {
        reason: errorMessage(e),
      });
      return { status: 'proceed' };
    }
    if (verdict.pass) continue;

    // First failing deterministic rung: is the AUTHORED verification broken (it could not even run its
    // checks), or is this an honest red because the implementation is simply missing?
    if (verificationCannotRun(verdict.detail, contract)) {
      log.error('pre-flight: frozen verification cannot run (fail-closed → CONTRACT_UNSOUND)', {});
      return { status: 'contract-unsound', detail: verdict.detail.slice(0, DETAIL_LIMIT) };
    }
    log.info('pre-flight: deterministic rung fails as an honest red (implementation missing) — proceeding', {});
    return { status: 'proceed' };
  }

  log.info('pre-flight: deterministic checks already pass before the first agent turn — proceeding', {});
  return { status: 'proceed' };
}

/**
 * Markers that a deterministic check FAILED TO RUN its assertions at all — a defect in the authored
 * verification (compile / syntax / collection / import error), as opposed to a verifier that ran fine
 * and reported an honest red. These are the only signals that justify a `CONTRACT_UNSOUND` abort.
 *
 * Why a bare path match is NOT enough: most test runners (pytest in particular) echo the test file's
 * own path on EVERY run — the session header (`test_x.py FFFFF`) and every traceback frame
 * (`test_x.py:18:`) — so a perfectly healthy honest red (the implementation files don't exist yet)
 * names the authored file too. Keying off path-mention alone wrongly rejected those as unsound,
 * making `--verifier generate` + pytest unusable (it aborted at pre-flight with 0 iterations).
 */
const CANNOT_RUN_SIGNALS: readonly RegExp[] = [
  /\berror TS\d+\b/, // tsc compile error (e.g. an authored `.test.ts` that doesn't typecheck)
  /\bSyntaxError\b/, // python (or JS) parse failure in the authored file
  /\bIndentationError\b/,
  /\bTabError\b/,
  /errors? during collection/i, // pytest could not import/collect the authored test module (exit 2)
  /\bERROR collecting\b/, // pytest per-file collection error
  /\bINTERNALERROR\b/, // pytest crashed internally
  /no tests ran/i, // pytest collected nothing to verify (exit 5)
];

/** Does the failure output name one of the compiler-authored, content-pinned verification files? */
function referencesAuthoredFile(detail: string, contract: CompiledContract): boolean {
  return contract.generatedFiles.some((f) => detail.includes(f.path));
}

/**
 * Classify a failing deterministic pre-flight rung (Fix #2 heuristic). The contract is `CONTRACT_UNSOUND`
 * only when the failure both (a) originates in an authored verification file AND (b) looks like the
 * verifier could not RUN its checks (a compile/syntax/collection error — see {@link CANNOT_RUN_SIGNALS}).
 * An honest assertion red — even one whose traceback names the authored test file because the
 * implementation isn't there yet — has no such signal and proceeds to the loop. Fail-closed is preserved:
 * a genuinely broken verifier (it can't compile/collect) is still rejected before a worker token is spent.
 */
function verificationCannotRun(detail: string, contract: CompiledContract): boolean {
  if (!referencesAuthoredFile(detail, contract)) return false;
  return CANNOT_RUN_SIGNALS.some((re) => re.test(detail));
}
