import { CliInput, cliInputToRunConfig, type RunConfig } from '../domain/config';
import type { RunExtension } from '../domain/events';
import { SandboxPolicy } from '../sandbox/policy';
import type { LogLevel } from '../log/logger';
import { ModelSelection } from './models';
import { resolveInputSources, defaultReaders, type InputReaders } from './input-sources';
import { loadConfig, type LoadedConfig } from './config-file';
import { parseDelegationDirective } from './delegation';
import type { AutonomyLevel } from '../agent-cli/droid-codec';
import type { WorktreeCommand } from './worktree-cmd';
import type { DoctorCommand } from './doctor';
import type { InitCommand } from './init';
import { USAGE } from './usage';
import { UsageError, parseFlags, str, boolFlag, type RawFlags } from './flags/tokens';
import {
  parseHarness,
  parseHarnessAutonomy,
  parseLlmProvider,
  parseModels,
  type HarnessChoice,
  type LlmProviderChoice,
} from './flags/harness-flags';
import {
  MAX_CANDIDATES,
  candidatesFlag,
  parseMaxAgentTurns,
  parseResumeBestOfIncomplete,
  parseTimeouts,
  type StepTimeouts,
} from './flags/budget-flags';
import {
  parseAdversarialCount,
  parseApproverDiversityTemp,
  parseContractDryRun,
  parseApproverLenses,
  parseApproverQuorum,
  parseSatisfiabilityCritic,
} from './flags/review-flags';
import { parseSandbox } from './flags/sandbox-flags';
import { parseLogLevel, parseRecontract, parseWorkspaceMode, type RecontractRequest } from './flags/misc-flags';
import {
  parseConfigCommand,
  parseDoctorCommand,
  parseInitCommand,
  parseRunsCommand,
  parseUiCommand,
  parseWorktreeCommand,
  parseWorktreeRun,
  type RunsCommand,
  type UiCommand,
} from './flags/subcommands';
import type { ConfigCommand } from './config-cmd';
import { parseCompletionShell, type CompletionCommand } from './completion';
import { applyMode, parseMode } from './modes';
import { applyImpliedDefault, applyPreset, mergedPresets } from './presets';

