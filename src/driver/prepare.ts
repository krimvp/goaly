import type { CompiledContract } from '../domain/contract';
import type { PreparedOutcome } from '../domain/events';
import type { Verdict } from '../domain/verdict';
import type { Workspace } from '../workspace/workspace';
import type { LlmProvider } from '../llm/provider';
import type { RunProvenance } from '../runlog/runlog';
import { DeterministicVerifier } from '../verify/deterministic';
import {
  classifyPreflightSoundness,
  classifyRecontractedBar,
  classifyVacuousContract,
  type RecontractEvidence,
  type RecontractFile,
} from './preflight-soundness';
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
  /**
   * Whether `contract.setup` was COMPILER-AUTHORED (`--generate`) rather than user-supplied
   * (`--setup-cmd`) — derived in the reducer and carried on the `PREPARE_WORKSPACE` command (Fix A).
   * `true` makes a failing setup best-effort: log loudly and proceed with a `setupHint` instead of a
   * fatal `SETUP_FAILED` (a from-scratch `go mod download` presupposes scaffolding the agent has yet to
   * write). Anything else (the default) keeps the fatal behavior — a user `--setup-cmd` failing is a
   * real configuration error and must fail closed.
   */
  setupAuthored?: boolean;
  /**
   * True on a `--recontract` successor run (issue #117). Pure wiring from the run header's
   * provenance — never the contract. It widens the GREEN negative control below: on an inherited
   * tree the bar was just RE-AUTHORED with a defect report in hand, so a bar that already passes is
   * as suspicious as one passing on a from-scratch tree, and is put to {@link classifyRecontractedBar}
   * (fail-open) before any worker token is spent.
   */
  recontract?: boolean;
  /**
   * The PREDECESSOR-side half of the evidence that control needs: the bar being repaired and the
   * adjudicated defect the repair was authored against (both from the successor's run header, both
   * fenced as untrusted data downstream). The re-authored files are read here, off the tree. Absent
   * ⇒ the control still runs, just with less to compare — it is fail-open, never fail-closed.
   */
  recontractEvidence?: Omit<RecontractEvidence, 'files'>;
  /**
   * Reads an authored verification file (workspace-relative path) so the re-contract negative
   * control can attack its actual CONTENT, not just its name — the same dependency
   * `CritiquedCompiler`/`ContractDryRunCompiler` take for the same reason. Defaults to the
   * workspace's own path-guarded reader; a read failure (or `null`) drops that file from the prompt
   * only, never the run.
   */
  readFile?: (rel: string) => Promise<string | null>;
};

export type PrepareResult = { prepared: PreparedOutcome; setupRan: boolean };

/**
 * Project a successor run's header provenance onto the prepare-phase wiring the RE-CONTRACT negative
 * control needs (issue #117): the widening flag PLUS the predecessor-side evidence — the bar being
 * repaired and the adjudicated defect the repair was authored against. Without those the control is
 * asked "was this bar softened?" while being shown neither bar.
 *
 * Pure and total: `undefined` provenance ⇒ `{}` (an ordinary run, unchanged in every respect).
 */
