import type { ParsedArgs } from './args';
import type { RunId } from '../domain/ids';
import type { RunConfig } from '../domain/config';
import type { Logger } from '../log/logger';
import type { ResolvedModels } from './models';
import { approverSwapNotice } from './independence';
import { degradedModeDetail, degradedModeTag, type DegradedMode } from '../domain/degraded';

/**
 * The startup diagnostics of a `goaly run`: the banner and every loud notice about how THIS run is
 * wired (parse warnings, the approver model swap, the degraded label, the review baseline under
 * raised autonomy, the delegation rewrite). Pure logging — no control flow, no IO of its own —
 * routed through the run logger so it respects --log-level and lands in the diagnostics file too.
 */
export type StartupContext = {
  readonly parsed: ParsedArgs;
  readonly runId: RunId;
  readonly worktreeName: string | undefined;
  readonly egressAllowlist: readonly string[] | undefined;
  readonly runConfig: RunConfig;
  readonly resolvedModels: ResolvedModels;
  readonly degraded: DegradedMode | undefined;
  readonly autoPinnedBaseline: string | undefined;
  readonly resuming: boolean;
};

export function logStartupDiagnostics(logger: Logger | undefined, ctx: StartupContext): void {
  if (logger === undefined) return;
  logBanner(logger, ctx);
  logIndependence(logger, ctx);
  logAutonomyBaseline(logger, ctx);
  logDelegation(logger, ctx);
}

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
 * Human-facing startup banner. The run outcome stays on stdout (the machine-facing result). The
 * runId + resume command are printed UP FRONT so a crash/Ctrl-C at any point leaves the
 * continuation path on screen (the headline resilience feature must be discoverable).
 */
function logBanner(logger: Logger, { parsed, runId, worktreeName, egressAllowlist }: StartupContext): void {
  logger.info('cli starting', {
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
    logger.warn(warning, {});
  }
}

function logIndependence(
  logger: Logger,
  { parsed, runId, runConfig, resolvedModels, degraded }: StartupContext,
): void {
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
    logger.info(swapNotice, {
      runId,
      approverModel: 'provider default',
      agentModel: resolvedModels.approverIndependentFrom,
    });
  }
  // Issue #125, part 2: a FULLY collapsed model configuration (agent = judge = approver) is a
  // typed degraded mode, recorded in the run header — a WARN alone cannot reach an operator who
  // ran with --autonomous precisely so nobody had to watch.
  if (degraded !== undefined) {
    logger.warn(`degraded mode: ${degradedModeTag(degraded)}`, {
      runId,
      detail: degradedModeDetail(degraded),
    });
  }
}

/**
 * Raising harness autonomy buys installs/builds at the cost of the orchestrator's HEAD-relative
 * diff: above the least-privilege tier the agent can `git commit`, which empties `git diff HEAD`
 * and hides work from BOTH keys (the judge and the Sign-off approver). goaly therefore AUTO-PINS
 * the review baseline to the run-start commit (resolved in `prepareRun`) — loudly, so the operator
 * knows which diff the keys review. Only an unpinnable tree (unborn HEAD) or a resume of a run that
 * predates baseline recording is left with the manual --baseline advice.
 */
function logAutonomyBaseline(
  logger: Logger,
  { parsed, autoPinnedBaseline, resuming }: StartupContext,
): void {
  if (parsed.harnessAutonomy === undefined || parsed.harnessAutonomy === 'low') return;
  const level = parsed.harnessAutonomy;
  const raised = `harness autonomy raised to '${level}' — the agent may now run git/installs/builds. `;
  if (autoPinnedBaseline !== undefined) {
    logger.info(
      raised +
        `Review baseline auto-pinned to the run-start commit (${autoPinnedBaseline.slice(0, 12)}) so an ` +
        'agent `git commit` stays visible to the judge and the Sign-off approver; ' +
        'override with --baseline <ref>.',
      { harness: parsed.harness, harnessAutonomy: level, baseline: autoPinnedBaseline },
    );
  } else if (parsed.baseline !== undefined) {
    logger.info(
      raised +
        `The judge and the Sign-off approver review the diff against --baseline ${parsed.baseline}, ` +
        'so an agent `git commit` stays visible.',
      { harness: parsed.harness, harnessAutonomy: level, baseline: parsed.baseline },
    );
  } else if (resuming) {
    logger.info(
      raised +
        'The resumed run re-adopts the review baseline it recorded at run start (older logs ' +
        'without one fall back to HEAD — pin with --baseline <ref> then).',
      { harness: parsed.harness, harnessAutonomy: level },
    );
  } else {
    logger.warn(
      raised +
        'The review baseline could not be auto-pinned (no resolvable HEAD in this tree), so a ' +
        '`git commit` from the agent empties `git diff HEAD` and the judge and Sign-off approver ' +
        'would review an empty diff; pin with --baseline <ref> once a commit exists.',
      { harness: parsed.harness, harnessAutonomy: level },
    );
  }
}

/**
 * Natural-language delegation is a GOAL/NOTE REWRITE, so it must be loudly auditable: name the
 * matched phrase and what it was mapped to (or that the explicit flag won) every time.
 */
function logDelegation(logger: Logger, { parsed, runId, runConfig }: StartupContext): void {
  if (parsed.delegation === undefined) return;
  logger.info(
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
