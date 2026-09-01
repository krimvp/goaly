import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { USAGE, defaultLlmProvider, isHarnessChoice, type ParsedArgs } from './args';
import { resolveFollowup, resumeAuthoringSeed, type FollowupResolution } from './followup-wiring';
import { STATE_DIR } from './compose';
import { refResolves, resolveRef } from '../workspace/git-workspace';
import type { RunConfig } from '../domain/config';
import { readRun } from '../runlog/inspect';
import type { RunLogEntry, RunLogHeader } from '../runlog/runlog';
import { FileRunLog } from '../runlog/file-runlog';
import {
  effectiveDegraded,
  extendedRunConfig,
  applyRunExtension,
  resumeStreakRelief,
} from '../runlog/replay';
import { renderResolvedConfig } from './dry-run';
import { detectWorkspaceMode, preflightRun } from './preflight';
import type { DegradedMode } from '../domain/degraded';
import { parsePriceTable, type PriceTable } from './cost';
import { adjudicatedResumeWarning, describeRelief } from './run-report';

/**
 * The READ-ONLY head of the `goaly run` path (ADR 0015): everything that validates or resolves
 * before the first mutation (`acquireRunLock` mkdirs the run directory) — the cost table, the
 * workspace mode, `--baseline`, the follow-up seed, the resume log, the preflight, and the
 * `--dry-run` print. Split out of `run-cmd.ts` so the guards read as one list and the run body
 * starts at the first side effect.
 */

/** A prepared run, or an exit: `ok: false` means "print nothing more, exit with `code`" — the dry run exits 0. */
export type PrepareResult = PreparedRun | { readonly ok: false; readonly code: number };

export type PreparedRun = {
  readonly ok: true;
  /** REBOUND on resume (harness adoption, streak relief) — the run must use this, not its input. */
  readonly parsed: ParsedArgs;
  readonly priceTable: PriceTable | undefined;
  readonly concreteWorkspaceMode: 'git' | 'file';
  readonly autoPinnedBaseline: string | undefined;
  readonly followup: Extract<FollowupResolution, { ok: true }>;
  readonly runConfig: RunConfig;
  readonly followupSeed: string | undefined;
  readonly recordedDegraded: DegradedMode | undefined;
};

type ResumeResolution =
  | {
      readonly ok: true;
      readonly parsed: ParsedArgs;
      readonly runConfig: RunConfig;
      readonly followupSeed: string | undefined;
      readonly recordedDegraded: DegradedMode | undefined;
    }
  | { readonly ok: false; readonly code: number };

type StoredLog = { header: RunLogHeader; entries: RunLogEntry[] };

export async function prepareRun(
  parsed: ParsedArgs,
  io: { out: (s: string) => void; err: (s: string) => void },
): Promise<PrepareResult> {
  const table = await loadPriceTable(parsed, io.err);
  if (!table.ok) return table;

  // Resolve the concrete workspace mode early so git-specific validations can be skipped in
  // file-mode runs.
  const concreteWorkspaceMode =
    parsed.workspaceMode === 'auto'
      ? await detectWorkspaceMode(parsed.workspace)
      : parsed.workspaceMode;

  const baseline = await checkBaseline(parsed, concreteWorkspaceMode, io.err);
  if (!baseline.ok) return baseline;

  // Capability C (`--from-run`): recover the prior run, build its compaction, and (with
  // --inherit-session) seed the session. A normal run passes through unchanged.
  const followup = await resolveFollowup(parsed, io.err);
  if (!followup.ok) return { ok: false, code: followup.code };

  const resumed = await resolveResume(parsed, followup, io.err);
  if (!resumed.ok) return resumed;
  parsed = resumed.parsed;

  const preflightCode = await preflight(parsed, io.err);
  if (preflightCode !== null) return { ok: false, code: preflightCode };

  // `--dry-run`: the LAST read-only point. Everything above validates (config merge, --cost-table,
  // --baseline resolution, --from-run/--resume log reads, preflight) and everything below MUTATES —
  // `acquireRunLock` mkdirs the run directory. Printing here means a dry run exercises exactly the
  // checks a real run would, with the same messages and the same exit code, and still writes nothing.
  if (parsed.dryRun) {
    io.out(renderResolvedConfig(dryRunView(parsed, baseline.autoPinnedBaseline), resumed.runConfig));
    return { ok: false, code: 0 };
  }

  return {
    ok: true,
    parsed,
    priceTable: table.priceTable,
    concreteWorkspaceMode,
    autoPinnedBaseline: baseline.autoPinnedBaseline,
    followup,
    runConfig: resumed.runConfig,
    followupSeed: resumed.followupSeed,
    recordedDegraded: resumed.recordedDegraded,
  };
}