export function recontractPrepareDeps(
  provenance: RunProvenance | undefined,
): Pick<PrepareDeps, 'recontract' | 'recontractEvidence'> {
  if (provenance === undefined) return {};
  return {
    recontract: true,
    recontractEvidence: {
      defect: provenance.verdict,
      ...(provenance.predecessorBar !== undefined
        ? { predecessorBar: provenance.predecessorBar }
        : {}),
    },
  };
}

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
  // A failed AUTHORED setup degrades to best-effort: we capture a hint for the first prompt instead of
  // aborting, then still pre-flight (B1/B2 keep the now-red bar from being misread as broken).
  let setupHint: string | undefined;
  if (contract.setup !== undefined) {
    setupRan = true;
    const setupFailure = await runSetup(deps.workspace, contract.setup, deps.timeouts?.setupMs, log);
    if (setupFailure !== null) {
      if (deps.setupAuthored === true) {
        // Authored (compiler-guessed) setup: a non-zero exit on an empty/from-scratch tree is expected
        // — the bootstrap it ran (`go mod download`, `npm ci`) presupposes scaffolding the agent has
        // not written yet. Degrade to proceed; the agent + the fail-closed runtime ladder still govern
        // correctness, so no wrong-green is possible (Fix A).
        log.warn('authored setup command failed — degrading to best-effort proceed (the agent must scaffold + run setup itself)', {
          command: contract.setup,
        });
        setupHint = buildSetupHint(contract.setup);
      } else {
        // User `--setup-cmd` (or unknown provenance): keep the fatal, fail-closed behavior.
        return { prepared: setupFailure, setupRan };
      }
    }
  }

  const prepared = await preflightDeterministic(deps, contract, log);
  // Fold the authored-setup hint into a proceed so the first prompt can surface it. A non-proceed
  // (contract-unsound) abort drops the hint — it never reaches an agent turn anyway.
  if (prepared.status === 'proceed' && setupHint !== undefined) {
    return { prepared: { ...prepared, setupHint }, setupRan };
  }
  return { prepared, setupRan };
}

/**
 * Build the first-prompt hint for an authored setup command that failed (Fix A). Kept actionable and
 * short: name the command that was attempted and steer the agent to scaffold the project (create the
 * dependency manifest the bootstrap presupposes) and run setup itself. The raw failure output is not
 * dumped — the agent has shell access and can re-run the command to see it.
 */
function buildSetupHint(setup: string): string {
  return (
    `A one-time setup command was attempted before your turn but exited non-zero: \`${setup}\`. ` +
    'This is expected on a from-scratch build — that command presupposes project scaffolding (a ' +
    'dependency manifest such as go.mod / package.json / Cargo.toml / pyproject.toml) that does not ' +
    'exist yet. Create the scaffolding the project needs and run the setup yourself as part of ' +
    'implementing the goal.'
  );
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
  if (deterministic.length === 0) {
    // One of the two residual inapplicabilities of the re-contract anti-softening control, and it is
    // STATED rather than skipped in silence: the control fires on a bar that ALREADY PASSES at t=0,
    // so with no deterministic rung there is nothing to run before the first worker turn.
    if (deps.recontract === true) {
      logControlUnapplied(log, 'the re-authored bar has no deterministic rung to execute at t=0');
    }
    return { status: 'proceed' };
  }
  const verifyMs = deps.timeouts?.verifyMs;

  // Fix B1 (revised — issue #78): is this a FROM-SCRATCH tree (no implementation source yet)? On such a
  // tree the deterministic bar is red *by definition*, and that red is almost always "implementation
  // missing" (an honest red the loop fixes) — but it can ALSO be a defect INSIDE the frozen verification
  // files that NO implementation can fix (e.g. a non-compiling authored test). The original B1 skipped
  // running the rung AND the classifier on a from-scratch tree, which let that second case slip through
  // and render the run un-completable (the worker can't touch the frozen file → STUCK_REPEATED_FAILURE).
  // So we still RUN the rung and CLASSIFY; the from-scratch signal is threaded into the classifier (which
  // fails open) so an implementation-missing red is read as honest while a broken frozen verifier is
  // caught up front. Fail-safe to false on any git error (an existing tree is never mistaken for empty).
  const emptyOfSource = await deps.workspace.isEmptyOfSource(contract.generatedFiles.map((f) => f.path));

  let lastPassDetail = '';
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
    if (verdict.pass) {
      lastPassDetail = verdict.detail;
      continue;
    }

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
      emptyOfSource,
    );
    if (soundness.broken) {
      log.error('pre-flight: frozen verification judged broken (→ CONTRACT_UNSOUND)', {});
      const reason = soundness.reason.length > 0 ? `${soundness.reason}\n\n` : '';
      return { status: 'contract-unsound', detail: `${reason}${verdict.detail}`.slice(0, DETAIL_LIMIT) };
    }
    log.info('pre-flight: deterministic rung fails as an honest red (implementation missing) — proceeding', {});
    return { status: 'proceed' };
  }

  const green = await greenNegativeControl(deps, contract, lastPassDetail, emptyOfSource, log);
  if (green !== null) return green;
  log.info('pre-flight: deterministic checks already pass before the first agent turn — proceeding', {});
  return { status: 'proceed' };
}