/**
 * The CLI argument coordinator (Phase 3.1 of the improvement plan): tokenizing, per-group flag
 * validation, and the subcommand parsers live in focused modules (`./usage`, `./flags/*`); this
 * module assembles them into the one {@link ParsedArgs} the rest of the CLI consumes, and remains
 * the CLI's public export surface — everything that was importable from here still is.
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
export type ParsedArgs = {
  command: 'run' | 'help' | 'runs' | 'worktree' | 'ui' | 'doctor' | 'init' | 'config' | 'completion';
  /** The read-only inspection subcommand; present only when `command === 'runs'`. */
  runs: RunsCommand | undefined;
  /** The worktree-management subcommand; present only when `command === 'worktree'`. */
  worktree: WorktreeCommand | undefined;
  /** The web-UI subcommand; present only when `command === 'ui'`. */
  ui: UiCommand | undefined;
  /** The environment-report subcommand; present only when `command === 'doctor'`. */
  doctor: DoctorCommand | undefined;
  /** The config-bootstrap subcommand; present only when `command === 'init'`. */
  init: InitCommand | undefined;
  /** The config-tooling subcommand; present only when `command === 'config'`. */
  configCmd: ConfigCommand | undefined;
  /** The shell-completion subcommand; present only when `command === 'completion'`. */
  completion: CompletionCommand | undefined;
  /**
   * Run inside a goaly-managed worktree (`--worktree [<name>]`): the run's whole workspace —
   * state dir, run lock, harness cwd, diff scope — is re-rooted at `.goaly/worktrees/<name>`
   * (created on branch `goaly/<name>` if absent). A bare `--worktree` auto-names one. Pure wiring;
   * never enters the frozen contract.
   */
  worktreeRun: string | true | undefined;
  config: RunConfig;
  harness: HarnessChoice;
  /**
   * Whether `harness` came from an EXPLICIT `--harness` CLI flag this invocation (never the
   * config-file overlay — same explicitness rule as the resume extension). A `--resume` without it
   * ADOPTS the resumed run's recorded harness instead of silently switching to the default: session
   * ids are harness-specific, and continuing a fake/codex run under `claude` mid-run is never what
   * the user meant.
   */
  harnessExplicit: boolean;
  models: ModelSelection;
  llmProvider: LlmProviderChoice;
  /**
   * Whether `llmProvider` was set explicitly (CLI flag or config file) rather than derived from
   * the harness via {@link defaultLlmProvider}. A `--resume` that adopts the resumed run's
   * recorded harness re-derives the provider only when it was NOT explicit.
   */
  llmProviderExplicit: boolean;
  /**
   * `--harness-autonomy`: how much the write-role CLI may do, for harnesses that gate privileged
   * actions behind a tier (droid's `--auto`). Pure WIRING like `models` — it never enters the frozen
   * contract, so it lives here rather than on `RunConfig`. `undefined` ⇒ keep the codec's own
   * least-privilege default. Precedence: CLI flag > config file.
   */
  harnessAutonomy: AutonomyLevel | undefined;
  /**
   * `--dry-run`: resolve and print the effective configuration, then exit 0 WITHOUT starting a run.
   * Short-circuits after every read-only validation (config merge, `--baseline`, `--resume`
   * /`--from-run` log reads, preflight) and before the first byte is written — no run directory, no
   * lock, no log file, no worktree. Per-invocation, so it is never read from a config file.
   */
  dryRun: boolean;
  workspace: string;
  /**
   * Diff baseline (issue #47): the git ref/SHA `diff()`/Sign-off compare the working tree against,
   * instead of `HEAD`. Pure wiring — never enters the frozen contract. Validated to resolve
   * (fail-closed) before the run starts. Precedence: CLI flag > config file.
   */
  baseline: string | undefined;
  /**
   * Workspace backing mode (ADR 0018): `git` uses git plumbing, `file` uses a content-addressed
   * file-system manifest, `auto` picks `git` when inside a git work tree and `file` otherwise.
   * Pure wiring.
   */
  workspaceMode: 'git' | 'file' | 'auto';
  /**
   * Preferred directory for compiler-authored verification files (issue #52). Pure wiring — guidance
   * to the compiler; the authored files are git-excluded regardless. Absent ⇒ the compiler chooses.
   */
  verifyDir: string | undefined;
  /**
   * Phased decomposition (issue #48): the `--plan-file <path>` that sources a structured plan instead
   * of authoring one with the LLM. Pure wiring (selects the StaticPlanner); only used when `--phased`.
   */
  planFile: string | undefined;
  resumeRunId: string | undefined;
  /**
   * Follow-up as a new verifiable goal (Capability C): the PRIOR run id whose compaction seeds the
   * new run's contract authoring. The follow-up runs in the same workspace and compiles its OWN
   * frozen, two-key contract. Absent ⇒ a normal fresh run. Distinct from `--resume`, which re-enters
   * an INCOMPLETE run's loop; `--from-run` starts a NEW run that builds on a finished one.
   */
  fromRunId: string | undefined;
  /**
   * With `--from-run`, also resume the prior harness session on the follow-up's first turn so the
   * agent keeps its working memory (the new frozen contract still solely governs DONE). Only valid
   * with the same harness; ignored under `--phased`. Default false.
   */
  inheritSession: boolean;
  /**
   * `--recontract` (issue #117): with `--from-run`, a SUCCESSOR run over the predecessor's KEPT tree —
   * re-author the bar its CONTRACT_DEFECTIVE adjudication condemned, freeze a NEW contract under a NEW
   * run id, record provenance. Carries the chain cap (`--max-recontracts`). Absent ⇒ an ordinary run.
   */
  recontract: RecontractRequest | undefined;
  /** Minimum diagnostic log level (default `info`). Pure wiring — never enters the contract. */
  logLevel: LogLevel;
  /** Override the diagnostics file path (default `<workspace>/.goaly/<runId>/goaly.log`). */
  logFile: string | undefined;
  /** Disable the diagnostics file sink (console only). */
  noLogFile: boolean;
  /** Stream the agent run AND the LLM steps' intermediate turns live to stderr (opt-in). */
  stream: boolean;
  /**
   * Enable the read-only `--explain` observer (issue #8): a side-LLM that narrates the frozen
   * contract, each verifier-ladder run, and the terminal outcome in plain language. Off by default;
   * strictly advisory (never influences the contract, ladder, DECIDE, or the two-key DONE).
   */
  explain: boolean;
  /** Persist the canonical stream as JSONL to `<workspace>/.goaly/<runId>/stream.jsonl` (opt-in). */
  streamTranscript: boolean;
  /** Override the stream-transcript path (implies `--stream-transcript`). */
  streamFile: string | undefined;
  /** Per-step subprocess timeouts (pure wiring; each absent ⇒ that step keeps its default). */
  timeouts: StepTimeouts;
  /**
   * Per-run turn cap for the `goaly-code` agent loop (follow-on E). Pure wiring — never enters the
   * frozen contract; only the goaly-code harness consumes it (codec harnesses manage their own turn
   * budgets). Absent ⇒ the harness default (50). A hard from-scratch task may want 100–200.
   */
  maxAgentTurns: number | undefined;
  /** Opt-in OS-isolation policy (issue #9). Default `mode: 'none'` ⇒ behavior byte-for-byte unchanged. */
  sandbox: SandboxPolicy;
  /** Optional `--cost-table` JSON path: prices the token report (USD per 1M tokens). Default off. */
  costTablePath: string | undefined;
  /** Config files that supplied default flags, lowest-precedence first (pure wiring; for logging). */
  configSources: string[];
  /**
   * Non-fatal parse-time findings the CLI must SURFACE rather than swallow (e.g. a CLI `--generate`
   * that overrode a config-file `verify-cmd`). Collected here instead of written directly because
   * `parseArgs` is library code with no output channel — `executeRun` prints them and the UI can
   * render them. Empty on a clean parse.
   */
  warnings: string[];
  /**
   * OpenAI-compatible endpoint base URL for `--harness goaly-code` / `--llm-provider openai` (e.g.
   * `https://api.openai.com/v1`). Pure wiring — never enters the frozen contract. Absent ⇒ those
   * targets fail closed at composition with a clear message.
   */
  baseUrl: string | undefined;
  /**
   * Env var name holding the bearer token for the OpenAI-compatible endpoint (default
   * `OPENAI_API_KEY`). Read at the composition edge; a keyless local endpoint (e.g. ollama) needs no
   * token, so an unset var is allowed (no `Authorization` header is sent).
   */
  llmApiKeyEnv: string;
  /**
   * Operator extension/steering for a `--resume` (ADR 0012): the cap / stuck-policy flags the user
   * EXPLICITLY passed alongside `--resume` (raises `maxIterations` / budget / thresholds for the
   * resumed run), plus an optional `--note` appended to the next agent prompt. Undefined on a fresh
   * run or a plain resume. Operational knobs only — never the goal / verifier / rubric.
   */
  resumeExtend: RunExtension | undefined;
  /**
   * Natural-language parallel delegation, when a directive in the GOAL text was mapped onto the
   * best-of-N tournament ("work with 4 subagents" ⇒ `candidates: 4` — see `delegation.ts`). Carried
   * so the CLI can log the interpretation loudly (the matched phrase and the count). The directive
   * clause is already stripped from `config.goal`; an explicit `--candidates` always wins (this is
   * then still set, with `overriddenByFlag: true`, so the log can say so). Undefined ⇒ no directive.
   */
  delegation: { candidates: number; phrase: string; overriddenByFlag: boolean } | undefined;
};

