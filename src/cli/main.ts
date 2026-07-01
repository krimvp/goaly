import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs, USAGE, UsageError, type ParsedArgs } from './args';
import { composeDeps, STATE_DIR, EndpointConfigError } from './compose';
import { SandboxUnavailableError, isAllowlist, startEgressProxy, type EgressProxy } from '../sandbox';
import { runRuns } from './runs';
import { drive } from '../driver/driver';
import { refResolves } from '../workspace/git-workspace';
import { asRunId, type RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';
import type { RunConfig } from '../domain/config';
import { readRun } from '../runlog/inspect';
import { acquireRunLock, RunLockedError, type RunLock } from '../runlog/lock';
import { killActiveChildren } from '../util/spawn';
import { compactRun } from '../followup/compaction';
import { resumeHint, renderResumeHint, type ResumeHint } from './resume-cmd';
import { resolveModels } from './models';
import { parsePriceTable, computeCost, type CostView, type PriceTable } from './cost';
import { formatUsage } from './usage-format';

/** The model/provider flags the user actually set, as structured log fields (set ones only). */
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
 * Resolve the follow-up wiring (Capability C, `--from-run`). Returns the run config (possibly with an
 * inherited session seed) and the prior-run compaction to feed the compiler, or a fail-closed exit
 * code after writing a clear message. A normal run (no `--from-run`) passes through unchanged.
 */
type FollowupResolution =
  | { readonly ok: true; readonly config: RunConfig; readonly followupSeed: string | undefined }
  | { readonly ok: false; readonly code: number };

async function resolveFollowup(
  parsed: ParsedArgs,
  warn: (s: string) => void,
): Promise<FollowupResolution> {
  if (parsed.fromRunId === undefined) {
    // --inherit-session is meaningless without --from-run; fail closed rather than silently ignore.
    if (parsed.inheritSession) {
      warn('goaly: --inherit-session requires --from-run <runId>\n');
      return { ok: false, code: 2 };
    }
    return { ok: true, config: parsed.config, followupSeed: undefined };
  }
  if (parsed.resumeRunId !== undefined) {
    warn('goaly: --from-run starts a NEW run and cannot be combined with --resume\n');
    return { ok: false, code: 2 };
  }

  const stateDir = path.join(parsed.workspace, STATE_DIR);
  const prior = await readRun(stateDir, parsed.fromRunId);
  if (prior === null) {
    warn(`goaly: --from-run ${parsed.fromRunId}: no such run in ${stateDir}\n`);
    return { ok: false, code: 2 };
  }
  if (!prior.ok) {
    warn(`goaly: --from-run ${parsed.fromRunId}: run log is corrupt: ${prior.error}\n`);
    return { ok: false, code: 2 };
  }
  const followupSeed = compactRun(prior.detail);

  // Session inheritance (opt-in). Cross-harness is invalid (session ids are harness-specific) → hard
  // error; a no-op under --phased; a prior run with no recoverable session degrades to fresh (the
  // compaction still applies). Otherwise seed the new config so the first turn resumes the prior session.
  let config = parsed.config;
  if (parsed.inheritSession) {
    if (parsed.config.phased) {
      warn('goaly: --inherit-session is ignored under --phased (using fresh session + compaction)\n');
    } else if (prior.detail.harness !== undefined && prior.detail.harness !== parsed.harness) {
      warn(
        `goaly: --inherit-session needs the same harness as the prior run ` +
          `(prior=${prior.detail.harness}, now=${parsed.harness}); session ids are harness-specific\n`,
      );
      return { ok: false, code: 2 };
    } else if (prior.detail.sessionId === undefined) {
      warn(
        'goaly: --inherit-session: the prior run recorded no resumable session — ' +
          'starting fresh (the compaction still applies)\n',
      );
    } else {
      config = { ...parsed.config, seedSessionId: prior.detail.sessionId };
    }
  }
  return { ok: true, config, followupSeed };
}

/**
 * Graceful-interrupt wiring (Ctrl-C / SIGTERM). The FIRST signal requests a cooperative stop: the
 * Driver finishes the in-flight step (its event lands write-ahead) and resolves to a typed ABORTED
 * with the resume command — nothing is lost and the user is told exactly how to continue. A SECOND
 * signal force-exits (130) after reaping any live child process groups (a group-spawned agent CLI
 * does not share the terminal's process group, so without the sweep it would outlive goaly and
 * keep editing/spending). Exposed for tests; `main` installs/removes it around `drive()`.
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

/** Exit code for a run stopped by Ctrl-C/SIGTERM (128 + SIGINT), distinct from FAILED/ABORTED (1). */
const EXIT_INTERRUPTED = 130;

/**
 * CLI entry. Returns a process exit code (0 = DONE, 1 = FAILED/ABORTED, 2 = usage error,
 * 130 = interrupted) so the thin bin launcher stays trivial and `main` is unit-testable.
 */
export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = await parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }

  if (parsed.command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (parsed.command === 'runs' && parsed.runs !== undefined) {
    const stateDir = path.join(parsed.workspace, STATE_DIR);
    return runRuns(
      parsed.runs,
      stateDir,
      (s) => process.stdout.write(s),
      (s) => process.stderr.write(s),
    );
  }

  // Load the optional cost table BEFORE the run so a malformed table fails fast (never mid-run).
  let priceTable: PriceTable | undefined;
  if (parsed.costTablePath !== undefined) {
    try {
      priceTable = parsePriceTable(await readFile(parsed.costTablePath, 'utf8'));
    } catch (e) {
      process.stderr.write(
        `--cost-table ${parsed.costTablePath}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }
  }

  // Validate --baseline (issue #47) fail-closed BEFORE the run starts: an unknown ref refuses to
  // start rather than silently degrading the diff (invariant #6, parse at the seam). On resume the
  // baseline is reconstructed from the log instead, so the flag is moot then.
  if (parsed.baseline !== undefined && parsed.resumeRunId === undefined) {
    if (!(await refResolves(parsed.workspace, parsed.baseline))) {
      process.stderr.write(
        `--baseline ${parsed.baseline}: not a resolvable git ref in ${parsed.workspace}\n\n${USAGE}\n`,
      );
      return 2;
    }
  }

  // Capability C (`--from-run`): recover the prior run, build its compaction, and (with
  // --inherit-session) seed the session. A normal run passes through unchanged.
  const followup = await resolveFollowup(parsed, (s) => process.stderr.write(s));
  if (!followup.ok) return followup.code;
  const runConfig = followup.config;

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
      process.stderr.write(`goaly: ${e.message}\n`);
      return 2;
    }
    throw e;
  }

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
        workspaceRoot: parsed.workspace,
        runId,
        ...(followup.followupSeed !== undefined ? { followupSeed: followup.followupSeed } : {}),
        ...(parsed.baseUrl !== undefined ? { baseUrl: parsed.baseUrl } : {}),
        ...(llmApiKey !== undefined ? { llmApiKey } : {}),
        ...(parsed.baseline !== undefined ? { baseline: parsed.baseline } : {}),
        ...(parsed.verifyDir !== undefined ? { verifyDir: parsed.verifyDir } : {}),
        ...(parsed.planFile !== undefined ? { planFile: parsed.planFile } : {}),
        logLevel: parsed.logLevel,
        timeouts: parsed.timeouts,
        ...(parsed.maxAgentTurns !== undefined ? { goalyCodeMaxTurns: parsed.maxAgentTurns } : {}),
        sandbox: parsed.sandbox,
        ...(egressProxy !== undefined ? { egressProxy } : {}),
        ...(parsed.logFile !== undefined ? { logFile: parsed.logFile } : {}),
        ...(parsed.noLogFile ? { noLogFile: true } : {}),
        ...(parsed.stream ? { stream: true } : {}),
        ...(parsed.explain ? { explain: true } : {}),
        ...(parsed.streamTranscript ? { streamTranscript: true } : {}),
        ...(parsed.streamFile !== undefined ? { streamFile: parsed.streamFile } : {}),
      });
    } catch (e) {
      // Fail-closed (invariant #4): a requested sandbox mechanism that the host lacks REFUSES TO
      // START — a clear message and a non-zero exit, never a silent unsandboxed run.
      if (e instanceof SandboxUnavailableError) {
        process.stderr.write(`goaly: ${e.message}\n`);
        return 2;
      }
      // Fail-closed config error for `--harness goaly-code` / `--llm-provider openai` (missing base URL or
      // model): a clear message + non-zero exit, never a silent run pointing at nothing.
      if (e instanceof EndpointConfigError) {
        process.stderr.write(`goaly: ${e.message}\n`);
        return 2;
      }
      throw e;
    }

    // Human-facing startup banner, routed through the logger so it respects --log-level and lands
    // in the diagnostics file too. The run outcome below stays on stdout (the machine-facing result).
    // The runId + resume command are printed UP FRONT so a crash/Ctrl-C at any point leaves the
    // continuation path on screen (the headline resilience feature must be discoverable).
    deps.logger?.info('cli starting', {
      runId,
      resumeWith: `goaly --resume ${runId}`,
      harness: parsed.harness,
      autonomous: parsed.config.autonomous,
      ...(parsed.configSources.length > 0 ? { configFile: parsed.configSources.join(', ') } : {}),
      ...(egressAllowlist !== undefined ? { egressAllowlist: egressAllowlist.join(', ') } : {}),
      ...startupFields(parsed),
    });

    // Graceful interrupt: first Ctrl-C stops between steps (clean ABORTED + resume hint); second
    // force-exits. Installed only around the run itself, and always removed in the finally below.
    const interrupt = makeInterruptController(runId, (s) => process.stderr.write(s));
    process.on('SIGINT', interrupt.onSignal);
    process.on('SIGTERM', interrupt.onSignal);

    let outcome;
    try {
      outcome = await drive(
        { ...deps, interrupted: interrupt.interrupted },
        runConfig,
        runId,
        { resume: resuming, harness: parsed.harness },
      );
    } finally {
      process.removeListener('SIGINT', interrupt.onSignal);
      process.removeListener('SIGTERM', interrupt.onSignal);
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
        ? computeCost(outcome.usage, resolveModels(parsed.models), priceTable)
        : undefined;
    // Capability A: append "Continue this session:" with the harness-correct interactive-resume
    // command (or the goaly-code → --from-run route). Stays quiet when there is no real session.
    const hint = resumeHint(parsed.harness, outcome.sessionId, runId);
    process.stdout.write(`${formatOutcome(outcome, cost, hint)}\n`);
    if (outcome.status === 'DONE') return 0;
    return interrupt.interrupted() ? EXIT_INTERRUPTED : 1;
  } finally {
    await egressProxy?.close();
    await runLock.release();
  }
}

export function formatOutcome(o: RunOutcome, cost?: CostView, resume?: ResumeHint): string {
  const lines = [
    '',
    `── goaly run ${o.runId} ──`,
    `status:      ${o.status}`,
    `iterations:  ${o.iterations}`,
    `contract:    ${o.contractHash ?? '(none — failed before compile)'}`,
  ];
  if (o.reason !== undefined) lines.push(`reason:      ${o.reason}`);
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
