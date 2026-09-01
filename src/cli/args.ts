import { cliInputToRunConfig, type RunConfig } from '../domain/config';
import { resolveInputSources, defaultReaders, type InputReaders } from './input-sources';
import { loadConfig } from './config-file';
import { applyDelegationDirective } from './delegation';
import { collectResumeExtension } from './flags/resume-extension';
import { UsageError, parseFlags, str, type RawFlags } from './flags/tokens';
import {
  parseHarness,
  parseHarnessAutonomy,
  parseLlmProvider,
  parseModels,
} from './flags/harness-flags';
import { candidatesFlag, parseMaxAgentTurns, parseTimeouts } from './flags/budget-flags';
import { parseSandbox } from './flags/sandbox-flags';
import {
  parseDefectCorpus,
  parseLogLevel,
  parseRecontract,
  parseWorkspaceMode,
} from './flags/misc-flags';
import { parseWorktreeRun } from './flags/subcommands';
import { parseSubcommand } from './args-commands';
import { buildCliInput } from './args-cli-input';
import { resolveFlagLayers, type ConfigLoader } from './args-layers';
import { MULTI_SOURCE_FIELDS, RESUMED_GOAL_PLACEHOLDER, type ParsedArgs } from './args-types';

/**
 * The CLI argument coordinator (Phase 3.1 of the improvement plan): tokenizing, per-group flag
 * validation, and the subcommand parsers live in focused modules (`./usage`, `./flags/*`,
 * `./args-*`); this module assembles them into the one {@link ParsedArgs} the rest of the CLI
 * consumes, and remains the CLI's public export surface — everything that was importable from here
 * still is.
 */

export { USAGE } from './usage';
export { UsageError, type RawFlags } from './flags/tokens';
export {
  HARNESS_CHOICES,
  PUBLIC_HARNESS_CHOICES,
  defaultLlmProvider,
  isHarnessChoice,
  type HarnessChoice,
  type LlmProviderChoice,
} from './flags/harness-flags';
export { MAX_CANDIDATES, type StepTimeouts } from './flags/budget-flags';
export { type RunsCommand, type UiCommand } from './flags/subcommands';
export { RESUMED_GOAL_PLACEHOLDER, type ParsedArgs } from './args-types';

export async function parseArgs(
  argv: string[],
  readers: InputReaders = defaultReaders,
  load: ConfigLoader = (dir, explicit) => loadConfig(dir, explicit),
): Promise<ParsedArgs> {
  const [command, ...rest] = argv;
  const subcommand = parseSubcommand(command, rest);
  if (subcommand !== undefined) return subcommand;

  // `run` is optional: an argv that doesn't lead with a known subcommand (`runs`/`help`) is an
  // implicit run, whose first token may be a positional goal (`goaly "my goal"`) or a flag
  // (`goaly -d "my goal"`). A bare `goaly` already returned help above.
  const cliFlags = parseRunFlags(command === 'run' ? rest : argv);
  const { flags, configSources, warnings } = await resolveFlagLayers(cliFlags, load);

  // Goal/intent/rubric may come from inline flags, files, or stdin — resolve to strings first.
  const resolved = await resolveInputSources(flags, readers);

  // On --resume the goal (and the whole contract) is read back from the FROZEN run log, not the CLI:
  // parseArgs still builds a RunConfig here, but main.ts discards it for the log's effective config.
  // So a goal is NOT required when resuming — synthesize a placeholder that will be overwritten. A
  // genuinely missing goal on a FRESH run is a clean usage error, not the raw ZodError that
  // `CliInput.parse({ goal: undefined })` would otherwise throw (which escapes as an ugly stack).
  // A --recontract successor likewise INHERITS the predecessor's frozen goal (a repair changes the
  // BAR, not the goal), so it needs none either; run-cmd substitutes the real one.
  const resuming = str(flags, 'resume') !== undefined;
  if (resolved.goal === undefined && !resuming && flags['recontract'] === undefined) {
    throw new UsageError(
      'a goal is required — pass it positionally (goaly "<goal>"), or with --goal / --goal-file / ' +
        '--goal - (stdin)',
    );
  }
  // Natural-language parallel delegation (see `delegation.ts`), loudly logged by the CLI; the
  // explicit `--candidates` / `--best-of` flag (or config) always wins.
  const explicitCandidates = candidatesFlag(flags);
  const { goal, delegation } = applyDelegationDirective(
    resolved.goal,
    explicitCandidates !== undefined,
  );
  const candidates =
    explicitCandidates !== undefined
      ? explicitCandidates
      : delegation !== undefined
        ? String(delegation.candidates)
        : undefined;
  const cliInput = buildCliInput(flags, resolved, goal ?? RESUMED_GOAL_PLACEHOLDER, candidates);

  const harness = parseHarness(str(flags, 'harness'));
  const config = cliInputToRunConfig(cliInput);
  assertParallelPhasesWiring(config, resuming);

  // Explicitness for the resume extension is judged on CLI flags ONLY (never the config-file
  // overlay): a `.goalyrc` default like "budget-tokens" must not append a RUN_EXTENDED marker to
  // the log on every resume — an extension is an explicit per-invocation operator act.
  const resumed = collectResumeExtension(cliFlags, config);
  assertStdinLeftForSeal(flags, config);

  return {
    command: 'run',
    runs: undefined,
    worktree: undefined,
    ui: undefined,
    doctor: undefined,
    init: undefined,
    configCmd: undefined,
    completion: undefined,
    worktreeRun: parseWorktreeRun(flags),
    config,
    harness,
    harnessExplicit: cliFlags['harness'] !== undefined,
    models: parseModels(flags),
    llmProvider: parseLlmProvider(str(flags, 'llm-provider'), harness),
    llmProviderExplicit: flags['llm-provider'] !== undefined,
    harnessAutonomy: parseHarnessAutonomy(str(flags, 'harness-autonomy')),
    // Per-invocation: read from `cliFlags`, never the config overlay (a persisted `dry-run: true`
    // would silently make every run in that tree a no-op).
    dryRun: cliFlags['dry-run'] !== undefined,
    workspace: str(flags, 'workspace') ?? process.cwd(),
    workspaceMode: parseWorkspaceMode(str(flags, 'workspace-mode')),
    baseline: str(flags, 'baseline'),
    verifyDir: str(flags, 'verify-dir'),
    defects: parseDefectCorpus(flags),
    planFile: str(flags, 'plan-file'),
    resumeRunId: str(flags, 'resume'),
    resumeExtend: resumed.extension,
    // A directive can come from the goal (fresh run) or the resume note — never both in one
    // invocation (a resumed run's goal is the placeholder; a fresh run rejects --note).
    delegation: delegation ?? resumed.delegation,
    fromRunId: str(flags, 'from-run'),
    inheritSession: flags['inherit-session'] !== undefined,
    recontract: parseRecontract(flags),
    logLevel: parseLogLevel(str(flags, 'log-level')),
    logFile: str(flags, 'log-file'),
    noLogFile: flags['no-log-file'] !== undefined,
    stream: flags['stream'] !== undefined,
    explain: flags['explain'] !== undefined,
    streamTranscript: flags['stream-transcript'] !== undefined || str(flags, 'stream-file') !== undefined,
    streamFile: str(flags, 'stream-file'),
    timeouts: parseTimeouts(flags),
    maxAgentTurns: parseMaxAgentTurns(flags),
    sandbox: parseSandbox(flags),
    costTablePath: str(flags, 'cost-table'),
    configSources,
    warnings,
    baseUrl: str(flags, 'base-url'),
    llmApiKeyEnv: str(flags, 'llm-api-key-env') ?? 'OPENAI_API_KEY',
  };
}

