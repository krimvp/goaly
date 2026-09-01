import path from 'node:path';
import type { DriverDeps } from '../driver/driver';
import type { RunConfig } from '../domain/config';
import type { LlmProvider } from '../llm/provider';
import { AgentCompiler } from '../compile/agent-compiler';
import { classifyUsageShape } from '../compile/usage-gate';
import {
  critiqueCompiler,
  critiquePlanner,
  dryRunCompiler,
  seedCompiler,
  seedPlanner,
} from './compose-authoring';
import { AutoSealGate, HumanSealGate } from '../compile/seal-gates';
import { AgentPlanner } from '../plan/agent-planner';
import { StaticPlanner } from '../plan/static-planner';
import { AutoPlanGate, HumanPlanGate } from '../plan/plan-gates';
import type { Planner } from '../plan/planner';
import type { PlanGate } from '../plan/plan-gate';
import { GitWorkspace, realExec } from '../workspace/git-workspace';
import { FileWorkspace } from '../workspace/file-workspace';
import { GitWorktreeHost } from '../workspace/git-worktree-host';
import { writeVerificationFile } from '../workspace/workspace-files';
import { detectWorkspaceFacts } from '../workspace/workspace-facts';
import { resolveDefectCorpus } from '../defects/wiring';
import { DEFAULT_DEFECT_HINT_CAP } from '../defects/select';
import { FileRunLog } from '../runlog/file-runlog';
import { SystemClock } from '../driver/clock';
import { SystemBudgetMeter } from '../driver/budget';
import { LlmTokenMeter, meterLlm } from '../driver/llm-meter';
import { DefaultWaveRunner } from '../driver/wave-runner';
import { LlmObserver, type Observer } from '../observe/observer';
import type { StreamPhase } from '../agent-cli/stream';
import { resolveModels } from './models';
import { independenceWarnings } from './independence';
import { defaultLlmProvider } from './args';
import { networkForSeam, withSandboxVerify } from '../sandbox';
import type { ExecFn } from '../workspace/git-workspace';
import type { ComposeOptions } from './compose-options';
import { buildRunLogger, buildStreamSink } from './compose-logging';
import { EndpointConfigError, makeLlmProvider } from './compose-provider';
import { buildApprover, buildLadder } from './compose-verify';
import {
  defaultPolicy,
  makeGoalyCodeHarness,
  makeHarness,
  makeSandboxLauncher,
  refuseIfUnavailable,
  resolveWorkspaceMode,
} from './compose-harness';

// The public surface stays importable from './compose' (src/index.ts, the CLI commands, the UI, and
// the tests); the pieces live in the compose-* modules beside this one.
export type { ComposeOptions } from './compose-options';
export { EndpointConfigError, makeLlmProvider } from './compose-provider';
export { buildLadder } from './compose-verify';
export { NoopHarness } from './compose-harness';

/** The orchestrator's own state directory name, kept out of stuck-detection hashing. */
export const STATE_DIR = '.goaly';

/**
 * Verifier-produced artifacts kept OUT of the working-tree hash (and the diff the approver reviews) by
 * default, on top of the user's `--diff-ignore`. A verify command routinely drops these between
 * iterations (bytecode/test/type caches), and a no-op agent turn that only regenerates them would
 * otherwise look like it "changed" the tree — defeating no-diff stuck detection. Deliberately narrow:
 * only ephemeral test/cache/bytecode markers that are NEVER source and NEVER a deliverable. It omits
 * build output (`build/`, `dist/`, `target/`) — a build goal's legitimate product must stay visible so
 * a tree-only-of-build-output turn can't masquerade as progress — and avoids the bare word "coverage"
 * (it would over-match a real source file like `coverage_report.py`). Each entry is a git pathspec
 * where `*` spans `/`, so `*__pycache__*` catches nested caches at any depth. Verified in
 * `compose.diff-ignore.test.ts`.
 */
export const DEFAULT_DIFF_IGNORE: readonly string[] = [
  '*__pycache__*',
  '*.pyc',
  '*.pyo',
  '*.pytest_cache*',
  '*.mypy_cache*',
  '*.ruff_cache*',
  '*.nyc_output*',
  '*htmlcov*',
];

