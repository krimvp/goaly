import { z } from 'zod';
import { CliInput, cliInputToRunConfig, type RunConfig } from '../domain/config';
import { SandboxPolicy } from '../sandbox/policy';
import { LogLevel } from '../log/logger';
import { ModelSelection, type ModelSelectionInput } from './models';
import { resolveInputSources, defaultReaders, type InputReaders } from './input-sources';
import { loadConfig, type LoadedConfig } from './config-file';

export type HarnessChoice = 'claude-code' | 'codex' | 'droid' | 'fake';

/** Which CLI runs the LLM workflow steps (judge / approver / compiler). */
export type LlmProviderChoice = 'claude' | 'codex' | 'droid';

/** The read-only run-inspection subcommand (`goaly runs list` / `goaly runs show <id>`). */
export type RunsCommand = { readonly kind: 'list' } | { readonly kind: 'show'; readonly runId: string };

/**
 * Per-step subprocess kill-timeouts in milliseconds (pure wiring — never enters the contract).
 * Each is optional: when absent the step keeps its built-in default (harness/LLM = 10 min; the
 * verify command is otherwise unbounded). A field is present only when the user set it.
 */
export type StepTimeouts = {
  /** Wall-clock cap on the harness (coding-agent) subprocess. */
  harnessMs?: number;
  /** Wall-clock cap on each LLM step (judge / approver / compiler). */
  llmMs?: number;
  /** Wall-clock cap on the verify command (a timeout is a fail-closed non-zero exit). */
  verifyMs?: number;
};

export type ParsedArgs = {
  command: 'run' | 'help' | 'runs';
  /** The read-only inspection subcommand; present only when `command === 'runs'`. */
  runs: RunsCommand | undefined;
  config: RunConfig;
  harness: HarnessChoice;
  models: ModelSelection;
  llmProvider: LlmProviderChoice;
  workspace: string;
  resumeRunId: string | undefined;
  /** Minimum diagnostic log level (default `info`). Pure wiring — never enters the contract. */
  logLevel: LogLevel;
  /** Override the diagnostics file path (default `<workspace>/.goaly/<runId>/goaly.log`). */
  logFile: string | undefined;
  /** Disable the diagnostics file sink (console only). */
  noLogFile: boolean;
  /** Stream the agent run AND the LLM steps' intermediate turns live to stderr (opt-in). */
  stream: boolean;
  /** Persist the canonical stream as JSONL to `<workspace>/.goaly/<runId>/stream.jsonl` (opt-in). */
  streamTranscript: boolean;
  /** Override the stream-transcript path (implies `--stream-transcript`). */
  streamFile: string | undefined;
  /** Per-step subprocess timeouts (pure wiring; each absent ⇒ that step keeps its default). */
  timeouts: StepTimeouts;
  /** Opt-in OS-isolation policy (issue #9). Default `mode: 'none'` ⇒ behavior byte-for-byte unchanged. */
  sandbox: SandboxPolicy;
  /** Optional `--cost-table` JSON path: prices the token report (USD per 1M tokens). Default off. */
  costTablePath: string | undefined;
  /** Config files that supplied default flags, lowest-precedence first (pure wiring; for logging). */
  configSources: string[];
};

