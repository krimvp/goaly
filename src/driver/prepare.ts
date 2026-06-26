import type { CompiledContract } from '../domain/contract';
import type { PreparedOutcome } from '../domain/events';
import type { Verdict } from '../domain/verdict';
import type { Workspace } from '../workspace/workspace';
import type { LlmProvider } from '../llm/provider';
import { DeterministicVerifier } from '../verify/deterministic';
import { classifyPreflightSoundness } from './preflight-soundness';
import { isProbeSafe } from '../compile/required-tools';
import { noopLogger, type Logger } from '../log/logger';
import { errorMessage } from '../util/errors';

/** Default kill-timeout for the one-time setup command when none is configured (10 min, like the LLM steps). */
const DEFAULT_SETUP_TIMEOUT_MS = 600_000;
/** Kill-timeout for the tool-availability probe (a handful of `command -v` checks — should be instant). */
const TOOL_PROBE_TIMEOUT_MS = 30_000;
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
  /**
   * What to do when a `requiredTools` program is missing. `true` (default) delegates the install to the
   * agent (skip goaly's own setup — it would only fail on the absent toolchain — and thread the missing
   * tools into the first prompt); `false` opts out with a typed `tools-missing` abort. Mirrors
   * `RunConfig.installMissingTools`.
   */
  installMissingTools?: boolean;
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

  // 0. TOOL PREFLIGHT: are the external programs the verification needs already on PATH? Runs BEFORE
  // setup, because setup itself assumes the toolchain exists (a `rustup component add` is useless if
  // `rustup` is missing). A miss is either handed to the agent (default) or a typed fail-closed abort.
  const missing = await checkMissingTools(deps.workspace, contract.requiredTools, log);
  if (missing.length > 0) {
    if (deps.installMissingTools === false) {
      log.error('required tools missing and --install-missing-tools is off (→ TOOLS_MISSING)', {
        missing: missing.join(', '),
      });
      return { prepared: { status: 'tools-missing', detail: toolsMissingDetail(missing) }, setupRan: false };
    }
    // Default: delegate the install to the agent. Skip goaly's own setup + pre-flight — both would only
    // fail on the absent toolchain — and carry the missing tools into the first prompt as a bootstrap.
    log.info('required tools missing — delegating install to the agent (default)', {
      missing: missing.join(', '),
    });
    return { prepared: { status: 'proceed', installTools: missing }, setupRan: false };
  }

  let setupRan = false;
  if (contract.setup !== undefined) {
    setupRan = true;
    const setupFailure = await runSetup(deps.workspace, contract.setup, deps.timeouts?.setupMs, log);
    if (setupFailure !== null) return { prepared: setupFailure, setupRan };
  }

  const prepared = await preflightDeterministic(deps, contract, log);
  return { prepared, setupRan };
}

/**
 * Probe which of `tools` are NOT on PATH, using the workspace's own shell + (PATH-augmented) env — the
 * same environment the verifier will use, so the check is accurate. One subprocess: each safe name is
 * `command -v`-tested and echoed back only when absent. Fail-OPEN: any probe error (or no safely-probeable
 * names) yields `[]`, so a probe glitch never blocks a legitimate run — the runtime ladder is the backstop.
 */
async function checkMissingTools(
  workspace: Workspace,
  tools: readonly string[],
  log: Logger,
): Promise<string[]> {
  const safe = [...new Set(tools.filter(isProbeSafe))];
  if (safe.length === 0) return [];
  const script = safe.map((t) => `command -v ${t} >/dev/null 2>&1 || printf '%s\\n' ${t}`).join('\n');
  try {
    const r = await workspace.run(script, { timeoutMs: TOOL_PROBE_TIMEOUT_MS });
    const reported = new Set(r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0));
    return safe.filter((t) => reported.has(t));
  } catch (e) {
    log.warn('tool preflight probe errored (advisory only) — proceeding', { reason: errorMessage(e) });
    return [];
  }
}

/** The `tools-missing` detail (opt-out path): name the absent programs and how to proceed. */
function toolsMissingDetail(missing: readonly string[]): string {
  return (
    `the verification requires ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not ` +
    'installed on PATH. Install the toolchain, or drop `--install-missing-tools false` to let the agent ' +
    'install it, or re-run with a `--verify-cmd` whose tools are present.'
  );
}

/**
 * Append an actionable hint to a `setup-failed` detail. Exit 127 from the shell means "command not
 * found" — the setup program (a toolchain like `rustup`/`cargo`/`go`, or a missing dependency) simply
 * isn't installed here, which goaly can't bootstrap for you. Point the user at the fix rather than
 * leaving them with a bare exit code.
 */
function setupHint(exitCode: number): string {
  if (exitCode !== 127) return '';
  return (
    '\n\nHint: exit 127 means the setup command’s program is not installed in this environment. ' +
    'Install the required toolchain/dependency, or re-run with `--setup-cmd "<correct command>"` to ' +
    'override it, or `--no-setup` if the tree is already prepared.'
  );
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
    return {
      status: 'setup-failed',
      detail: `\`${setup}\` exited ${r.exitCode}\n${output}${setupHint(r.exitCode)}`,
    };
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