/**
 * First-run preflight (fail-fast, before any spend): git repo present, harness / LLM-provider
 * CLI on PATH — the mistakes that used to surface only AFTER a compile + agent turn, as cryptic
 * spawn/plumbing errors. Cheap (milliseconds). On resume this runs AFTER the harness adoption in
 * {@link resolveResume}, so it validates the harness the resumed run will actually use. Returns
 * the exit code, or `null` to proceed.
 */
async function preflight(parsed: ParsedArgs, err: (s: string) => void): Promise<number | null> {
  const problem = await preflightRun({
    harness: parsed.harness,
    llmProvider: parsed.llmProvider,
    workspace: parsed.workspace,
    workspaceMode: parsed.workspaceMode,
  });
  if (problem === null) return null;
  err(`goaly: ${problem}\n`);
  return 2;
}

/**
 * Display-only rebind: the dry run must show the baseline the real run would actually use,
 * including the autonomy auto-pin (annotated so the provenance is visible).
 */
function dryRunView(parsed: ParsedArgs, autoPinnedBaseline: string | undefined): ParsedArgs {
  return autoPinnedBaseline !== undefined
    ? { ...parsed, baseline: `${autoPinnedBaseline} (auto-pinned: harness-autonomy ${parsed.harnessAutonomy})` }
    : parsed;
}

/** Load the optional cost table BEFORE the run so a malformed table fails fast (never mid-run). */
async function loadPriceTable(
  parsed: ParsedArgs,
  err: (s: string) => void,
): Promise<{ ok: true; priceTable: PriceTable | undefined } | { ok: false; code: number }> {
  if (parsed.costTablePath === undefined) return { ok: true, priceTable: undefined };
  try {
    return { ok: true, priceTable: parsePriceTable(await readFile(parsed.costTablePath, 'utf8')) };
  } catch (e) {
    err(`--cost-table ${parsed.costTablePath}: ${e instanceof Error ? e.message : String(e)}\n`);
    return { ok: false, code: 2 };
  }
}

/**
 * Validate --baseline (issue #47) fail-closed BEFORE the run starts: an unknown ref refuses to
 * start rather than silently degrading the diff (invariant #6, parse at the seam). On resume the
 * baseline is reconstructed from the log instead, so the flag is moot then.
 *
 * Raised harness autonomy AUTO-PINS the review baseline (read-only, so it belongs here with the
 * --baseline validation): above the least-privilege tier the agent may `git commit`, which moves
 * HEAD and empties the HEAD-relative diff BOTH keys review — so pin the diff to the run-start
 * commit's SHA (a symbolic HEAD would move with the commit). An explicit --baseline wins; a resume
 * reconstructs its baseline from the run log instead; an unborn HEAD (fresh `git init`, nothing to
 * pin to) degrades to the loud warning at startup.
 */