/**
 * Collect the operator extension for a `--resume` (ADR 0012) from EXPLICITLY-passed CLI flags
 * (never the config-file overlay — an extension is a per-invocation operator act). The values are
 * read off the already-validated RunConfig (so every coercion/floor is applied once); only flags
 * actually present become part of the extension — absent ones keep whatever the run log's
 * effective config says. `--note` is resume-only: on a fresh run there is no next-turn boundary to
 * attach it to, so it fails closed with the fix.
 */
function collectResumeExtension(
  flags: RawFlags,
  config: RunConfig,
): { extension: RunExtension | undefined; delegation: ParsedArgs['delegation'] } {
  const resuming = str(flags, 'resume') !== undefined;
  let note = str(flags, 'note');
  if (!resuming) {
    if (note !== undefined) {
      throw new UsageError(
        '--note steers a RESUMED run (it is appended to the next agent prompt) — pair it with ' +
          '--resume <runId>. To guide a fresh run, put the guidance in the goal or --intent.',
      );
    }
    return { extension: undefined, delegation: undefined };
  }
  const has = (key: string): boolean => flags[key] !== undefined;
  // Natural-language delegation in a resume note ("try 4 parallel attempts"): the steering intent
  // is goaly's to ACT on (a `candidates` overlay on the extension), not the worker's to read — so
  // the directive clause is stripped and any remaining guidance stays the note. The explicit
  // `--candidates` / `--best-of` flag wins, exactly as on a fresh run.
  const explicit = has('candidates') || has('best-of');
  let delegation: ParsedArgs['delegation'];
  if (note !== undefined) {
    const directive = parseDelegationDirective(note);
    if (directive !== null) {
      if (directive.candidates > MAX_CANDIDATES) {
        throw new UsageError(
          `"${directive.phrase}": at most ${MAX_CANDIDATES} parallel candidates are supported ` +
            `(each is a full concurrent worker + worktree) — ask for ${MAX_CANDIDATES} or fewer`,
        );
      }
      delegation = {
        candidates: directive.candidates,
        phrase: directive.phrase,
        overriddenByFlag: explicit,
      };
      note = directive.cleaned.length > 0 ? directive.cleaned : undefined;
    }
  }
  const stuck = {
    ...(has('stuck-no-diff') ? { noDiff: config.stuckPolicy.noDiff } : {}),
    ...(has('stuck-repeat-threshold')
      ? { repeatFailureThreshold: config.stuckPolicy.repeatFailureThreshold }
      : {}),
    ...(has('stuck-oscillation') ? { oscillation: config.stuckPolicy.oscillation } : {}),
    ...(has('stuck-crash-threshold')
      ? { harnessCrashThreshold: config.stuckPolicy.harnessCrashThreshold }
      : {}),
    ...(has('stuck-unevaluable-threshold')
      ? { unevaluableThreshold: config.stuckPolicy.unevaluableThreshold }
      : {}),
    ...(has('stuck-timeout-no-diff-threshold')
      ? { timeoutNoDiffThreshold: config.stuckPolicy.timeoutNoDiffThreshold }
      : {}),
  };
  const extension: RunExtension = {
    ...(has('max-iterations') ? { maxIterations: config.maxIterations } : {}),
    ...(has('budget-tokens') && config.budget.tokens !== undefined
      ? { budgetTokens: config.budget.tokens }
      : {}),
    ...(has('budget-wall-ms') && config.budget.wallClockMs !== undefined
      ? { budgetWallMs: config.budget.wallClockMs }
      : {}),
    ...(Object.keys(stuck).length > 0 ? { stuck } : {}),
    ...(explicit
      ? { candidates: config.candidates }
      : delegation !== undefined
        ? { candidates: delegation.candidates }
        : {}),
    ...(note !== undefined ? { note } : {}),
  };
  return {
    extension: Object.keys(extension).length > 0 ? extension : undefined,
    delegation,
  };
}