export const USAGE = `goaly — run a coding agent until a frozen success contract is met.

Usage:
  goaly run --goal "<goal>" [--verify-cmd "<cmd>" | --generate [--intent "<hint>"]]
               [--rubric "<rubric>"] [--autonomous] [--max-iterations N]
               [--max-gate-a-revisions N] [--budget-tokens N] [--budget-wall-ms N]
               [--diff-ignore "<p1,p2,…>"]
               [--harness claude-code|codex|droid] [--model <m>] [--llm-model <m>]
               [--llm-provider claude|codex|droid] [--harness-timeout-ms N]
               [--llm-timeout-ms N] [--verify-timeout-ms N] [--config <path>]
               [--sandbox[=none|auto|bwrap|container]] [--sandbox-net none|allow]
               [--sandbox-image <ref>] [--sandbox-runtime docker|podman]
               [--cost-table <path>] [--workspace <dir>] [--resume <runId>]
               [--log-level debug|info|warn|error] [--log-file <path>] [--no-log-file]
               [--stream] [--stream-transcript] [--stream-file <path>]

  goaly runs list [--workspace <dir>]
  goaly runs show <runId> [--workspace <dir>]

  goaly help

Goal / intent / rubric input (choose ONE source per field):
  --goal "<text>"   inline value
  --goal-file <p>   read the value from a file
  --goal -          read the value from stdin (a lone "-")
  --intent/--intent-file and --rubric/--rubric-file work the same way.
  Giving a field more than one source — or piping stdin to more than one field — is an error.

Verification:
  --verify-cmd   point at an existing command that must exit 0
  --generate     have the agent author the verification (optionally guided by --intent)

Stuck-detection tuning:
  --diff-ignore "<p1,p2,…>"  comma-separated extra paths kept OUT of the working-tree hash that
                             drives no-diff/oscillation detection, beyond the always-excluded
                             .goaly state dir. List verifier-produced artifacts (e.g.
                             "coverage,__pycache__,dist") so a verifier's side effects between
                             iterations don't make a no-op agent look like it changed something.

Model selection (all optional; default = each tool's own default):
  --model <m>           model for the harness AND the LLM steps (the global default)
  --llm-model <m>       model for all LLM steps (judge / approver / compiler)
  --judge-model <m>     model for the LLM-judge rung only
  --approver-model <m>  model for the Gate-B approver only
  --compiler-model <m>  model for the verification compiler only
  --llm-provider <p>    which CLI runs the LLM steps: claude (default) | codex | droid
  Precedence per LLM step: per-step flag → --llm-model → --model. The harness follows --model.

Gate A (contract approval):
  default                     print the frozen contract and prompt for one of:
                                a / approve   accept it and start the loop
                                f / feedback  type a note; the contract is re-authored & re-shown
                                r / reject    abort the run (the loop never starts)
  --max-gate-a-revisions N    cap the free-text revise rounds (default 10; 0 disables revision)
  --autonomous                skip the prompt: auto-accept (still frozen; logged loudly)

  Note: piping the goal via stdin (--goal -) leaves no stdin for the interactive prompt;
  pair it with --autonomous, or read the goal from a file (--goal-file) instead.

Per-step timeouts (subprocess kill-timeouts in milliseconds; all optional, pure wiring):
  --harness-timeout-ms N   cap the harness (coding-agent) subprocess (default 600000 = 10 min)
  --llm-timeout-ms N       cap each LLM step: judge / approver / compiler (default 600000)
  --verify-timeout-ms N    cap the verify command (default: unbounded). A timeout is a
                           fail-closed non-zero exit, i.e. a verifier FAIL — never a green.

Sandboxing (opt-in OS isolation — issue #9; default OFF, behavior unchanged without it):
  --sandbox[=<mode>]  jail the two untrusted-code execs — the coding agent AND the verify command —
                      where <mode> is one of:
                        none       (default) no isolation; the caller is responsible (CI/container)
                        auto       detect the best available mechanism (bwrap on Linux, else container)
                        bwrap      Linux bubblewrap
                        container  a docker/podman 'run --rm' (portable; covers macOS)
                      Bare --sandbox means --sandbox=auto. If a requested mechanism is absent the run
                      REFUSES TO START (fail-closed) — it never silently runs unsandboxed. Per-seam
                      profile: the agent keeps network + full env; the verifier gets no network by
                      default + the already-scrubbed env; $HOME credentials (~/.ssh, ~/.aws, …) are
                      denied in both; git plumbing is never sandboxed.
  --sandbox-net <v>   verifier egress: none (default when sandboxed) | allow. The agent always keeps
                      egress (it needs the model API). NOTE: 'npm test' that fetches the network needs
                      --sandbox-net allow.
  --sandbox-image <ref>      container image (container mode only; default debian:stable-slim)
  --sandbox-runtime <r>      docker | podman (container mode only; default docker)

Config file (so the same wiring need not be repeated every run):
  Defaults are read from a JSON config in two layers (later overrides earlier):
    1. an implicit .goalyrc found in --workspace (or the cwd) — optional,
    2. an explicit --config <path> JSON file — when given it must exist.
  Keys mirror the flag names in kebab-case (e.g. "verify-cmd", "max-iterations",
  "harness-timeout-ms"); booleans like "autonomous" take true/false. Any flag passed on the
  command line overrides the file. Example .goalyrc:
    { "harness": "codex", "autonomous": true, "max-iterations": 8, "verify-cmd": "npm test" }
  Precedence: CLI flag > --config file > .goalyrc > tool default. Per-invocation flags
  (--workspace, --resume, --config) are never read from a file.

Per-run spend report (printed at the end of every run; stored in the run log):
  Tokens are summarized by layer — harness vs. the LLM steps (compiler / judge / approver) —
  and against any --budget-tokens cap. Missing token data degrades to "unknown", never a crash.
  --cost-table <p>  optional JSON mapping model → USD per 1,000,000 tokens (a "default" key
                    prices any unlisted model). Adds an approximate cost overlay; OFF by default
                    (tokens-only), since prices go stale. Example cost-table.json:
                      { "claude-sonnet-4-6": 3, "default": 5 }

Diagnostics (leveled, structured logging — separate from the write-ahead run log):
  --log-level <l>   minimum level: debug | info | warn | error (default info). debug is the
                    step-by-step firehose; prompts/output/diff stay at debug, never info.
  --log-file <p>    override the rotating diagnostics file (default
                    <workspace>/.goaly/<runId>/goaly.log; size-rotated, 5 MiB × 3 archives).
  --no-log-file     console only — write no diagnostics file.

Live streaming & transcript (opt-in observability — issues #23 / #28):
  --stream          render the agent run AND the LLM steps' intermediate turns (tool uses,
                    assistant messages, token counts) to stderr as they happen, each tagged by
                    phase ([agent] / [compile] / [judge] / [approve]). Independent of --log-level
                    (which routes the same events into the diagnostics file at debug). Pure
                    observability: it never touches the frozen contract, the verifier, or the run
                    log. All bundled harnesses stream (claude-code & droid via stream-json, codex
                    via its --json JSONL); a tool that only emits a final envelope degrades to a
                    closing summary.
  --stream-transcript  ALSO persist that canonical stream durably as JSONL to
                    <workspace>/.goaly/<runId>/stream.jsonl — one { phase, ...event, ts } object per
                    line, identical in shape across every harness. A SEPARATE file from the run log
                    (never the replay source); read it back offline with readStreamTranscript().
                    Independent of --stream and --log-level; fail-closed (a write failure degrades
                    to "no transcript", never a changed outcome).
  --stream-file <p> write the transcript to <p> instead of the default path (implies
                    --stream-transcript).

Run history & inspection (read-only — pure replay of the write-ahead run log, no re-running):
  goaly runs list           a table of past runs under <workspace>/.goaly: id, status, iterations,
                            tokens, started/ended, goal. Corrupt logs are flagged, never dropped.
  goaly runs show <runId>   the frozen contract (+ hash), Gate A outcome, the per-iteration
                            verifier-ladder results and Gate B verdicts, the stuck/failure reason,
                            and totals — reconstructed by the same replay-fold that --resume uses.
  --workspace <dir>         where to look for the .goaly run-log directory (default: cwd).`;