async function checkBaseline(
  parsed: ParsedArgs,
  concreteWorkspaceMode: 'git' | 'file',
  err: (s: string) => void,
): Promise<{ ok: true; autoPinnedBaseline: string | undefined } | { ok: false; code: number }> {
  if (
    parsed.baseline !== undefined &&
    parsed.resumeRunId === undefined &&
    concreteWorkspaceMode === 'git'
  ) {
    if (!(await refResolves(parsed.workspace, parsed.baseline))) {
      err(
        `--baseline ${parsed.baseline}: not a resolvable git ref in ${parsed.workspace}\n\n${USAGE}\n`,
      );
      return { ok: false, code: 2 };
    }
  }
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
  return { ok: true, autoPinnedBaseline };
}

/**
 * Validate --resume BEFORE the preflight and before creating anything (the run lock would
 * otherwise mkdir a run dir for a typo'd id): a missing run gets a pointer to `runs list`; a
 * corrupt log a clear parse error — mirroring the --from-run guards instead of failing deep
 * inside the resume fold. Runs BEFORE the preflight because a resume ADOPTS the run's recorded
 * harness when --harness wasn't re-passed — the preflight must check the harness that will
 * actually run, not the default (a CI/host without the default CLI would otherwise refuse to
 * resume a fake/codex run it can perfectly continue).
 * A resumed run continues with the LOG's effective config (header + any logged RUN_EXTENDED
 * overlays + this invocation's explicit extension), NOT this invocation's re-parsed defaults — so
 * the budget meter, best-of wiring, etc. match exactly what the resume fold will compute.
 *
 * `followupSeed` is the compile-phase authoring seed. On a fresh `--from-run` run it comes from the
 * follow-up resolution; on `--resume` of a `--recontract` successor it is REBUILT from the header
 * provenance (see {@link overlayStoredLog}) — the same root cause as the driver's dropped
 * provenance: follow-up state only ever arrived from the fresh CLI invocation, and `--from-run`
 * cannot be combined with `--resume`.
 *
 * `recordedDegraded` is the degraded-mode label the run was STARTED with (issue #125). The models a
 * run uses are re-resolved from every invocation's flags, so a resume can change which keys run;
 * the label this process reports must be reconciled against the recorded one exactly as the Driver
 * reconciles the header, or the terminal summary and `goaly runs show <id>` disagree about the
 * same run.
 */
async function resolveResume(
  parsed: ParsedArgs,
  followup: Extract<FollowupResolution, { ok: true }>,
  err: (s: string) => void,
): Promise<ResumeResolution> {
  const passthrough = {
    ok: true as const,
    runConfig: followup.config,
    followupSeed: followup.followupSeed,
    recordedDegraded: undefined,
  };
  const resumeRunId = parsed.resumeRunId; // stable narrow (parsed is rebound on harness adoption)
  if (resumeRunId === undefined) return { ...passthrough, parsed };
  const stateDir = path.join(parsed.workspace, STATE_DIR);
  const prior = await readRun(stateDir, resumeRunId);
  if (prior === null) {
    err(
      `goaly: --resume ${parsed.resumeRunId}: no such run in ${stateDir} — ` +
        `list runs with: goaly runs list --workspace ${parsed.workspace}\n`,
    );
    return { ok: false, code: 2 };
  }
  if (!prior.ok) {
    err(`goaly: --resume ${parsed.resumeRunId}: run log is corrupt: ${prior.error}\n`);
    return { ok: false, code: 2 };
  }
  parsed = adoptRecordedHarness(parsed, prior.detail.harness, err);
  // Extending a DONE run is meaningless (both keys already turned) — route to the follow-up path.
  if (prior.detail.status === 'DONE' && parsed.resumeExtend !== undefined) {
    err(
      `goaly: --resume ${parsed.resumeRunId}: this run is DONE — there is nothing to extend. ` +
        `Build on it with: goaly "<follow-up goal>" --from-run ${parsed.resumeRunId}\n`,
    );
    return { ok: false, code: 2 };
  }
  const stored = await new FileRunLog(path.join(stateDir, resumeRunId)).read();
  if (stored === null) return { ...passthrough, parsed };
  return overlayStoredLog(parsed, resumeRunId, stored, followup.followupSeed, err);
}