/** Fields that may be sourced inline / from a file / from stdin; a CLI source overrides config. */
const MULTI_SOURCE_FIELDS = ['goal', 'intent', 'rubric'] as const;

/**
 * Stand-in goal used when `--resume` is given without one. On resume the RunConfig parseArgs builds is
 * discarded — main.ts continues from the frozen run log's config — so the goal is never read; this only
 * satisfies `CliInput`'s non-empty-goal schema. It must never surface (a real resume overwrites it).
 */
export const RESUMED_GOAL_PLACEHOLDER = '(resumed run — goal is read from the frozen run log)';

export async function parseArgs(
  argv: string[],
  readers: InputReaders = defaultReaders,
  load: (dir: string, explicit: string | undefined) => Promise<LoadedConfig> = (dir, explicit) =>
    loadConfig(dir, explicit),
): Promise<ParsedArgs> {
  const [command, ...rest] = argv;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return helpResult();
  }
  if (command === 'runs') {
    return runsResult(parseRunsCommand(rest));
  }
  if (command === 'worktree') {
    return worktreeResult(parseWorktreeCommand(rest));
  }
  if (command === 'ui') {
    return uiResult(parseUiCommand(rest));
  }
  if (command === 'doctor') {
    return doctorResult(parseDoctorCommand(rest));
  }
  if (command === 'init') {
    return initResult(parseInitCommand(rest));
  }
  if (command === 'config') {
    return configResult(parseConfigCommand(rest));
  }
  if (command === 'completion') {
    return {
      ...baseArgs('completion', undefined, process.cwd()),
      completion: { shell: parseCompletionShell(rest[0]) },
    };
  }
  // `run` is optional: an argv that doesn't lead with a known subcommand (`runs`/`help`) is an
  // implicit run, whose first token may be a positional goal (`goaly "my goal"`) or a flag
  // (`goaly -d "my goal"`). A bare `goaly` already returned help above.
  const runArgs = command === 'run' ? rest : argv;

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

  // A config file (.goalyrc in --workspace/cwd, plus an explicit --config <path>) supplies DEFAULT
  // flags so the same wiring need not be repeated every run (issue #15). Explicit CLI flags always
  // win. For goal/intent/rubric the CLI source may be a *different* key than the config's (e.g.
  // --goal-file vs "goal"), so a config default for such a field is dropped whenever the CLI
  // provides ANY source for it — otherwise the two would look like a conflicting double-source.
  const workspaceDir = str(cliFlags, 'workspace') ?? process.cwd();
  const loaded = await load(workspaceDir, str(cliFlags, 'config'));
  const configSources = loaded.sources;
  let overlayFlags: RawFlags = { ...loaded.overlay };

  // Named preset (presets.ts): `--preset <name>` (or a persisted `"preset"` default) expands a
  // user-defined flag bundle from the config files' `presets` block into the config layer. It runs
  // BEFORE the multi-source drop below (so a preset-supplied goal/intent/rubric obeys the same
  // CLI-source override rule) and BEFORE the mode expansion (so a preset's `mode` value is picked
  // up exactly as if typed). Layering: config base < preset < mode < explicit CLI flags.
  const presetNotes: string[] = [];
  const requestedPreset = str({ ...overlayFlags, ...cliFlags }, 'preset');
  if (requestedPreset !== undefined) {
    const expanded = applyPreset(
      requestedPreset,
      str(cliFlags, 'preset') !== undefined,
      mergedPresets(loaded.presets),
      overlayFlags,
      cliFlags,
    );
    overlayFlags = expanded.overlay;
    presetNotes.push(...expanded.notes);
  } else if (str({ ...overlayFlags, ...cliFlags }, 'mode') === undefined) {
    // Neither a preset nor a mode was chosen: the 'default' preset applies IMPLICITLY, as the
    // weakest tier — it fills gaps only (config files and explicit flags always win), and its
    // `mode` is pre-expanded inside so the strong profile expansion below never runs unasked.
    // `--preset none` (or a persisted `"preset": "none"`) opts out of even that.
    const implied = applyImpliedDefault(mergedPresets(loaded.presets), overlayFlags, cliFlags);
    overlayFlags = implied.overlay;
    presetNotes.push(...implied.notes);
  }

  for (const field of MULTI_SOURCE_FIELDS) {
    if (cliFlags[field] !== undefined || cliFlags[`${field}-file`] !== undefined) {
      delete overlayFlags[field];
    }
  }

  // Autonomy profile (improvement plan 4.1): `--mode` (CLI or config) expands into explicit flag
  // values LAYERED config < profile < CLI, so everything downstream — including the frozen
  // RunConfig — sees ordinary flags. The expansion's loud notes land in `warnings` below.
  const mode = parseMode(str({ ...overlayFlags, ...cliFlags }, 'mode'));
  const modeNotes: string[] = [];
  if (mode !== undefined) {
    const expanded = applyMode(mode, overlayFlags, cliFlags);
    overlayFlags = expanded.overlay;
    modeNotes.push(...expanded.notes);
  }
  const flags: RawFlags = { ...overlayFlags, ...cliFlags };

  // `--verify-cmd | --generate` is advertised as mutually exclusive in the usage synopsis, and
  // `cliInputToRunConfig` silently resolves it in favour of --generate. PROVENANCE decides which of
  // those two is right, and only this scope knows it (the config layer has already been flattened by
  // the time domain/config.ts sees the input):
  //   - both typed on the COMMAND LINE ⇒ a genuine contradiction the user must resolve (fail closed);
  //   - `verify-cmd` from a .goalyrc layer + --generate typed now ⇒ an ordinary, useful one-off
  //     override — keep --generate, but never silently: name the source that lost.
  const warnings: string[] = [...presetNotes, ...modeNotes];
  if (cliFlags['generate'] !== undefined && cliFlags['verify-cmd'] !== undefined) {
    throw new UsageError(
      '--verify-cmd and --generate are mutually exclusive: --verify-cmd points at an EXISTING ' +
        'command, --generate has the agent AUTHOR one. Pass exactly one.',
    );
  }
  if (cliFlags['generate'] !== undefined && overlayFlags['verify-cmd'] !== undefined) {
    const from = configSources.length > 0 ? configSources.join(' / ') : 'the config file';
    warnings.push(
      `--generate overrides the 'verify-cmd' from ${from} ('${String(overlayFlags['verify-cmd'])}') — ` +
        'the verification will be AUTHORED, not the configured command.',
    );
  }

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
  // Natural-language parallel delegation: an explicit directive in the goal ("work with 4
  // subagents") maps onto the best-of-N tournament (issue #85) and its clause is STRIPPED — the
  // goal is frozen into the contract and read by the judge/approver, so a leftover directive would
  // become an unverifiable success criterion. Deterministic grammar (see `delegation.ts`), loudly
  // logged by the CLI; the explicit `--candidates` / `--best-of` flag (or config) always wins.
  const explicitCandidates = candidatesFlag(flags);
  let goalText = resolved.goal;
  let delegation: ParsedArgs['delegation'];
  if (goalText !== undefined) {
    const directive = parseDelegationDirective(goalText);
    if (directive !== null) {
      if (directive.candidates > MAX_CANDIDATES) {
        throw new UsageError(
          `"${directive.phrase}": at most ${MAX_CANDIDATES} parallel candidates are supported ` +
            `(each is a full concurrent worker + worktree) — ask for ${MAX_CANDIDATES} or fewer`,
        );
      }
      if (directive.cleaned.length === 0) {
        throw new UsageError(
          `the goal '${goalText}' is only a delegation directive — say WHAT to achieve too, ` +
            `e.g. goaly "fix the flaky test, ${directive.phrase}"`,
        );
      }
      goalText = directive.cleaned;
      delegation = {
        candidates: directive.candidates,
        phrase: directive.phrase,
        overriddenByFlag: explicitCandidates !== undefined,
      };
    }
  }
  const goalForParse = goalText ?? RESUMED_GOAL_PLACEHOLDER;

  const cliInput = CliInput.parse({
    goal: goalForParse,
    ...(str(flags, 'verify-cmd') !== undefined ? { verifyCmd: str(flags, 'verify-cmd') } : {}),
    ...(flags['generate'] !== undefined ? { generate: true } : {}),
    ...(str(flags, 'smoke') !== undefined ? { smoke: str(flags, 'smoke') } : {}),
    ...(str(flags, 'setup-cmd') !== undefined ? { setupCmd: str(flags, 'setup-cmd') } : {}),
    ...(flags['no-setup'] !== undefined ? { noSetup: true } : {}),
    ...(boolFlag(flags, 'install-missing-tools') !== undefined
      ? { installMissingTools: boolFlag(flags, 'install-missing-tools') }
      : {}),
    ...(resolved.intent !== undefined ? { intent: resolved.intent } : {}),
    ...(resolved.rubric !== undefined ? { rubric: resolved.rubric } : {}),
    ...(flags['autonomous'] !== undefined ? { autonomous: true } : {}),
    ...(str(flags, 'max-iterations') !== undefined
      ? { maxIterations: str(flags, 'max-iterations') }
      : {}),
    ...(explicitCandidates !== undefined
      ? { candidates: explicitCandidates }
      : delegation !== undefined
        ? { candidates: String(delegation.candidates) }
        : {}),
    ...(parseResumeBestOfIncomplete(flags) !== undefined
      ? { resumeBestOfIncomplete: parseResumeBestOfIncomplete(flags) }
      : {}),
    ...(flags['phased'] !== undefined ? { phased: true } : {}),
    ...(flags['parallel-phases'] !== undefined ? { parallelPhases: true } : {}),
    ...(str(flags, 'max-phases') !== undefined ? { maxPhases: str(flags, 'max-phases') } : {}),
    ...(str(flags, 'max-plan-revisions') !== undefined
      ? { maxPlanRevisions: str(flags, 'max-plan-revisions') }
      : {}),
    ...(str(flags, 'max-seal-revisions') !== undefined
      ? { maxSealRevisions: str(flags, 'max-seal-revisions') }
      : {}),
    ...(str(flags, 'max-compile-retries') !== undefined
      ? { maxCompileRetries: str(flags, 'max-compile-retries') }
      : {}),
    ...(str(flags, 'max-plan-retries') !== undefined
      ? { maxPlanRetries: str(flags, 'max-plan-retries') }
      : {}),
    ...(boolFlag(flags, 'stuck-no-diff') !== undefined
      ? { stuckNoDiff: boolFlag(flags, 'stuck-no-diff') }
      : {}),
    ...(str(flags, 'stuck-repeat-threshold') !== undefined
      ? { stuckRepeatThreshold: str(flags, 'stuck-repeat-threshold') }
      : {}),
    ...(boolFlag(flags, 'stuck-oscillation') !== undefined
      ? { stuckOscillation: boolFlag(flags, 'stuck-oscillation') }
      : {}),
    ...(str(flags, 'stuck-crash-threshold') !== undefined
      ? { stuckCrashThreshold: str(flags, 'stuck-crash-threshold') }
      : {}),
    ...(str(flags, 'stuck-unevaluable-threshold') !== undefined
      ? { stuckUnevaluableThreshold: str(flags, 'stuck-unevaluable-threshold') }
      : {}),
    ...(str(flags, 'stuck-timeout-no-diff-threshold') !== undefined
      ? { stuckTimeoutNoDiffThreshold: str(flags, 'stuck-timeout-no-diff-threshold') }
      : {}),
    ...(boolFlag(flags, 'auto-remediate-stuck') !== undefined
      ? { autoRemediateStuck: boolFlag(flags, 'auto-remediate-stuck') }
      : {}),
    ...(str(flags, 'budget-tokens') !== undefined
      ? { budgetTokens: str(flags, 'budget-tokens') }
      : {}),
    ...(str(flags, 'budget-wall-ms') !== undefined
      ? { budgetWallClockMs: str(flags, 'budget-wall-ms') }
      : {}),
    ...(str(flags, 'diff-ignore') !== undefined ? { diffIgnore: str(flags, 'diff-ignore') } : {}),
    ...(flags['delta-verify'] !== undefined ? { deltaVerify: true } : {}),
    ...(parseApproverQuorum(flags) !== undefined
      ? { approverQuorum: parseApproverQuorum(flags) }
      : {}),
    ...(parseApproverDiversityTemp(flags) !== undefined
      ? { approverDiversityTemp: parseApproverDiversityTemp(flags) }
      : {}),
    ...(parseApproverLenses(flags) !== undefined
      ? { approverLenses: parseApproverLenses(flags) }
      : {}),
    ...(flags['adversarial'] !== undefined ? { adversarial: true } : {}),
    ...(parseAdversarialCount(flags, 'adversarial-plan-critics') !== undefined
      ? { adversarialPlanCritics: parseAdversarialCount(flags, 'adversarial-plan-critics') }
      : {}),
    ...(parseAdversarialCount(flags, 'adversarial-contract-critics') !== undefined
      ? { adversarialContractCritics: parseAdversarialCount(flags, 'adversarial-contract-critics') }
      : {}),
    ...(parseAdversarialCount(flags, 'adversarial-refuters') !== undefined
      ? { adversarialRefuters: parseAdversarialCount(flags, 'adversarial-refuters') }
      : {}),
    ...(parseSatisfiabilityCritic(flags) !== undefined
      ? { satisfiabilityCritic: parseSatisfiabilityCritic(flags) }
      : {}),
    ...(parseContractDryRun(flags) !== undefined
      ? { contractDryRun: parseContractDryRun(flags) }
      : {}),
  });

  const harness = parseHarness(str(flags, 'harness'));
  const config = cliInputToRunConfig(cliInput);

  // EXPERIMENTAL parallel waves: the fan-out only exists inside a phased plan (grouped sub-goals),
  // and wave children compile + Seal their contracts CONCURRENTLY — an interactive gate cannot pause
  // K children at once, so autonomy is required (the contracts are still frozen + logged loudly).
  if (config.parallelPhases && !resuming) {
    if (!config.phased) {
      throw new UsageError(
        "--parallel-phases parallelizes a phased plan's grouped sub-goals — pair it with --phased " +
          '(and mark consecutive phases with a shared "group" in the plan)',
      );
    }
    if (!config.autonomous) {
      throw new UsageError(
        '--parallel-phases requires --autonomous: wave children seal their frozen contracts ' +
          'concurrently and cannot pause at interactive gates (each contract is still frozen + logged)',
      );
    }
  }
  // Explicitness for the resume extension is judged on CLI flags ONLY (never the config-file
  // overlay): a `.goalyrc` default like "budget-tokens" must not append a RUN_EXTENDED marker to
  // the log on every resume — an extension is an explicit per-invocation operator act.
  const resumed = collectResumeExtension(cliFlags, config);
  const resumeExtend = resumed.extension;

  // Piping a field via stdin (`--goal -`) drains the ONLY stdin stream, so the interactive Seal
  // prompt that a non-autonomous run needs would read EOF / hang. That used to be a doc-note
  // footgun; fail closed here with the exact fix instead of deadlocking at the gate.
  const stdinField = MULTI_SOURCE_FIELDS.find((f) => flags[f] === '-');
  if (stdinField !== undefined && !config.autonomous) {
    throw new UsageError(
      `--${stdinField} - reads from stdin, leaving no stdin for the interactive Seal prompt. ` +
        `Add --autonomous (the contract is still frozen & logged), or use --${stdinField}-file.`,
    );
  }

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
    planFile: str(flags, 'plan-file'),
    resumeRunId: str(flags, 'resume'),
    resumeExtend,
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