export type RawFlags = Record<string, string | boolean>;

function parseFlags(tokens: string[]): RawFlags {
  const flags: RawFlags = {};
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.startsWith('--')) throw new UsageError(`unexpected argument: ${tok}`);
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[body] = true; // boolean flag
    } else {
      flags[body] = next;
      i++;
    }
  }
  return flags;
}

export class UsageError extends Error {}

function str(flags: RawFlags, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') throw new UsageError(`--${key} expects a value`);
  return v;
}

/** Fields that may be sourced inline / from a file / from stdin; a CLI source overrides config. */
const MULTI_SOURCE_FIELDS = ['goal', 'intent', 'rubric'] as const;

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
  if (command !== 'run') {
    throw new UsageError(`unknown command: ${command}`);
  }

  const cliFlags = parseFlags(rest);

  // A config file (.goalyrc in --workspace/cwd, plus an explicit --config <path>) supplies DEFAULT
  // flags so the same wiring need not be repeated every run (issue #15). Explicit CLI flags always
  // win. For goal/intent/rubric the CLI source may be a *different* key than the config's (e.g.
  // --goal-file vs "goal"), so a config default for such a field is dropped whenever the CLI
  // provides ANY source for it — otherwise the two would look like a conflicting double-source.
  const workspaceDir = str(cliFlags, 'workspace') ?? process.cwd();
  const { overlay, sources: configSources } = await load(workspaceDir, str(cliFlags, 'config'));
  const overlayFlags: RawFlags = { ...overlay };
  for (const field of MULTI_SOURCE_FIELDS) {
    if (cliFlags[field] !== undefined || cliFlags[`${field}-file`] !== undefined) {
      delete overlayFlags[field];
    }
  }
  const flags: RawFlags = { ...overlayFlags, ...cliFlags };

  // Goal/intent/rubric may come from inline flags, files, or stdin — resolve to strings first.
  const resolved = await resolveInputSources(flags, readers);

  const cliInput = CliInput.parse({
    goal: resolved.goal,
    ...(str(flags, 'verify-cmd') !== undefined ? { verifyCmd: str(flags, 'verify-cmd') } : {}),
    ...(flags['generate'] !== undefined ? { generate: true } : {}),
    ...(resolved.intent !== undefined ? { intent: resolved.intent } : {}),
    ...(resolved.rubric !== undefined ? { rubric: resolved.rubric } : {}),
    ...(flags['autonomous'] !== undefined ? { autonomous: true } : {}),
    ...(str(flags, 'max-iterations') !== undefined
      ? { maxIterations: str(flags, 'max-iterations') }
      : {}),
    ...(str(flags, 'max-gate-a-revisions') !== undefined
      ? { maxGateARevisions: str(flags, 'max-gate-a-revisions') }
      : {}),
    ...(str(flags, 'budget-tokens') !== undefined
      ? { budgetTokens: str(flags, 'budget-tokens') }
      : {}),
    ...(str(flags, 'budget-wall-ms') !== undefined
      ? { budgetWallClockMs: str(flags, 'budget-wall-ms') }
      : {}),
    ...(str(flags, 'diff-ignore') !== undefined ? { diffIgnore: str(flags, 'diff-ignore') } : {}),
  });

  const harness = parseHarness(str(flags, 'harness'));

  return {
    command: 'run',
    runs: undefined,
    config: cliInputToRunConfig(cliInput),
    harness,
    models: parseModels(flags),
    llmProvider: parseLlmProvider(str(flags, 'llm-provider')),
    workspace: str(flags, 'workspace') ?? process.cwd(),
    resumeRunId: str(flags, 'resume'),
    logLevel: parseLogLevel(str(flags, 'log-level')),
    logFile: str(flags, 'log-file'),
    noLogFile: flags['no-log-file'] !== undefined,
    stream: flags['stream'] !== undefined,
    streamTranscript: flags['stream-transcript'] !== undefined || str(flags, 'stream-file') !== undefined,
    streamFile: str(flags, 'stream-file'),
    timeouts: parseTimeouts(flags),
    sandbox: parseSandbox(flags),
    costTablePath: str(flags, 'cost-table'),
    configSources,
  };
}