/** Tokenize a run's argv into its CLI flag overlay, folding a bare positional goal into `--goal`. */
function parseRunFlags(runArgs: string[]): RawFlags {
  const { flags: cliFlags, positionals } = parseFlags(runArgs);

  // `--max-gate-a-revisions` was renamed to `--max-seal-revisions` (no alias). The CLI otherwise
  // ignores unknown flags, so reject the removed spelling explicitly — silently dropping a flag a
  // user's script used to rely on would lose the setting without warning.
  if (cliFlags['max-gate-a-revisions'] !== undefined) {
    throw new UsageError('--max-gate-a-revisions was renamed to --max-seal-revisions');
  }

  // A single bare positional is the goal — sugar for `--goal` so a developer can just type it
  // (`goaly "my goal"`). Fold it into the CLI flags so it reuses the whole existing goal pipeline
  // (resolveInputSources + the config double-source override). More than one positional, or a
  // positional alongside an explicit --goal/--goal-file, is a fail-closed conflict.
  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected extra argument '${positionals[1]}' (pass a single goal; quote it if it has spaces)`,
    );
  }
  const positionalGoal = positionals[0];
  if (positionalGoal !== undefined) {
    if (cliFlags['goal'] !== undefined || cliFlags['goal-file'] !== undefined) {
      throw new UsageError(
        `goal given both positionally ('${positionalGoal}') and via --goal/--goal-file (use one)`,
      );
    }
    cliFlags['goal'] = positionalGoal;
  }
  return cliFlags;
}

/**
 * EXPERIMENTAL parallel waves: the fan-out only exists inside a phased plan (independent sub-goals),
 * and wave children compile + Seal their contracts CONCURRENTLY — an interactive gate cannot pause
 * K children at once, so autonomy is required (the contracts are still frozen + logged loudly).
 */
function assertParallelPhasesWiring(config: RunConfig, resuming: boolean): void {
  if (!config.parallelPhases || resuming) return;
  if (!config.phased) {
    throw new UsageError(
      "--parallel-phases parallelizes a phased plan's independent sub-goals — pair it with " +
        '--phased (and declare the independence in the plan with "id"/"dependsOn", or the ' +
        'legacy "group" sugar)',
    );
  }
  if (!config.autonomous) {
    throw new UsageError(
      '--parallel-phases requires --autonomous: wave children seal their frozen contracts ' +
        'concurrently and cannot pause at interactive gates (each contract is still frozen + logged)',
    );
  }
}

/**
 * Piping a field via stdin (`--goal -`) drains the ONLY stdin stream, so the interactive Seal
 * prompt that a non-autonomous run needs would read EOF / hang. That used to be a doc-note
 * footgun; fail closed here with the exact fix instead of deadlocking at the gate.
 */
function assertStdinLeftForSeal(flags: RawFlags, config: RunConfig): void {
  const stdinField = MULTI_SOURCE_FIELDS.find((f) => flags[f] === '-');
  if (stdinField !== undefined && !config.autonomous) {
    throw new UsageError(
      `--${stdinField} - reads from stdin, leaving no stdin for the interactive Seal prompt. ` +
        `Add --autonomous (the contract is still frozen & logged), or use --${stdinField}-file.`,
    );
  }
}