/**
 * The GREEN-case negative control, run when every deterministic rung ALREADY PASSED before the first
 * agent turn. Two trees make that suspicious, each with its own classifier and the same fail-open shape:
 *
 *  - FROM-SCRATCH with an AUTHORED verifier (`generatedFiles`) — the compiler-authored-the-solution
 *    deadlock: the bar can only be green because the implementation was authored INTO the frozen
 *    verification set (the anti-tamper guard then pins it, and the worker's real edits register as
 *    no-diff → a spurious abort), or the bar is vacuous.
 *  - A `--recontract` successor (issue #117) — not from-scratch (the predecessor's implementation is on
 *    disk), but the bar was just RE-AUTHORED off a defect report, so "the repair softened it" is a live
 *    risk. This is the negative control that keeps a re-contract from becoming a weakening channel, so
 *    it is given the EVIDENCE to answer that by comparison: the re-authored files are read off the
 *    inherited tree here and combined with the predecessor's bar + the adjudicated defect carried in
 *    the run header ({@link gatherRecontractEvidence}). A control shown only filenames and a pass count
 *    cannot detect softening at all — and, failing open, would wave it through.
 *
 * The two arms have DIFFERENT preconditions, and conflating them is what once made the re-contract arm
 * silently inapplicable. The vacuous arm needs an AUTHORED verifier (`generatedFiles`) — its whole
 * hypothesis is that the implementation was authored into the frozen file set. The re-contract arm
 * needs no such thing: a successor whose re-authored bar declares NO files and is a bare
 * `--verify-cmd` is the most softened bar a repair can produce, so it is precisely what the control
 * must judge. It therefore runs on a re-contract whether or not the new bar authored files.
 *
 * FAIL-OPEN by construction — it must NEVER abort a legitimate run (a file that is simply not created
 * yet stays an honest red, handled by the caller; it can never reach here). It fires ONLY on the
 * high-confidence positive signal AND an LLM confirmation: one of the two trees above
 * (`isEmptyOfSource` fail-safes to FALSE on any git error) + a model that, asked to rule IN the
 * legitimate case, confidently judges the contract unsound instead. An LLM error, an unparseable
 * verdict, or any "sound"/uncertain answer all PROCEED.
 *
 * Two things genuinely PREVENT the re-contract arm from running, and both are LOGGED rather than
 * skipped in silence: no LLM provider is wired (there is no classifier to ask — here), and the
 * re-authored bar has no deterministic rung to execute at t=0 (in {@link preflightDeterministic}).
 *
 * Returns a typed abort, or `null` to proceed (including whenever the control does not apply).
 */
async function greenNegativeControl(
  deps: PrepareDeps,
  contract: CompiledContract,
  lastPassDetail: string,
  emptyOfSource: boolean,
  log: Logger,
): Promise<PreparedOutcome | null> {
  const recontract = deps.recontract === true && !emptyOfSource;
  // The VACUOUS mirror is about a compiler that authored the solution INTO the frozen file set, so it
  // is meaningless without `generatedFiles`. The RE-CONTRACT control is not: a successor whose
  // "repaired" bar authored nothing and is a bare `--verify-cmd` is the strongest softening shape
  // there is, so gating it on `generatedFiles` disabled the control exactly where it mattered most.
  if (!recontract && (contract.generatedFiles.length === 0 || !emptyOfSource)) return null;
  if (deps.llm === undefined) {
    // Stated, not silent: the control is a model judgement, so without a read-only LLM provider
    // there is nothing to ask. Fail-open as always — it can only ever refuse a run, never green one.
    if (recontract) {
      logControlUnapplied(
        log,
        'the re-authored bar already passes on the inherited tree, but no LLM provider is wired to judge it (--llm-provider)',
      );
    }
    return null;
  }
  const classifyDeps = { llm: deps.llm, ...(deps.logger !== undefined ? { logger: deps.logger } : {}) };
  const green = recontract
    ? await classifyRecontractedBar(
        classifyDeps,
        contract,
        lastPassDetail,
        await gatherRecontractEvidence(deps, contract, log),
      )
    : await classifyVacuousContract(classifyDeps, contract, lastPassDetail);
  if (!green.broken) {
    log.info(
      'pre-flight: the bar already passes before the first agent turn, but the negative control judged ' +
        'it legitimate — proceeding',
      { recontract },
    );
    return null;
  }
  log.error(
    'pre-flight: the frozen bar passes before the first agent turn and the negative control judged it ' +
      'unsound (→ CONTRACT_UNSOUND)',
    { recontract },
  );
  const reason = green.reason.length > 0 ? `${green.reason}\n\n` : '';
  return {
    status: 'contract-unsound',
    detail: `${reason}${recontract ? RECONTRACT_REMEDY : VACUOUS_REMEDY}`.slice(0, DETAIL_LIMIT),
  };
}

