import type { CompiledContract } from '../domain/contract';
import type { PreparedOutcome } from '../domain/events';
import type { Verdict } from '../domain/verdict';
import type { Workspace } from '../workspace/workspace';
import type { LlmProvider } from '../llm/provider';
import { DeterministicVerifier } from '../verify/deterministic';
import { classifyPreflightSoundness } from './preflight-soundness';
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
  /**
   * The (read-only) LLM provider used to classify a failing deterministic pre-flight rung as a broken
   * frozen verifier (→ CONTRACT_UNSOUND) vs. an honest red (→ proceed). Optional: when absent (e.g. a
   * plain `--verify-cmd` run, or a contract with no authored verification files), pre-flight cannot —
   * and does not — abort on a red; it proceeds and lets the runtime ladder + stuck detection govern.
   */
  llm?: LlmProvider;
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
 *     the FROZEN verification actually runs. A red is classified — language-agnostically, by the LLM —
 *     as either a broken frozen verifier (it cannot run; `contract-unsound`, abort before spending a
 *     worker token) or an HONEST red (the implementation is simply missing) → `proceed` to the loop.
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
 * run here — pre-flight runs only the deterministic, ungameable checks to prove they can execute. A
 * pre-flight infrastructure error is advisory (the real ladder runs fail-closed every iteration), so it
 * never aborts the run — it degrades to `proceed`. The single red→unsound classification is delegated to
 * the LLM ({@link classifyPreflightSoundness}) so it is language-agnostic rather than a per-runner text/
 * exit-code heuristic; it fires only when there are authored verification files AND an LLM is wired.
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
    // checks), or is this an honest red because the implementation is simply missing? Only a contract
    // with authored, frozen verification files can be "unsound" in a way the agent can't fix, and the
    // classification needs the LLM — without either, a red is treated as an honest red and proceeds.
    if (contract.generatedFiles.length === 0 || deps.llm === undefined) {
      log.info('pre-flight: deterministic rung is red — proceeding (no authored verifier / no classifier)', {});
      return { status: 'proceed' };
    }
    const soundness = await classifyPreflightSoundness(
      { llm: deps.llm, ...(deps.logger !== undefined ? { logger: deps.logger } : {}) },
      contract,
      verdict.detail,
    );
    if (soundness.broken) {
      log.error('pre-flight: frozen verification judged broken (→ CONTRACT_UNSOUND)', {});
      const reason = soundness.reason.length > 0 ? `${soundness.reason}\n\n` : '';
      return { status: 'contract-unsound', detail: `${reason}${verdict.detail}`.slice(0, DETAIL_LIMIT) };
    }
    log.info('pre-flight: deterministic rung fails as an honest red (implementation missing) — proceeding', {});
    return { status: 'proceed' };
  }

  log.info('pre-flight: deterministic checks already pass before the first agent turn — proceeding', {});
  return { status: 'proceed' };
}