/**
 * A resume continues the run's OWN harness unless `--harness` is explicitly re-passed: session
 * ids are harness-specific, so silently switching to the default CLI mid-run would thread the
 * prior harness's session (or sentinel) into a different tool and crash/derail every turn.
 */
function adoptRecordedHarness(
  parsed: ParsedArgs,
  recorded: string | undefined,
  err: (s: string) => void,
): ParsedArgs {
  if (
    parsed.harnessExplicit ||
    recorded === undefined ||
    recorded === parsed.harness ||
    !isHarnessChoice(recorded)
  ) {
    return parsed;
  }
  err(`goaly: --resume: continuing with this run's harness '${recorded}' (pass --harness to override)\n`);
  // The LLM provider default FOLLOWS the harness; a derived (non-explicit) provider is
  // re-derived from the adopted harness so the preflight and the LLM steps track the harness
  // the resumed run will actually use.
  return {
    ...parsed,
    harness: recorded,
    ...(parsed.llmProviderExplicit ? {} : { llmProvider: defaultLlmProvider(recorded) }),
  };
}

/** The stored log's overlays on this invocation: degraded label, streak relief, effective config, seed. */
function overlayStoredLog(
  parsed: ParsedArgs,
  resumeRunId: string,
  stored: StoredLog,
  followupSeed: string | undefined,
  err: (s: string) => void,
): ResumeResolution {
  // Header ∨ every logged escalation: a previous resume records a more collapsed wiring as a
  // DEGRADED_ESCALATED marker (never a header rewrite), so the label is DERIVED from the log.
  const recordedDegraded = effectiveDegraded(stored.header.degraded, stored.entries);
  // Relieve any stuck streak the log has already banked (see `resumeStreakRelief`): without it
  // a run that ABORTED at the crash / unevaluable / repeat threshold re-aborts on the resume
  // fold before the harness gets a single turn, no matter what the operator just fixed. Merged
  // UNDER `parsed.resumeExtend` so an explicit `--stuck-*` on this command line still wins.
  const relief = resumeStreakRelief(stored.header.config, stored.entries);
  let extend = parsed.resumeExtend;
  if (Object.keys(relief).length > 0) {
    extend = { ...parsed.resumeExtend, stuck: { ...relief, ...parsed.resumeExtend?.stuck } };
    err(
      `goaly: --resume: relieving the stuck streak this run banked ` +
        `(${describeRelief(relief)}) — resuming is your signal that something changed, so the ` +
        `resumed run must earn a fresh streak before aborting again\n`,
    );
    // Rebound so the Driver persists the relief as a RUN_EXTENDED marker (auditable in the log).
    parsed = { ...parsed, resumeExtend: extend };
  }
  const effective = extendedRunConfig(stored.header.config, stored.entries);
  const runConfig = extend !== undefined ? applyRunExtension(effective, extend) : effective;

  // ADR-0012 operator door (issue #116) — see `adjudicatedResumeWarning` for why the flag the
  // operator was told to pass cannot work here, and why the route named depends on the VERDICT.
  if (extend?.stuck?.repeatFailureThreshold !== undefined) {
    const warning = adjudicatedResumeWarning(stored.entries, resumeRunId);
    if (warning !== undefined) err(`${warning}\n`);
  }

  // Rebuild the compile-phase authoring seed from the HEADER: a resume that still has to
  // COMPILE (pre-freeze crash, or a Seal "revise" round) otherwise re-authors the bar with the
  // prior run — or the adjudicated defect — out of view. See `resumeAuthoringSeed`.
  followupSeed = resumeAuthoringSeed(stored.header, effective.goal, err) ?? followupSeed;
  return { ok: true, parsed, runConfig, followupSeed, recordedDegraded };
}