/**
 * Collect the per-step timeout flags and validate each at the seam: a positive integer number of
 * milliseconds, fail-closed on anything else. Absent flags are omitted so the step keeps its own
 * default (exactOptionalPropertyTypes: never assign `undefined`).
 */
function parseTimeouts(flags: RawFlags): StepTimeouts {
  const ms = (flag: string): number | undefined => {
    const v = str(flags, flag);
    if (v === undefined) return undefined;
    const parsed = z.coerce.number().int().positive().safeParse(v);
    if (!parsed.success) {
      throw new UsageError(`--${flag}: expected a positive integer (milliseconds), got '${v}'`);
    }
    return parsed.data;
  };
  const harnessMs = ms('harness-timeout-ms');
  const llmMs = ms('llm-timeout-ms');
  const verifyMs = ms('verify-timeout-ms');
  return {
    ...(harnessMs !== undefined ? { harnessMs } : {}),
    ...(llmMs !== undefined ? { llmMs } : {}),
    ...(verifyMs !== undefined ? { verifyMs } : {}),
  };
}

/** Validate --log-level at the seam (fails closed on an unknown level). Default `info`. */
function parseLogLevel(value: string | undefined): LogLevel {
  if (value === undefined) return 'info';
  const parsed = LogLevel.safeParse(value);
  if (!parsed.success) {
    throw new UsageError(`unknown log level: ${value} (expected debug | info | warn | error)`);
  }
  return parsed.data;
}

/**
 * Build the opt-in sandbox policy from the flags, validating each at the Zod seam (invariant #6):
 * an unknown `--sandbox` mode / `--sandbox-net` value / `--sandbox-runtime` is a usage error, never
 * a silent fallback. `--sandbox` with NO value (a boolean flag) means `--sandbox=auto`. Absent flags
 * are omitted so the schema's defaults apply (`mode: 'none'` ⇒ behavior unchanged). The `network`
 * here is the VERIFIER default; the harness seam always re-overrides to `allow` downstream.
 */