/**
 * Say out loud that the `--recontract` anti-softening negative control could not be applied. The
 * control is fail-open, so an inapplicability can only ever be a silent hole in a guarantee the docs
 * state — which is why it is logged with the reason rather than skipped quietly.
 */
function logControlUnapplied(log: Logger, why: string): void {
  log.warn(
    `pre-flight: --recontract anti-softening negative control could not run — ${why}. Proceeding unchecked (fail-open).`,
    {},
  );
}

/** Per-file / total caps on the re-authored verification content folded into the control's prompt. */
const MAX_EVIDENCE_FILE_CHARS = 8000;
const MAX_EVIDENCE_TOTAL_CHARS = 32_000;

/**
 * Read the RE-AUTHORED verification files off the inherited tree and combine them with the
 * predecessor-side evidence from the run header, so the negative control can compare old bar vs new
 * bar instead of guessing from filenames and a pass count.
 *
 * FAIL-OPEN at the finest grain the finding allows: a file that is missing, unreadable, empty, or
 * whose read throws is dropped from the prompt ONLY — never an error, never an abort. Bounded per
 * file and in total so a huge authored test cannot blow up the one classifier call.
 */
async function gatherRecontractEvidence(
  deps: PrepareDeps,
  contract: CompiledContract,
  log: Logger,
): Promise<RecontractEvidence> {
  const read = deps.readFile ?? ((rel: string) => deps.workspace.readFile(rel));
  const files: RecontractFile[] = [];
  let budget = MAX_EVIDENCE_TOTAL_CHARS;
  for (const file of contract.generatedFiles) {
    if (budget <= 0) break;
    let content: string | null;
    try {
      content = await read(file.path);
    } catch (e) {
      log.warn('re-contract control: could not read a re-authored verification file — omitting it', {
        path: file.path,
        reason: errorMessage(e),
      });
      continue;
    }
    if (content === null || content.length === 0) continue;
    const clipped = content.slice(0, Math.min(MAX_EVIDENCE_FILE_CHARS, budget));
    budget -= clipped.length;
    files.push({ path: file.path, content: clipped });
  }
  return { ...(deps.recontractEvidence ?? {}), files };
}

/** Remedy for a bar that passes on a from-scratch tree (the compiler likely authored the solution). */
const VACUOUS_REMEDY =
  'The frozen verifier passes on a from-scratch tree before the worker wrote anything, so it is not ' +
  'actually testing the goal — the compiler likely authored the implementation into the frozen ' +
  'verification set (the anti-tamper guard then pins it, deadlocking the worker), or the bar is ' +
  'vacuous. Re-author with a stronger --compiler-model, review/revise the contract at Seal (avoid ' +
  '--autonomous with a weak authoring model), or supply your own --verify-cmd so you own the bar.';

/** Remedy for a RE-CONTRACTED bar (issue #117) the negative control judged weakened. */
const RECONTRACT_REMEDY =
  'The re-contracted bar passes on the inherited tree before the worker did anything, and the negative ' +
  'control judged it WEAKER than the goal — repairing a defective bar must not soften it. Re-run the ' +
  're-contract with a stronger --compiler-model, review it at Seal (--mode review), or supply your own ' +
  '--verify-cmd so you own the bar.';
