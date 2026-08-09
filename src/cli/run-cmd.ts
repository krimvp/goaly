import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  USAGE,
  RESUMED_GOAL_PLACEHOLDER,
  defaultLlmProvider,
  isHarnessChoice,
  type ParsedArgs,
} from './args';
import { recontractCommand } from '../followup/recontract';
import { resolveFollowup, resumeAuthoringSeed } from './followup-wiring';
import { composeDeps, STATE_DIR, EndpointConfigError } from './compose';
import { SandboxUnavailableError, isAllowlist, startEgressProxy, type EgressProxy } from '../sandbox';
import { drive } from '../driver/driver';
import { refResolves, resolveRef } from '../workspace/git-workspace';
import { asRunId, type RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';
import type { RunConfig } from '../domain/config';
import type { SealGate } from '../compile/seal';
import type { PlanGate } from '../plan/plan-gate';
import type { PhasedStreamSink } from '../agent-cli/stream';
import { readRun } from '../runlog/inspect';
import { CONTRACT_SOUND_MARKER } from '../orchestrator/stuck';
import { hintSubject } from './reason-text';
import type { RunLogEntry } from '../runlog/runlog';
import { FileRunLog } from '../runlog/file-runlog';
import {
  adjudicationVerdict,
  extendedRunConfig,
  applyRunExtension,
  resumeStreakRelief,
} from '../runlog/replay';
import { renderResolvedConfig } from './dry-run';
import type { RunExtension } from '../domain/events';
import { acquireRunLock, RunLockedError, type RunLock } from '../runlog/lock';
import { killActiveChildren } from '../util/spawn';
import { detectWorkspaceMode, preflightRun } from './preflight';
import { resumeHint, renderResumeHint, type ResumeHint } from './resume-cmd';
import { resolveModels } from './models';
import { approverSwapNotice, degradedMode } from './independence';
import {
  degradedModeDetail,
  degradedModeTag,
  mostDegraded,
  type DegradedMode,
} from '../domain/degraded';
import { parsePriceTable, computeCost, type CostView, type PriceTable } from './cost';
import { formatUsage } from './usage-format';

/**
 * The SHARED run entrypoint (ADR 0015): the whole `goaly run` path — cost table, guards,
 * follow-up/resume resolution, run lock, egress proxy, composition, `drive()`, and the outcome
 * report — behind injectable IO, so the CLI (`main`) and the goaly-ui server execute the SAME
 * code and can never drift. `main()` passes real stdout/stderr and signal handlers; the UI server
 * passes its browser gates, a per-run stop probe, and a stream sink.
 */
export type RunIo = {
  out: (s: string) => void;
  err: (s: string) => void;
  /**
   * Inject the Seal / plan-Seal gates (the goaly-ui browser gates, or fakes). A gate
   * IMPLEMENTATION — the freeze and the loud SEAL_DECIDED log are unchanged (invariant #5).
   * Absent ⇒ the classic selection on `config.autonomous` (human prompt vs auto-accept).
   */
  sealGate?: SealGate;
  planGate?: PlanGate;
  /**
   * External cooperative-stop probe (the UI's stop button). Polled by the Driver between steps —
   * flipping it yields the same clean, resumable ABORTED as Ctrl-C. When injected, NO process
   * signal handlers are installed (the embedding process owns its signals).
   */
  interrupted?: () => boolean;
  /** Subscribe to the run's phase-tagged stream events (the UI's live push channel). */
  onStreamEvent?: PhasedStreamSink;
  /** Fires as soon as the run id is known (before the loop) — the UI's 201 response hook. */
  onStarted?: (runId: RunId) => void;
  /** Force the durable stream transcript on (UI-owned runs record one so history survives). */
  forceStreamTranscript?: boolean;
  /** Keep the diagnostics logger off the console (the UI server's terminal stays quiet). */
  quietConsole?: boolean;
};

export type RunResult = { code: number; runId: RunId | undefined; outcome: RunOutcome | undefined };

/** Exit code for a run stopped by Ctrl-C/SIGTERM (128 + SIGINT), distinct from FAILED/ABORTED (1). */
const EXIT_INTERRUPTED = 130;

/**
 * The model/provider flags the user actually set, as structured log fields (set ones only; the
 * LLM provider is also logged when it RESOLVES off `claude` — e.g. derived from `--harness codex`).
 */
function startupFields(parsed: ParsedArgs): Record<string, string> {
  const m = parsed.models;
  const fields: Record<string, string> = {};
  if (m.model !== undefined) fields.model = m.model;
  if (m.llmModel !== undefined) fields.llmModel = m.llmModel;
  if (m.judgeModel !== undefined) fields.judgeModel = m.judgeModel;
  if (m.approverModel !== undefined) fields.approverModel = m.approverModel;
  if (m.compilerModel !== undefined) fields.compilerModel = m.compilerModel;
  if (parsed.llmProvider !== 'claude') fields.llmProvider = parsed.llmProvider;
  return fields;
}

/**
 * Graceful-interrupt wiring (Ctrl-C / SIGTERM). The FIRST signal requests a cooperative stop: the
 * Driver finishes the in-flight step (its event lands write-ahead) and resolves to a typed ABORTED
 * with the resume command — nothing is lost and the user is told exactly how to continue. A SECOND
 * signal force-exits (130) after reaping any live child process groups (a group-spawned agent CLI
 * does not share the terminal's process group, so without the sweep it would outlive goaly and
 * keep editing/spending). Exposed for tests; `executeRun` installs/removes it around `drive()`.
 */
export function makeInterruptController(
  runId: string,
  warn: (s: string) => void,
  forceExit: () => void = () => {
    killActiveChildren();
    process.exit(130);
  },
): { onSignal: () => void; interrupted: () => boolean } {
  let signals = 0;
  return {
    onSignal: (): void => {
      signals += 1;
      if (signals === 1) {
        warn(
          `\ngoaly: interrupt received — finishing the current step, then stopping cleanly ` +
            `(press Ctrl-C again to exit immediately).\n` +
            `goaly: resume later with: goaly --resume ${runId} (plus your original flags)\n`,
        );
        return;
      }
      warn(`\ngoaly: exiting immediately — resume with: goaly --resume ${runId}\n`);
      forceExit();
    },
    interrupted: (): boolean => signals > 0,
  };
}

/**
 * Execute one run end-to-end. Byte-for-byte the historical `main()` run path — extracted so the
 * goaly-ui server drives runs through the very same guards, lock, composition, and reporting.
 */
export async function executeRun(parsed: ParsedArgs, io: RunIo): Promise<RunResult> {
  const worktreeName = typeof parsed.worktreeRun === 'string' ? parsed.worktreeRun : undefined;

  // Load the optional cost table BEFORE the run so a malformed table fails fast (never mid-run).
  let priceTable: PriceTable | undefined;
  if (parsed.costTablePath !== undefined) {
    try {
      priceTable = parsePriceTable(await readFile(parsed.costTablePath, 'utf8'));
    } catch (e) {
      io.err(
        `--cost-table ${parsed.costTablePath}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return { code: 2, runId: undefined, outcome: undefined };
    }
  }

  // Resolve the concrete workspace mode early so git-specific validations can be skipped in
  // file-mode runs.
  const concreteWorkspaceMode =
    parsed.workspaceMode === 'auto'
      ? await detectWorkspaceMode(parsed.workspace)
      : parsed.workspaceMode;

  // Validate --baseline (issue #47) fail-closed BEFORE the run starts: an unknown ref refuses to
  // start rather than silently degrading the diff (invariant #6, parse at the seam). On resume the
  // baseline is reconstructed from the log instead, so the flag is moot then.
  if (
    parsed.baseline !== undefined &&
    parsed.resumeRunId === undefined &&
    concreteWorkspaceMode === 'git'
  ) {
    if (!(await refResolves(parsed.workspace, parsed.baseline))) {
      io.err(
        `--baseline ${parsed.baseline}: not a resolvable git ref in ${parsed.workspace}\n\n${USAGE}\n`,
      );
      return { code: 2, runId: undefined, outcome: undefined };
    }
  }

  // Raised harness autonomy AUTO-PINS the review baseline (read-only, so it belongs up here with
  // the --baseline validation): above the least-privilege tier the agent may `git commit`, which
  // moves HEAD and empties the HEAD-relative diff BOTH keys review — so pin the diff to the
  // run-start commit's SHA (a symbolic HEAD would move with the commit). An explicit --baseline
  // wins; a resume reconstructs its baseline from the run log instead; an unborn HEAD (fresh
  // `git init`, nothing to pin to) degrades to the loud warning below.
  let autoPinnedBaseline: string | undefined;
  if (
    concreteWorkspaceMode === 'git' &&
    parsed.harnessAutonomy !== undefined &&
    parsed.harnessAutonomy !== 'low' &&
    parsed.baseline === undefined &&
    parsed.resumeRunId === undefined
  ) {
    autoPinnedBaseline = (await resolveRef(parsed.workspace, 'HEAD')) ?? undefined;
  }

  // Capability C (`--from-run`): recover the prior run, build its compaction, and (with
  // --inherit-session) seed the session. A normal run passes through unchanged.
  const followup = await resolveFollowup(parsed, io.err);
  if (!followup.ok) return { code: followup.code, runId: undefined, outcome: undefined };

  // Validate --resume BEFORE the preflight and before creating anything (the run lock would
  // otherwise mkdir a run dir for a typo'd id): a missing run gets a pointer to `runs list`; a
  // corrupt log a clear parse error — mirroring the --from-run guards above instead of failing deep
  // inside the resume fold. Runs BEFORE the preflight because a resume ADOPTS the run's recorded
  // harness when --harness wasn't re-passed — the preflight must check the harness that will
  // actually run, not the default (a CI/host without the default CLI would otherwise refuse to
  // resume a fake/codex run it can perfectly continue).
  // A resumed run continues with the LOG's effective config (header + any logged RUN_EXTENDED
  // overlays + this invocation's explicit extension), NOT this invocation's re-parsed defaults — so
  // the budget meter, best-of wiring, etc. match exactly what the resume fold will compute.
  let runConfig = followup.config;
  // The compile-phase authoring seed. On a fresh `--from-run` run it comes from the resolution
  // above; on `--resume` of a `--recontract` successor it is REBUILT from the header provenance (see
  // below) — the same root cause as the driver's dropped provenance: follow-up state only ever
  // arrived from the fresh CLI invocation, and `--from-run` cannot be combined with `--resume`.
  let followupSeed = followup.followupSeed;
  // The degraded-mode label the run was STARTED with (issue #125). The models a run uses are
  // re-resolved from every invocation's flags, so a resume can change which keys run; the label this
  // process reports must be reconciled against the recorded one exactly as the Driver reconciles the
  // header, or the terminal summary and `goaly runs show <id>` disagree about the same run.
  let recordedDegraded: DegradedMode | undefined;
  const resumeRunId = parsed.resumeRunId; // stable narrow (parsed is rebound on harness adoption)
  if (resumeRunId !== undefined) {
    const stateDir = path.join(parsed.workspace, STATE_DIR);
    const prior = await readRun(stateDir, resumeRunId);
    if (prior === null) {
      io.err(
        `goaly: --resume ${parsed.resumeRunId}: no such run in ${stateDir} — ` +
          `list runs with: goaly runs list --workspace ${parsed.workspace}\n`,
      );
      return { code: 2, runId: undefined, outcome: undefined };
    }
    if (!prior.ok) {
      io.err(`goaly: --resume ${parsed.resumeRunId}: run log is corrupt: ${prior.error}\n`);
      return { code: 2, runId: undefined, outcome: undefined };
    }
    // A resume continues the run's OWN harness unless `--harness` is explicitly re-passed: session
    // ids are harness-specific, so silently switching to the default CLI mid-run would thread the
    // prior harness's session (or sentinel) into a different tool and crash/derail every turn.
    if (
      !parsed.harnessExplicit &&
      prior.detail.harness !== undefined &&
      prior.detail.harness !== parsed.harness &&
      isHarnessChoice(prior.detail.harness)
    ) {
      io.err(
        `goaly: --resume: continuing with this run's harness '${prior.detail.harness}' ` +
          `(pass --harness to override)\n`,
      );
      // The LLM provider default FOLLOWS the harness; a derived (non-explicit) provider is
      // re-derived from the adopted harness so the preflight and the LLM steps track the harness
      // the resumed run will actually use.
      parsed = {
        ...parsed,
        harness: prior.detail.harness,
        ...(parsed.llmProviderExplicit
          ? {}
          : { llmProvider: defaultLlmProvider(prior.detail.harness) }),
      };
    }
    // Extending a DONE run is meaningless (both keys already turned) — route to the follow-up path.
    if (prior.detail.status === 'DONE' && parsed.resumeExtend !== undefined) {
      io.err(
        `goaly: --resume ${parsed.resumeRunId}: this run is DONE — there is nothing to extend. ` +
          `Build on it with: goaly "<follow-up goal>" --from-run ${parsed.resumeRunId}\n`,
      );
      return { code: 2, runId: undefined, outcome: undefined };
    }
    const stored = await new FileRunLog(path.join(stateDir, resumeRunId)).read();
    if (stored !== null) {
      recordedDegraded = stored.header.degraded;
      // Relieve any stuck streak the log has already banked (see `resumeStreakRelief`): without it
      // a run that ABORTED at the crash / unevaluable / repeat threshold re-aborts on the resume
      // fold before the harness gets a single turn, no matter what the operator just fixed. Merged
      // UNDER `parsed.resumeExtend` so an explicit `--stuck-*` on this command line still wins.
      const relief = resumeStreakRelief(stored.header.config, stored.entries);
      let extend = parsed.resumeExtend;
      if (Object.keys(relief).length > 0) {
        extend = { ...parsed.resumeExtend, stuck: { ...relief, ...parsed.resumeExtend?.stuck } };
        io.err(
          `goaly: --resume: relieving the stuck streak this run banked ` +
            `(${describeRelief(relief)}) — resuming is your signal that something changed, so the ` +
            `resumed run must earn a fresh streak before aborting again\n`,
        );
        // Rebound so the Driver persists the relief as a RUN_EXTENDED marker (auditable in the log).
        parsed = { ...parsed, resumeExtend: extend };
      }
      const effective = extendedRunConfig(stored.header.config, stored.entries);
      runConfig = extend !== undefined ? applyRunExtension(effective, extend) : effective;

      // ADR-0012 operator door (issue #116) — see `adjudicatedResumeWarning` for why the flag the
      // operator was told to pass cannot work here, and why the route named depends on the VERDICT.
      if (extend?.stuck?.repeatFailureThreshold !== undefined) {
        const warning = adjudicatedResumeWarning(stored.entries, resumeRunId);
        if (warning !== undefined) io.err(`${warning}\n`);
      }

      // Rebuild the compile-phase authoring seed from the HEADER: a resume that still has to
      // COMPILE (pre-freeze crash, or a Seal "revise" round) otherwise re-authors the bar with the
      // prior run — or the adjudicated defect — out of view. See `resumeAuthoringSeed`.
      followupSeed = resumeAuthoringSeed(stored.header, effective.goal, io.err) ?? followupSeed;
    }
  }

  // First-run preflight (fail-fast, before any spend): git repo present, harness / LLM-provider
  // CLI on PATH — the mistakes that used to surface only AFTER a compile + agent turn, as cryptic
  // spawn/plumbing errors. Cheap (milliseconds). On resume this runs AFTER the harness adoption
  // above, so it validates the harness the resumed run will actually use.
  {
    const problem = await preflightRun({
      harness: parsed.harness,
      llmProvider: parsed.llmProvider,
      workspace: parsed.workspace,
      workspaceMode: parsed.workspaceMode,
    });
    if (problem !== null) {
      io.err(`goaly: ${problem}\n`);
      return { code: 2, runId: undefined, outcome: undefined };
    }
  }

  // `--dry-run`: the LAST read-only point. Everything above validates (config merge, --cost-table,
  // --baseline resolution, --from-run/--resume log reads, preflight) and everything below MUTATES —
  // `acquireRunLock` mkdirs the run directory. Printing here means a dry run exercises exactly the
  // checks a real run would, with the same messages and the same exit code, and still writes nothing.
  if (parsed.dryRun) {
    // Display-only rebind: the dry run must show the baseline the real run would actually use,
    // including the autonomy auto-pin resolved above (annotated so the provenance is visible).
    const shown =
      autoPinnedBaseline !== undefined
        ? { ...parsed, baseline: `${autoPinnedBaseline} (auto-pinned: harness-autonomy ${parsed.harnessAutonomy})` }
        : parsed;
    io.out(renderResolvedConfig(shown, runConfig));
    return { code: 0, runId: undefined, outcome: undefined };
  }

  const resuming = parsed.resumeRunId !== undefined;
  const runId: RunId =
    parsed.resumeRunId !== undefined ? asRunId(parsed.resumeRunId) : asRunId(`run-${randomUUID()}`);

  // Exclusive per-run lock: two goaly processes appending to one run log would interleave duplicate
  // seq values and corrupt it logically. A crashed holder self-heals (stale-pid detection); a LIVE
  // holder refuses to start with a clear message (fail-closed, invariant #4).
  let runLock: RunLock;
  try {
    runLock = await acquireRunLock(path.join(parsed.workspace, STATE_DIR, runId));
  } catch (e) {
    if (e instanceof RunLockedError) {
      io.err(`goaly: ${e.message}\n`);
      return { code: 2, runId, outcome: undefined };
    }
    throw e;
  }
  io.onStarted?.(runId);

  // Start the egress proxy (issue #39) when the sandbox policy uses an allowlist. It's IO (a running
  // server), so it lives at the composition EDGE — started here, threaded into both jailed seams,
  // and ALWAYS torn down in the `finally` below (even if the run throws). Absent ⇒ no allowlist.
  let egressProxy: EgressProxy | undefined;
  const egressAllowlist = isAllowlist(parsed.sandbox.network)
    ? parsed.sandbox.network.allowlist
    : undefined;
  if (egressAllowlist !== undefined) {
    egressProxy = await startEgressProxy(egressAllowlist);
  }
  try {
    // Resolve the OpenAI-compatible bearer token from its env var (default OPENAI_API_KEY) at the
    // composition edge. A keyless local endpoint (ollama) leaves it unset — that's allowed.
    const llmApiKey = process.env[parsed.llmApiKeyEnv];

    let deps;
    try {
      deps = composeDeps(runConfig, {
        harness: parsed.harness,
        models: parsed.models,
        llmProvider: parsed.llmProvider,
        ...(parsed.harnessAutonomy !== undefined ? { harnessAutonomy: parsed.harnessAutonomy } : {}),
        workspaceRoot: parsed.workspace,
        workspaceMode: concreteWorkspaceMode,
        runId,
        ...(followupSeed !== undefined ? { followupSeed } : {}),
        ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
        ...(llmApiKey !== undefined ? { llmApiKey } : {}),
        ...(parsed.baseline !== undefined
          ? { baseline: parsed.baseline }
          : autoPinnedBaseline !== undefined
            ? { baseline: autoPinnedBaseline }
            : {}),
        ...(parsed.verifyDir !== undefined ? { verifyDir: parsed.verifyDir } : {}),
        // Cross-run defect corpus (issue #122) — wiring, like --verify-dir; fail-open downstream.
        defects: parsed.defects,
        ...(parsed.planFile !== undefined ? { planFile: parsed.planFile } : {}),
        logLevel: parsed.logLevel,
        timeouts: parsed.timeouts,
        ...(parsed.maxAgentTurns !== undefined ? { goalyCodeMaxTurns: parsed.maxAgentTurns } : {}),
        sandbox: parsed.sandbox,
        ...(egressProxy !== undefined ? { egressProxy } : {}),
        ...(parsed.logFile !== undefined ? { logFile: parsed.logFile } : {}),
        ...(parsed.noLogFile ? { noLogFile: true } : {}),
        ...(io.quietConsole === true ? { noLogConsole: true } : {}),
        ...(parsed.stream ? { stream: true } : {}),
        ...(parsed.explain ? { explain: true } : {}),
        ...(parsed.streamTranscript || io.forceStreamTranscript === true
          ? { streamTranscript: true }
          : {}),
        ...(parsed.streamFile !== undefined ? { streamFile: parsed.streamFile } : {}),
        ...(io.sealGate !== undefined ? { sealGate: io.sealGate } : {}),
        ...(io.planGate !== undefined ? { planGate: io.planGate } : {}),
        ...(io.onStreamEvent !== undefined ? { onStreamEvent: io.onStreamEvent } : {}),
      });
    } catch (e) {
      // Fail-closed (invariant #4): a requested sandbox mechanism that the host lacks REFUSES TO
      // START — a clear message and a non-zero exit, never a silent unsandboxed run.
      if (e instanceof SandboxUnavailableError) {
        io.err(`goaly: ${e.message}\n`);
        return { code: 2, runId, outcome: undefined };
      }
      // Fail-closed config error for `--harness goaly-code` / `--llm-provider openai` (missing base URL or
      // model): a clear message + non-zero exit, never a silent run pointing at nothing.
      if (e instanceof EndpointConfigError) {
        io.err(`goaly: ${e.message}\n`);
        return { code: 2, runId, outcome: undefined };
      }
      throw e;
    }

    // The per-seam models this run actually uses (issue #125): resolved ONCE here — with the LLM
    // provider, so the approver-independence default is applied — and reused for the loud notice
    // below, the degraded-mode label recorded in the run header, and the cost overlay at the end.
    // One resolution means the log, the header and the price report can never disagree.
    const resolvedModels = resolveModels(parsed.models, { llmProvider: parsed.llmProvider });
    const thisInvocationDegraded = degradedMode(
      resolvedModels,
      parsed.harness,
      parsed.llmProvider,
      {
        generate: runConfig.verifier.kind === 'generate',
        autonomous: runConfig.autonomous,
        approverQuorum: runConfig.approver.quorum,
        ...(resolvedModels.approverModels !== undefined
          ? { approverModels: resolvedModels.approverModels }
          : {}),
      },
    );
    // On a resume the run as a whole is as degraded as its WORST invocation: the earlier iterations
    // already ran with the wiring the header recorded, and a repaired wiring does not undo them.
    // The Driver applies the same rule to the header itself, so the two can never disagree.
    const degraded: DegradedMode | undefined = mostDegraded(
      recordedDegraded,
      thisInvocationDegraded,
    );

    // Human-facing startup banner, routed through the logger so it respects --log-level and lands
    // in the diagnostics file too. The run outcome below stays on stdout (the machine-facing result).
    // The runId + resume command are printed UP FRONT so a crash/Ctrl-C at any point leaves the
    // continuation path on screen (the headline resilience feature must be discoverable).
    deps.logger?.info('cli starting', {
      runId,
      resumeWith: `goaly --resume ${runId}${worktreeName !== undefined ? ` --worktree ${worktreeName}` : ''}`,
      watchWith: `goaly runs watch ${runId}${worktreeName !== undefined ? ` --workspace ${parsed.workspace}` : ''}`,
      harness: parsed.harness,
      ...(parsed.harnessAutonomy !== undefined ? { harnessAutonomy: parsed.harnessAutonomy } : {}),
      autonomous: parsed.config.autonomous,
      ...(parsed.configSources.length > 0 ? { configFile: parsed.configSources.join(', ') } : {}),
      ...(egressAllowlist !== undefined ? { egressAllowlist: egressAllowlist.join(', ') } : {}),
      ...startupFields(parsed),
    });

    // Non-fatal parse-time findings (e.g. a CLI --generate that overrode a config-file verify-cmd):
    // surfaced, never swallowed. `parseArgs` collects them because it has no output channel.
    for (const warning of parsed.warnings) {
      deps.logger?.warn(warning, {});
    }

    // Issue #125, part 1: the Sign-off approver declined to inherit the agent's `--model` and runs
    // on the LLM provider's own model instead. A silent model swap would be indistinguishable from
    // a bug — announce it every time, but ONLY claim independence where it is established. The
    // wording comes from `approverSwapNotice`, which branches on the same Independence value the
    // warnings below and the header's degraded label use, so the four diagnostics this run emits
    // about its second key can never contradict each other (they did: this line used to report
    // "the second key is a different model" between two INDEPENDENCE-UNVERIFIED warnings).
    const swapNotice = approverSwapNotice(resolvedModels, parsed.harness, parsed.llmProvider, {
      generate: runConfig.verifier.kind === 'generate',
      autonomous: runConfig.autonomous,
      ...(resolvedModels.approverModels !== undefined
        ? { approverModels: resolvedModels.approverModels }
        : {}),
    });
    if (swapNotice !== undefined) {
      deps.logger?.info(swapNotice, {
        runId,
        approverModel: 'provider default',
        agentModel: resolvedModels.approverIndependentFrom,
      });
    }
    // Issue #125, part 2: a FULLY collapsed model configuration (agent = judge = approver) is a
    // typed degraded mode, recorded in the run header — a WARN alone cannot reach an operator who
    // ran with --autonomous precisely so nobody had to watch.
    if (degraded !== undefined) {
      deps.logger?.warn(`degraded mode: ${degradedModeTag(degraded)}`, {
        runId,
        detail: degradedModeDetail(degraded),
      });
    }

    // Raising harness autonomy buys installs/builds at the cost of the orchestrator's HEAD-relative
    // diff: above the least-privilege tier the agent can `git commit`, which empties `git diff HEAD`
    // and hides work from BOTH keys (the judge and the Sign-off approver). goaly therefore AUTO-PINS
    // the review baseline to the run-start commit (resolved above) — loudly, so the operator knows
    // which diff the keys review. Only an unpinnable tree (unborn HEAD) or a resume of a run that
    // predates baseline recording is left with the manual --baseline advice.
    if (parsed.harnessAutonomy !== undefined && parsed.harnessAutonomy !== 'low') {
      const level = parsed.harnessAutonomy;
      if (autoPinnedBaseline !== undefined) {
        deps.logger?.info(
          `harness autonomy raised to '${level}' — the agent may now run git/installs/builds. ` +
            `Review baseline auto-pinned to the run-start commit (${autoPinnedBaseline.slice(0, 12)}) so an ` +
            'agent `git commit` stays visible to the judge and the Sign-off approver; ' +
            'override with --baseline <ref>.',
          { harness: parsed.harness, harnessAutonomy: level, baseline: autoPinnedBaseline },
        );
      } else if (parsed.baseline !== undefined) {
        deps.logger?.info(
          `harness autonomy raised to '${level}' — the agent may now run git/installs/builds. ` +
            `The judge and the Sign-off approver review the diff against --baseline ${parsed.baseline}, ` +
            'so an agent `git commit` stays visible.',
          { harness: parsed.harness, harnessAutonomy: level, baseline: parsed.baseline },
        );
      } else if (resuming) {
        deps.logger?.info(
          `harness autonomy raised to '${level}' — the agent may now run git/installs/builds. ` +
            'The resumed run re-adopts the review baseline it recorded at run start (older logs ' +
            'without one fall back to HEAD — pin with --baseline <ref> then).',
          { harness: parsed.harness, harnessAutonomy: level },
        );
      } else {
        deps.logger?.warn(
          `harness autonomy raised to '${level}' — the agent may now run git/installs/builds. ` +
            'The review baseline could not be auto-pinned (no resolvable HEAD in this tree), so a ' +
            '`git commit` from the agent empties `git diff HEAD` and the judge and Sign-off approver ' +
            'would review an empty diff; pin with --baseline <ref> once a commit exists.',
          { harness: parsed.harness, harnessAutonomy: level },
        );
      }
    }

    // Natural-language delegation is a GOAL/NOTE REWRITE, so it must be loudly auditable: name the
    // matched phrase and what it was mapped to (or that the explicit flag won) every time.
    if (parsed.delegation !== undefined) {
      deps.logger?.info(
        parsed.delegation.overriddenByFlag
          ? 'delegation directive found but --candidates wins (directive still stripped)'
          : 'delegation directive interpreted — running the best-of-N tournament',
        {
          runId,
          phrase: parsed.delegation.phrase,
          candidates: parsed.delegation.overriddenByFlag
            ? runConfig.candidates
            : parsed.delegation.candidates,
        },
      );
    }

    // Cooperative stop: an injected probe (the UI's stop button) is used as-is — the embedding
    // process owns its signals. Otherwise install the classic Ctrl-C controller around drive().
    const interrupt =
      io.interrupted !== undefined
        ? { interrupted: io.interrupted, onSignal: undefined }
        : makeInterruptController(runId, io.err);

    let outcome;
    try {
      if (interrupt.onSignal !== undefined) {
        process.on('SIGINT', interrupt.onSignal);
        process.on('SIGTERM', interrupt.onSignal);
      }
      outcome = await drive(
        { ...deps, interrupted: interrupt.interrupted },
        runConfig,
        runId,
        {
          resume: resuming,
          harness: parsed.harness,
          ...(degraded !== undefined ? { degraded } : {}),
          ...(parsed.resumeExtend !== undefined ? { extend: parsed.resumeExtend } : {}),
          ...(followup.provenance !== undefined ? { provenance: followup.provenance } : {}),
          ...(followup.followup !== undefined ? { followup: followup.followup } : {}),
        },
      );
    } finally {
      if (interrupt.onSignal !== undefined) {
        process.removeListener('SIGINT', interrupt.onSignal);
        process.removeListener('SIGTERM', interrupt.onSignal);
      }
    }

    // Surface the egress audit trail: any denied host:port the jail tried to reach (issue #39).
    if (egressProxy !== undefined && egressProxy.denied.length > 0) {
      deps.logger?.warn('sandbox egress denied', {
        count: egressProxy.denied.length,
        sample: [...new Set(egressProxy.denied)].slice(0, 8).join(', '),
      });
    }

    const cost =
      priceTable !== undefined && outcome.usage !== undefined
        ? computeCost(outcome.usage, resolvedModels, priceTable)
        : undefined;
    // Capability A: append "Continue this session:" with the harness-correct interactive-resume
    // command (or the goaly-code → --from-run route). Stays quiet when there is no real session.
    const hint = resumeHint(parsed.harness, outcome.sessionId, runId);
    io.out(`${formatOutcome(outcome, cost, hint, degraded)}\n`);
    if (outcome.status === 'DONE') return { code: 0, runId, outcome };
    return { code: interrupt.interrupted() ? EXIT_INTERRUPTED : 1, runId, outcome };
  } finally {
    await egressProxy?.close();
    await runLock.release();
  }
}

/**
 * Human-readable summary of a {@link resumeStreakRelief} overlay, for the one-line notice the resume
 * path prints. Names each raised threshold and its new value so the relief is auditable on screen,
 * not just in the log's RUN_EXTENDED marker.
 */
function describeRelief(relief: NonNullable<RunExtension['stuck']>): string {
  const parts: string[] = [];
  if (relief.harnessCrashThreshold !== undefined) {
    parts.push(`--stuck-crash-threshold ${relief.harnessCrashThreshold}`);
  }
  if (relief.unevaluableThreshold !== undefined) {
    parts.push(`--stuck-unevaluable-threshold ${relief.unevaluableThreshold}`);
  }
  if (relief.repeatFailureThreshold !== undefined) {
    parts.push(`--stuck-repeat-threshold ${relief.repeatFailureThreshold}`);
  }
  return parts.join(', ');
}

/**
 * The warning for `--resume <id> --stuck-repeat-threshold N` on a run that ADJUDICATED its contract
 * in-loop (issue #116) — and the route that actually exists, chosen by the VERDICT.
 *
 * Why the flag cannot work, for either verdict: an adjudicated run ends on a RECORDED
 * `CONTRACT_ADJUDICATED` event. Replay folds that event and lands on ABORTED no matter what the
 * stuck thresholds say, so no `--resume` extension un-terminates it. (A plain repeat abort ends on a
 * re-derived detector trip, which is why the same flag genuinely continues THAT run.)
 *
 * Why the route differs: `planRecontract` guard 1 accepts a `defective: true` verdict — the bar is
 * the thing to replace — and REFUSES a `defective: false` one, whose whole meaning is that the bar
 * is fine. Pointing a sound-verdict run at `--recontract` (as this warning used to, unconditionally)
 * named a command that refuses it, closing the last exit. A sound verdict keeps the tree and carries
 * the goal forward with `--from-run`.
 */
export function adjudicatedResumeWarning(
  entries: readonly RunLogEntry[],
  runId: string,
): string | undefined {
  const verdict = adjudicationVerdict(entries);
  if (verdict === undefined) return undefined;
  const head =
    `goaly: --resume: this run's contract was already adjudicated in-loop, so ` +
    `--stuck-repeat-threshold does not continue it — the recorded adjudication replays as it ` +
    `happened, and the run re-terminates before the harness gets a turn.`;
  if (verdict === 'defective') {
    return `${head} The bar itself was judged unsatisfiable, so more iterations against it cannot help; re-contract instead: ${recontractCommand(runId)}`;
  }
  return `${head} The bar was judged SATISFIABLE, so --recontract refuses this run (there is no defect to repair). Keep the tree and carry the goal forward: goaly "<goal>" --from-run ${runId}`;
}

/**
 * A one-line, always-on "what do I do now" for the common terminal reasons — the zero-cost,
 * non-LLM complement to `--explain`. A first-time user seeing `status: ABORTED / reason: no-diff:
 * working tree unchanged…` should not need to read the architecture docs to know the next step.
 * Matched on the typed reason prefixes/tags the reducer and stuck detectors emit (`no-diff`,
 * `oscillation`, `STUCK_HARNESS_CRASH`, `STUCK_TIMEOUT_NO_DIFF`, `CONTRACT_DEFECTIVE`, …); an
 * unknown reason gets no hint.
 *
 * Matched against {@link hintSubject}, NOT the raw reason. An abort reason quotes worker-steerable
 * text (the repeated verifier signature, the adjudicator's prose, the harness's stderr), and the
 * generic rows below are plain substrings — so a test named `handles no-diff` inside an adjudicated
 * run's signature used to hijack the hint and point the operator at `--stuck-no-diff false`, which
 * provably cannot continue that run (an adjudicated abort is folded from a RECORDED event; no
 * threshold un-terminates it). Reading only goaly's own words closes that; the typed-marker rows are
 * additionally ordered ahead of the generic ones so the marker always wins on its own reason.
 */
export function nextStepHint(o: RunOutcome): string | undefined {
  const reason = hintSubject(o.reason ?? '');
  const inspect = `inspect with: goaly runs show ${o.runId}`;
  const resume = `goaly --resume ${o.runId}`;
  if (o.status === 'DONE' || reason.length === 0) return undefined;
  if (reason.includes('interrupted by user')) return undefined; // the reason already says how to resume
  // Every "…and continue" hint names the EXACT extension flag: a terminal run replays back to the
  // same terminal state on a plain resume — only a --resume extension (ADR 0012) un-terminates it.
  const table: readonly (readonly [RegExp, string])[] = [
    // A harness that REFUSED an action (droid at `--auto low`) is not a crashing CLI: the reason
    // already carries goaly's own `autonomy-refused` remediation (the codec named only the kind —
    // see REMEDIATION_ADVICE in `src/orchestrator/stuck.ts`), so this row matches goaly-authored
    // words, points at the autonomy flag rather than install/auth, and at a plain resume rather
    // than at raising the crash threshold.
    [/STUCK_HARNESS_CRASH[\s\S]*autonomy level/, `the harness refused an action at its autonomy level — raise it and continue: ${resume} --harness-autonomy medium`],
    [/STUCK_HARNESS_CRASH/, `the agent CLI kept crashing — run it once by hand to check install/auth, then continue: ${resume} --stuck-crash-threshold 4`],
    [/CONTRACT_UNEVALUABLE/, `the verification could not RUN (environment problem, not a code red) — fix the tool/network it names, then continue: ${resume} --stuck-unevaluable-threshold 4`],
    // Matched BEFORE the generic /no-diff/ row: the tree stopped changing because the turn kept
    // being killed, so the fix is more room per turn, not `--stuck-no-diff false`.
    // --harness-timeout-ms / --harness-idle-timeout-ms are NOT RunExtension fields, so a resume
    // carrying only them produces no extension, the fold re-trips the detector at the tail, and the
    // run lands back in the identical terminal ABORTED with zero turns run. The threshold is what
    // un-terminates it; the timeouts are what make the extra turns worth having.
    [/STUCK_TIMEOUT_NO_DIFF/, `the agent kept being killed by the harness timeout with nothing to show — give a turn more room and continue: ${resume} --stuck-timeout-no-diff-threshold 4 --harness-timeout-ms 1800000 --harness-idle-timeout-ms 300000`],
    [/TOOLS_MISSING/, `install the tools named above (or rerun with --install-missing-tools true)`],
    [/SETUP_FAILED/, `fix the setup command, or override it with --setup-cmd / disable it with --no-setup`],
    [/CONTRACT_UNSOUND/, `the frozen verification itself is broken on this tree — start a fresh run with a corrected goal or an explicit --verify-cmd`],
    // Matched BEFORE the repeat-failure row (issue #116): a CONTRACT_DEFECTIVE reason CONTAINS the
    // repeat-failure text as context, and raising --stuck-repeat-threshold cannot help against a bar
    // no implementation can satisfy. The tree is worth keeping, so point at a fresh contract over the
    // SAME workspace, not at more iterations.
    [/CONTRACT_DEFECTIVE/, `the frozen bar itself was adjudicated defective — your tree may be correct, so KEEP it and re-contract: ${recontractCommand(o.runId)} (re-authors the bar from the defect report, keeps the tree, freezes a NEW contract under a NEW run id). Or own the bar yourself: goaly "<goal>" --from-run ${o.runId} --verify-cmd "<a check that is actually satisfiable>", or ${inspect}`],
    // Matched BEFORE the repeat-failure row: an adjudicated-SOUND run ends on a RECORDED event, so
    // --stuck-repeat-threshold (that row's advice) cannot un-terminate it.
    [new RegExp(CONTRACT_SOUND_MARKER), `the bar was adjudicated SATISFIABLE, so the tree simply has not met it yet — and the recorded adjudication ends THIS run whatever the thresholds say. Keep the tree and carry the goal forward: goaly "<goal>" --from-run ${o.runId}, or ${inspect}`],
    [/STUCK_REPEATED_FAILURE|identical .*failures/, `the same verifier failure repeated — steer it: ${resume} --stuck-repeat-threshold 6 --note "<hint>", or ${inspect}`],
    // ── Generic substring rows LAST ────────────────────────────────────────────────────────────
    // Everything above keys off a marker goaly itself emits; these match ordinary English that a
    // typed reason may also happen to contain, so they only get a say once no marker matched.
    [/budget exceeded/, `raise the cap and continue: ${resume} --budget-tokens <N> (or --budget-wall-ms <N>)`],
    [/reached maxIterations/, `continue with more room: ${resume} --max-iterations <N> --note "<guidance>", or ${inspect}`],
    [/no-diff/, `the agent stopped changing the tree — steer it: ${resume} --stuck-no-diff false --note "<hint>", or refine the goal in a follow-up: --from-run ${o.runId}`],
    [/oscillation/, `the agent is flip-flopping between two states — ${inspect}; steer it: ${resume} --stuck-oscillation false --note "<which way to go>"`],
    [/compile failed|PLAN_FAILED|plan failed/i, `the contract/plan could not be authored — check the --llm-provider CLI runs & is authenticated, then retry`],
  ];
  for (const [pattern, hint] of table) if (pattern.test(reason)) return hint;
  return undefined;
}

export function formatOutcome(
  o: RunOutcome,
  cost?: CostView,
  resume?: ResumeHint,
  degraded?: DegradedMode,
): string {
  const lines = [
    '',
    `── goaly run ${o.runId} ──`,
    `status:      ${o.status}`,
    `iterations:  ${o.iterations}`,
    `contract:    ${o.contractHash ?? '(none — failed before compile)'}`,
  ];
  // Issue #125: the typed degraded-mode label rides WITH the status, so a DONE whose two keys were
  // one model is never reported as an independently reviewed one. A label, never a gate.
  if (degraded !== undefined) {
    lines.push(`degraded:    ${degradedModeTag(degraded)} — ${degradedModeDetail(degraded)}`);
  }
  if (o.reason !== undefined) lines.push(`reason:      ${o.reason}`);
  const hint = nextStepHint(o);
  if (hint !== undefined) lines.push(`next:        ${hint}`);
  if (o.usage !== undefined) lines.push(...formatUsage(o.usage, cost));
  // Capability A end-of-run banner: only printed when there is something useful to continue with
  // (a real interactive-resume command, or the goaly-code follow-up route). Quiet otherwise.
  if (resume !== undefined) {
    const hintLines = renderResumeHint(resume);
    if (hintLines.length > 0) {
      lines.push('', 'Continue this session:', ...hintLines.map((l) => `  ${l}`));
    }
  }
  return lines.join('\n');
}