function parseSandbox(flags: RawFlags): SandboxPolicy {
  const raw = flags['sandbox'];
  // `--sandbox` (boolean) ⇒ auto; `--sandbox=<mode>` ⇒ that mode; absent ⇒ none (the default).
  const mode = raw === true ? 'auto' : raw;
  const net = str(flags, 'sandbox-net');
  const image = str(flags, 'sandbox-image');
  const runtime = str(flags, 'sandbox-runtime');
  const parsed = SandboxPolicy.safeParse({
    ...(mode !== undefined ? { mode } : {}),
    ...(net !== undefined ? { network: net } : {}),
    ...(image !== undefined ? { image } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = issue?.path[0];
    const flag =
      key === 'network'
        ? '--sandbox-net'
        : key === 'runtime'
          ? '--sandbox-runtime'
          : key === 'image'
            ? '--sandbox-image'
            : '--sandbox';
    throw new UsageError(`${flag}: ${issue?.message ?? 'invalid sandbox option'}`);
  }
  return parsed.data;
}

function parseHarness(value: string | undefined): HarnessChoice {
  if (value === undefined) return 'claude-code';
  if (value === 'claude-code' || value === 'codex' || value === 'droid' || value === 'fake') {
    return value;
  }
  throw new UsageError(`unknown harness: ${value} (expected claude-code | codex | droid | fake)`);
}

function parseLlmProvider(value: string | undefined): LlmProviderChoice {
  if (value === undefined) return 'claude';
  if (value === 'claude' || value === 'codex' || value === 'droid') return value;
  throw new UsageError(`unknown llm provider: ${value} (expected claude | codex | droid)`);
}

/** Collect the model flags and validate them at the Zod seam (non-empty, fails closed). */
function parseModels(flags: RawFlags): ModelSelection {
  const raw: Partial<Record<keyof ModelSelectionInput, string>> = {};
  const add = (key: keyof ModelSelectionInput, flag: string): void => {
    const v = str(flags, flag);
    if (v !== undefined) raw[key] = v;
  };
  add('model', 'model');
  add('llmModel', 'llm-model');
  add('judgeModel', 'judge-model');
  add('approverModel', 'approver-model');
  add('compilerModel', 'compiler-model');
  try {
    return ModelSelection.parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const issue = e.issues[0];
      const flag = issue?.path[0] !== undefined ? `--${String(issue.path[0])}` : 'a model flag';
      throw new UsageError(`${flag}: ${issue?.message ?? 'must be a non-empty value'}`);
    }
    throw e;
  }
}

/**
 * Parse the read-only `runs` subcommand. `<runId>` is a positional (not a `--flag`); only
 * `--workspace` is honoured (it locates the `.goaly` run-log directory). Fails closed on a
 * missing/unknown subcommand or a missing run id.
 */
function parseRunsCommand(rest: string[]): { runs: RunsCommand; workspace: string } {
  const [sub, ...subRest] = rest;
  if (sub === 'list') {
    return { runs: { kind: 'list' }, workspace: runsWorkspace(subRest) };
  }
  if (sub === 'show') {
    const runId = subRest[0];
    if (runId === undefined || runId.startsWith('--')) {
      throw new UsageError('runs show requires a <runId> (e.g. goaly runs show run-1234)');
    }
    return { runs: { kind: 'show', runId }, workspace: runsWorkspace(subRest.slice(1)) };
  }
  throw new UsageError(`unknown runs subcommand: ${sub ?? '(none)'} (expected list | show)`);
}

function runsWorkspace(tokens: string[]): string {
  return str(parseFlags(tokens), 'workspace') ?? process.cwd();
}

function helpResult(): ParsedArgs {
  return baseArgs('help', undefined, process.cwd());
}

function runsResult(parsed: { runs: RunsCommand; workspace: string }): ParsedArgs {
  return baseArgs('runs', parsed.runs, parsed.workspace);
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
    // a placeholder config; never used for the help / runs commands.
    config: cliInputToRunConfig(CliInput.parse({ goal: 'help', verifyCmd: 'true' })),
    harness: 'claude-code',
    models: ModelSelection.parse({}),
    llmProvider: 'claude',
    workspace,
    resumeRunId: undefined,
    logLevel: 'info',
    logFile: undefined,
    noLogFile: false,
    stream: false,
    streamTranscript: false,
    streamFile: undefined,
    timeouts: {},
    sandbox: SandboxPolicy.parse({}),
    costTablePath: undefined,
    configSources: [],
  };
}