function helpResult(): ParsedArgs {
  return baseArgs('help', undefined, process.cwd());
}

function runsResult(parsed: { runs: RunsCommand; workspace: string }): ParsedArgs {
  return baseArgs('runs', parsed.runs, parsed.workspace);
}

function worktreeResult(parsed: { worktree: WorktreeCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('worktree', undefined, parsed.workspace), worktree: parsed.worktree };
}

function uiResult(parsed: { ui: UiCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('ui', undefined, parsed.workspace), ui: parsed.ui };
}

function doctorResult(parsed: { doctor: DoctorCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('doctor', undefined, parsed.workspace), doctor: parsed.doctor };
}

function initResult(parsed: { init: InitCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('init', undefined, parsed.workspace), init: parsed.init };
}

function configResult(parsed: { config: ConfigCommand; workspace: string }): ParsedArgs {
  return { ...baseArgs('config', undefined, parsed.workspace), configCmd: parsed.config };
}

/**
 * The shared {@link ParsedArgs} scaffold for the non-`run` commands (help / runs). The run-specific
 * fields are placeholders never read for those commands — only `command`, `runs` and `workspace`
 * carry meaning.
 */
function baseArgs(
  command: ParsedArgs['command'],
  runs: RunsCommand | undefined,
  workspace: string,
): ParsedArgs {
  return {
    command,
    runs,
    worktree: undefined,
    ui: undefined,
    doctor: undefined,
    init: undefined,
    configCmd: undefined,
    completion: undefined,
    worktreeRun: undefined,
    // a placeholder config; never used for the help / runs commands.
    config: cliInputToRunConfig(CliInput.parse({ goal: 'help', verifyCmd: 'true' })),
    harness: 'claude',
    harnessExplicit: false,
    models: ModelSelection.parse({}),
    llmProvider: 'claude',
    llmProviderExplicit: false,
    harnessAutonomy: undefined,
    dryRun: false,
    workspace,
    workspaceMode: 'auto',
    baseline: undefined,
    verifyDir: undefined,
    planFile: undefined,
    resumeRunId: undefined,
    fromRunId: undefined,
    inheritSession: false,
    recontract: undefined,
    logLevel: 'info',
    logFile: undefined,
    noLogFile: false,
    stream: false,
    explain: false,
    streamTranscript: false,
    streamFile: undefined,
    timeouts: {},
    maxAgentTurns: undefined,
    sandbox: SandboxPolicy.parse({}),
    costTablePath: undefined,
    configSources: [],
    warnings: [],
    baseUrl: undefined,
    llmApiKeyEnv: 'OPENAI_API_KEY',
    resumeExtend: undefined,
    delegation: undefined,
  };
}