/**
 * Default kill-timeout for the verify command (and each pre-flight deterministic rung) — the same
 * 10 minutes the harness and LLM steps default to. Before this default existed, a verify command
 * that hung (a test awaiting the network, a spawned server that never exits) hung the whole run
 * unboundedly — the one unguarded subprocess in the loop. Override with `--verify-timeout-ms`.
 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The composition root: assemble a fully-wired {@link DriverDeps} from validated config. This
 * is the only place that knows which concrete adapter/verifier/gate backs each seam, and the
 * only place that turns the frozen contract's rungs into a runnable Ladder. Models resolve WITH the provider, so the approver can stay independent of the agent's `--model` (issue #125).
 */
export function composeDeps(config: RunConfig, options: ComposeOptions): DriverDeps {
  const provider = options.llmProvider ?? defaultLlmProvider(options.harness);
  const models = resolveModels(options.models ?? {}, { llmProvider: provider });
  // The verify command gets a DEFAULT kill-timeout (matching the harness/LLM 10-min default): a
  // verify command that hangs (a test awaiting the network, a server that never exits) must never
  // hang the whole run unboundedly. A hit is a fail-closed could-not-evaluate — the unevaluable
  // streak or the run's own caps then govern — never a green. `--verify-timeout-ms` overrides.
  const timeouts = { verifyMs: DEFAULT_VERIFY_TIMEOUT_MS, ...(options.timeouts ?? {}) };
  // One meter for every LLM workflow step (compiler / judge / approver) so the Driver can aggregate
  // their token spend per command (issue #17). Wrapping is transparent — the consumers still see a
  // plain LlmProvider, and an injected test `llm` is metered just the same.
  const llmMeter = new LlmTokenMeter();
  const clock = new SystemClock();
  // Keep the orchestrator's own state dir, a default set of ephemeral verifier artifacts (bytecode /
  // test / type caches — see DEFAULT_DIFF_IGNORE), AND any user-listed `--diff-ignore` paths out of the
  // tree hash, so stuck-detection sees only the agent's real work — not caches a verifier drops between
  // iterations. Deduped so an explicit `.goaly`/default in --diff-ignore is a no-op.
  const excludes = [...new Set([STATE_DIR, ...DEFAULT_DIFF_IGNORE, ...config.diffIgnore])];
  // Build the sandbox launcher ONCE (issue #9). `none` ⇒ identity; any other mode is detected
  // fail-closed (an absent mechanism makes the run refuse to start — never silently unsandboxed).
  const launcher = makeSandboxLauncher(options);
  refuseIfUnavailable(launcher);
  // The verifier seam: wrap ONLY GitWorkspace.run() — never the git plumbing. The dedicated
  // run-launcher injection point applies the jail inside run(), where scrubVerifyEnv already lives.
  const runLauncher = launcher.identity
    ? undefined
    : (exec: ExecFn): ExecFn =>
        withSandboxVerify(
          exec,
          launcher,
          networkForSeam(options.sandbox ?? defaultPolicy(), 'verifier'),
          options.egressProxy,
        );
  const workspaceMode = resolveWorkspaceMode(options.workspaceMode ?? 'auto', options.workspaceRoot);
  const workspace =
    workspaceMode === 'file'
      ? new FileWorkspace(options.workspaceRoot, runLauncher === undefined ? realExec : runLauncher(realExec), excludes)
      : new GitWorkspace(options.workspaceRoot, undefined, excludes, true, runLauncher);
  // Worktree host: wired for best-of-N (issue #85, `--candidates > 1`) and for EXPERIMENTAL
  // cooperative parallel waves (`--parallel-phases`) — a run using neither never touches it. It
  // shares the canonical root / exec / excludes / verify-jail so each isolated worktree hashes +
  // scores identically to the canonical workspace. File-mode workspaces do not support worktrees.
  const wantsWorktrees = config.candidates > 1 || (config.phased && config.parallelPhases);
  if (wantsWorktrees && workspaceMode === 'file') {
    throw new EndpointConfigError(
      'best-of-N and parallel phases require a git workspace (--workspace-mode git)',
    );
  }
  const worktrees =
    wantsWorktrees
      ? new GitWorktreeHost({
          root: options.workspaceRoot,
          exec: realExec,
          excludes,
          scrubVerifyEnv: true,
          ...(runLauncher !== undefined ? { runLauncher } : {}),
        })
      : undefined;
  // Adopt an explicit `--baseline` (issue #47) so `diff()`/Sign-off compare against it instead of HEAD.
  // The CLI already validated it resolves (fail-closed); a resumed run re-points it from the log.
  if (options.baseline !== undefined) workspace.setBaseline(options.baseline);
  const stateDir = options.stateDir ?? path.join(options.workspaceRoot, STATE_DIR);
  const logger = options.logger ?? buildRunLogger(options, stateDir);
  const streamSink = buildStreamSink(options, logger, stateDir, options.now ?? (() => clock.now()));

  // Warn loudly when the "two independent keys" collapse onto one model. Skipped when
  // the caller injects its own `llm` — then the resolved per-seam models are not what runs, so the
  // wiring warning would be misleading (and noisy in tests/embedders).
  if (options.llm === undefined) {
    const independenceCtx = {
      generate: config.verifier.kind === 'generate',
      autonomous: config.autonomous,
      approverQuorum: config.approver.quorum,
      ...(models.approverModels !== undefined ? { approverModels: models.approverModels } : {}),
    };
    for (const warning of independenceWarnings(models, options.harness, provider, independenceCtx)) {
      logger.warn('model independence', { detail: warning });
    }
  }

  // An injected `llm` (tests) overrides every step; otherwise build a provider per step so each can
  // carry its own resolved model, per-step timeout, AND its phase-tagged stream sink. All three are
  // wiring — none enters the frozen contract. The sink is injected at CONSTRUCTION so it never leaks
  // through the Verifier/Approver seams (the `LlmProvider` stays an internal seam). Each provider is
  // wrapped with the shared meter so its token spend is aggregated at the Driver (issue #17).
  const llmFor = (model: string | undefined, phase: StreamPhase): LlmProvider =>
    meterLlm(
      options.llm ??
        makeLlmProvider(provider, model, {
          ...(timeouts.llmMs !== undefined ? { timeoutMs: timeouts.llmMs } : {}),
          ...(streamSink !== undefined ? { onEvent: (event) => streamSink(phase, event) } : {}),
          ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
          ...(options.llmApiKey !== undefined ? { apiKey: options.llmApiKey } : {}),
          ...(options.llmFetch !== undefined ? { fetch: options.llmFetch } : {}),
        }),
      llmMeter,
    );

  // Phased decomposition (issue #48): wire the planner + plan Seal ONLY for a phased run (a classic
  // run never emits a PLAN command, so building them would be dead wiring + a spurious LLM provider).
  // `--plan-file` selects the StaticPlanner; otherwise the AgentPlanner authors the plan. `--autonomous`
  // moves the plan Seal pause too (still frozen + logged loudly).
  const seed = options.followupSeed;
  const phasedSeams: { planner: Planner; planGate: PlanGate } | undefined = config.phased
    ? {
        // A phased follow-up authors its plan AWARE of the prior run too: the seed rides the planner's
        // authoring feedback (SeededPlanner), exactly as it rides the compiler below. The adversarial
        // plan critique wraps ONLY the LLM planner — a --plan-file is the user's explicit plan.
        planner: seedPlanner(
          options.planFile !== undefined
            ? new StaticPlanner({ path: options.planFile })
            : critiquePlanner(
                new AgentPlanner({ llm: llmFor(models.planner, 'plan') }),
                config,
                () => llmFor(models.critic, 'plan'),
                logger,
              ),
          seed,
        ),
        planGate:
          options.planGate ??
          (config.autonomous
            ? new AutoPlanGate()
            : new HumanPlanGate({ allowRevise: config.maxPlanRevisions > 0 })),
      }
    : undefined;

  // The optional `--explain` observer (issue #8). Built ONLY when requested (or injected), so a
  // default run pays nothing. Its read-only provider is deliberately NOT wrapped with the run's
  // `llmMeter` and NOT stream-tapped: the narrator's spend must never enter the run budget or
  // influence the loop — it is a strictly advisory side channel (the issue's core constraint). An
  // injected `options.llm` (tests) still overrides the provider; an injected `options.observer`
  // bypasses construction entirely.
  const observer: Observer | undefined =
    options.observer ??
    (options.explain === true
      ? new LlmObserver({
          llm:
            options.llm ??
            makeLlmProvider(provider, models.explain, {
              ...(timeouts.llmMs !== undefined ? { timeoutMs: timeouts.llmMs } : {}),
              ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
              ...(options.llmApiKey !== undefined ? { apiKey: options.llmApiKey } : {}),
              ...(options.llmFetch !== undefined ? { fetch: options.llmFetch } : {}),
            }),
          write: options.explainWrite ?? ((text) => void process.stderr.write(text)),
        })
      : undefined);

  // Deterministic workspace facts (small-model steering): probed ONCE from files on disk, injected
  // into the compiler + red-team prompts and driving the pre-freeze module-format lint. Strictly
  // detected, never assumed — a non-code workspace yields `undefined` and nothing is injected.
  const workspaceFacts = detectWorkspaceFacts(options.workspaceRoot);

  // The cross-run defect corpus (issue #122), resolved ONCE: `section` is injected into contract
  // authoring (bounded + filtered to this workspace's ecosystem, and logged so the hidden local
  // state that shaped the bar is named in the run's diagnostics); `corpus` is the writer only a
  // CONTRACT_DEFECTIVE adjudication can use. Fail-open — an absent corpus changes nothing. The
  // launcher is threaded in so the injection log can say plainly whether the corpus's HMAC means
  // anything against the AGENT on this run (only a real jail masks `$HOME/.goaly`; under the
  // default identity passthrough the agent shares goaly's uid and can read the signing key).
  const defects = resolveDefectCorpus(
    options.defects,
    options.workspaceRoot,
    logger,
    DEFAULT_DEFECT_HINT_CAP,
    !launcher.identity,
  );

  // ONE budget meter for the whole run — hoisted so EXPERIMENTAL parallel-wave children share it
  // (the `--budget-tokens` cap governs the fan-out, not each child separately).
  const budget = new SystemBudgetMeter(config.budget, clock);

  // EXPERIMENTAL cooperative parallel waves (`--parallel-phases`): each wave CHILD is a FULL goaly
  // run composed by this very function, rooted at its ephemeral worktree — its own frozen contract,
  // two-key gate, and write-ahead log (under `<worktree>/.goaly`), on the parent's budget meter and
  // interrupt probe. Parent-anchored artifact paths (log/stream/state overrides, the diff baseline)
  // are stripped so children never write into the parent's files.
  const wave =
    config.phased && config.parallelPhases && worktrees !== undefined
      ? new DefaultWaveRunner({
          host: worktrees,
          workspace,
          workspaceRoot: options.workspaceRoot,
          ...(timeouts.verifyMs !== undefined ? { verifyTimeoutMs: timeouts.verifyMs } : {}),
          logger,
          composeChild: async (spec, worktree, childRunId, interrupted) => {
            const { logFile: _lf, streamFile: _sf, stateDir: _sd, baseline: _b, ...rest } = options;
            const childDeps = composeDeps(spec.config, {
              ...rest,
              workspaceRoot: worktree.root,
              runId: childRunId,
            });
            return {
              ...childDeps,
              budget,
              ...(interrupted !== undefined ? { interrupted } : {}),
            };
          },
        })
      : undefined;

  return {
    compiler: seedCompiler(
      // The compile-time POSITIVE control (issue #115) wraps the critics: what it executes is the
      // contract the critics already accepted, and a red there refuses the freeze (→ COMPILE_FAILED
      // → the same bounded re-author loop). Fail-open, so it can only reject or step aside.
      dryRunCompiler(
        critiqueCompiler(
          new AgentCompiler({
            llm: llmFor(models.compiler, 'compile'),
            writeFile: (rel, content) => writeVerificationFile(options.workspaceRoot, rel, content, logger),
            ...(options.verifyDir !== undefined ? { verifyDir: options.verifyDir } : {}),
            ...(workspaceFacts !== undefined ? { facts: workspaceFacts } : {}),
            ...(defects.section.length > 0 ? { defectSection: defects.section } : {}),
            // Anti-reimplementation usage gate: a separate, neutral shape call over the goal (metered
            // like the authoring call) arms the gate on a confident build-and-use goal so a bar that a
            // parallel reimplementation could green is refused at compile (COMPILE_FAILED → re-authored
            // with a usage assertion). Fail-open, so it never blocks a non-build-and-use run.
            classifyShape: (goal, intent) =>
              classifyUsageShape(llmFor(models.compiler, 'compile'), goal, intent),
          }),
          config,
          () => llmFor(models.critic, 'compile'),
          options.workspaceRoot,
          logger,
          workspaceFacts,
        ),
        config,
        () => llmFor(models.compiler, 'compile'),
        options.workspaceRoot,
        timeouts.verifyMs,
        logger,
        workspaceFacts,
        // The scratch executes the contract's setup + rungs, so it goes through the SAME jail as
        // the verifier seam — never bare on the host under an active `--sandbox` policy.
        runLauncher,
      ),
      seed,
    ),
    seal:
      options.sealGate ??
      (config.autonomous
        ? new AutoSealGate()
        : new HumanSealGate({ allowRevise: config.maxSealRevisions > 0 })),
    ...(phasedSeams !== undefined ? phasedSeams : {}),
    harness:
      options.harnessFactory !== undefined
        ? options.harnessFactory(options.workspaceRoot)
        : options.harness === 'goaly-code'
          ? makeGoalyCodeHarness(options, models, stateDir, logger, launcher)
          : makeHarness(
              options.harness,
              models.harness,
              timeouts.harnessMs,
              timeouts.harnessIdleMs,
              {
                launcher,
                workspace: options.workspaceRoot,
                policy: options.sandbox ?? defaultPolicy(),
                ...(options.egressProxy !== undefined ? { proxy: options.egressProxy } : {}),
              },
              options.harnessAutonomy,
            ),
    makeLadder: (contract) => {
      // Surface the frozen authored bar (`generatedFiles`) in the diff the two LLM keys review, even
      // though it's git-excluded (issue #52) from the user's `git status`. Without this the judge sees
      // the rubric's test file as "absent from the diff" and false-vetoes a correct run into a
      // deadlock with the integrity guard. Re-set per phase so each phase shows its own authored files.
      workspace.setDiffIncludes(contract.generatedFiles.map((f) => f.path));
      // The --adversarial refuter rung is a verification judgment, so its provider is metered under
      // the 'judge' phase (no new spend category); built only when enabled — a default run pays 0.
      const adversarial =
        config.adversarial.enabled && config.adversarial.refuters > 0
          ? { llm: llmFor(models.critic, 'judge'), refuters: config.adversarial.refuters }
          : undefined;
      return buildLadder(
        contract,
        llmFor(models.judge, 'judge'),
        timeouts.verifyMs,
        adversarial,
      );
    },
    // Sign-off (second key, issue #84 + follow-up): a single reviewer by default (quorum 1 ⇒
    // byte-for-byte the historical call). `--approver-quorum N` runs a perspective-diverse panel
    // behind the UNCHANGED Approver seam; `--approver-models m1,m2,…` (follow-up) gives the panel REAL
    // per-reviewer model independence — one `'approve'`-metered provider per model (so the usage
    // report still attributes ALL panel spend to the approver layer), cycled across reviewers. With
    // a model list and no `--approver-quorum`, the quorum defaults to the model count.
    approver: buildApprover(config, models, llmFor),
    // Pre-flight soundness classifier (Fix #2): a read-only call that decides whether a failing
    // deterministic pre-flight rung is a broken frozen verifier or an honest red. Reuses the judge
    // model — it is a verification judgment — and is metered through the same shared meter.
    prepareLlm: llmFor(models.judge, 'preflight'),
    // The corpus WRITER (issue #122). Handed to the Driver, which appends only from an adjudicated
    // CONTRACT_DEFECTIVE verdict; absent under `--no-defect-corpus`, so nothing can be recorded.
    ...(defects.corpus !== undefined ? { defectCorpus: defects.corpus } : {}),
    workspace,
    ...(worktrees !== undefined ? { worktrees } : {}),
    ...(wave !== undefined ? { wave } : {}),
    clock,
    budget,
    llmMeter,
    runlog: new FileRunLog(path.join(stateDir, options.runId)),
    logger,
    // Per-step timeouts for the one-time prepare phase (Fix #1 setup + Fix #2 pre-flight). The setup
    // command gets its own cap; the deterministic pre-flight reuses the verify-command cap. Pure wiring.
    prepareTimeouts: {
      ...(timeouts.setupMs !== undefined ? { setupMs: timeouts.setupMs } : {}),
      ...(timeouts.verifyMs !== undefined ? { verifyMs: timeouts.verifyMs } : {}),
    },
    ...(streamSink !== undefined ? { onStreamEvent: streamSink } : {}),
    ...(observer !== undefined ? { observer } : {}),
  };
}
