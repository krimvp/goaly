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
  /**
   * Idle/heartbeat cap on the harness subprocess (issue #56): kill it only after this long with no
   * stream output, so a slow-but-progressing build turn survives while a genuine stall is reaped.
   * The wall-clock `harnessMs` remains the absolute backstop when both are set.
   */
  harnessIdleMs?: number;
  /** Wall-clock cap on each LLM step (judge / approver / compiler). */
  llmMs?: number;
  /** Wall-clock cap on the verify command (a timeout is a fail-closed non-zero exit). */
  verifyMs?: number;
  /** Wall-clock cap on the one-time setup command (Fix #1; a timeout is a fail-closed SETUP_FAILED). */
  setupMs?: number;
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
  /**
   * Diff baseline (issue #47): the git ref/SHA `diff()`/Sign-off compare the working tree against,
   * instead of `HEAD`. Pure wiring — never enters the frozen contract. Validated to resolve
   * (fail-closed) before the run starts. Precedence: CLI flag > config file.
   */
  baseline: string | undefined;
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
               [--smoke "<cmd>"] [--setup-cmd "<cmd>" | --no-setup] [--setup-timeout-ms N]
               [--rubric "<rubric>"] [--autonomous] [--max-iterations N]
               [--phased [--max-phases N] [--max-plan-revisions N] [--plan-file <p>]
                         [--planner-model <m>]]
               [--max-seal-revisions N] [--max-compile-retries N] [--verify-dir <dir>]
               [--budget-tokens N] [--budget-wall-ms N] [--diff-ignore "<p1,p2,…>"]
               [--stuck-no-diff true|false] [--stuck-repeat-threshold N]
               [--stuck-oscillation true|false]
               [--harness claude-code|codex|droid] [--model <m>] [--llm-model <m>]
               [--llm-provider claude|codex|droid] [--harness-timeout-ms N]
               [--llm-timeout-ms N] [--verify-timeout-ms N] [--config <path>]
               [--sandbox[=none|auto|bwrap|container]]
               [--sandbox-net none|allow|allow:<host,…>]
               [--sandbox-image <ref>] [--sandbox-runtime docker|podman]
               [--cost-table <path>] [--baseline <ref>] [--delta-verify] [--workspace <dir>] [--resume <runId>]
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
  --smoke <cmd>  add an artifact-RUNNING smoke rung (issue #53): an extra deterministic, ungameable
                  bar (a second --verify-cmd) that EXECUTES the built artifact and asserts on runtime
                  behavior, instead of a judge guessing from source. It's runtime-agnostic — the cmd
                  can be a headless-browser script, a server probe, a CLI smoke, anything that exits
                  non-zero on failure (e.g. --smoke "node smoke.mjs"). Frozen into the contract like
                  any rung, capped by --verify-timeout-ms, and run after --verify-cmd but before the
                  judge, so a runtime failure is caught deterministically, not guessed. Combine with
                  --verify-cmd or --generate to keep both the test bar and the runtime bar.
  --setup-cmd <cmd>  one-time workspace bootstrap run ONCE after SEAL and BEFORE the first agent
                      turn (e.g. "npm ci", "pip install -r requirements.txt", "go mod download"), so
                      the worker starts from a populated tree instead of improvising around missing
                      deps. It is NOT a verification rung — it never gates DONE and is never judged.
                      With --generate the compiler AUTHORS a setup command for you (delegated like the
                      contract); --setup-cmd OVERRIDES it. A non-zero exit is a typed, fail-closed
                      SETUP_FAILED that aborts before any worker tokens are spent. Frozen into the
                      contract (shown at SEAL) so it can't drift. Capped by --setup-timeout-ms.
  --no-setup         disable the setup phase entirely — drop any authored/--setup-cmd bootstrap and
                      start the worker on the tree as-is.
  --verify-dir <dir>  preferred directory for files the compiler authors under --generate (issue
                      #52). Authored files are written to idiomatic locations and AUTO-REGISTERED in
                      .git/info/exclude (git's per-clone, never-committed ignore) — so they never
                      show in 'git status' and are never accidentally committed, with no .gitignore
                      edit and no tracked file touched. A loud log line names each authored file and
                      how to keep it ('git add -f'). The integrity guard still pins them by content
                      hash on disk (excluded ≠ unprotected). Absent ⇒ the compiler picks the dir.

Diff baseline (issue #47 — keep a run's diff small without touching the user's git history):
  --baseline <ref>  compute the worker's diff (the approver's Sign-off input) against <ref> — any git
                    ref or SHA — instead of HEAD. Validated to resolve before the run starts
                    (fail-closed on an unknown ref). Use it to chain multi-step builds: point run
                    N+1 at where run N finished, so each run reviews only its own delta — no
                    user-visible commits required. The no-op tree hash that drives stuck-detection is
                    unaffected (it always hashes the working tree). Precedence: CLI flag > config.
  --delta-verify    (issue #49) keep the per-iteration JUDGE prompt flat across a long run: after each
                    continuation iteration goaly takes an internal checkpoint (a --baseline-style tree,
                    no commit) so the NEXT iteration's judge reviews only that iteration's delta, not
                    the whole cumulative diff. The DONE decision stays cumulative — the deterministic
                    rungs always run on the FULL working tree (ungameable), and the terminal Sign-off
                    approver reviews the diff against the run's START baseline — so a change smeared
                    across iterations is still caught. Default off. A no-op under --phased (which
                    already decomposes). For a huge MONOLITHIC change, prefer --phased to bound the
                    cumulative diff the terminal approver ingests.

Stuck-detection tuning:
  --diff-ignore "<p1,p2,…>"  comma-separated extra paths kept OUT of the working-tree hash that
                             drives no-diff/oscillation detection, beyond the always-excluded
                             .goaly state dir. List verifier-produced artifacts (e.g.
                             "coverage,__pycache__,dist") so a verifier's side effects between
                             iterations don't make a no-op agent look like it changed something.
  --stuck-no-diff <bool>          toggle the no-diff abort (default true). Even when on, a no-diff
                                  iteration is NOT terminal if the previous turn timed out, or if the
                                  ladder is green and a FRESH veto is the only blocker — the agent
                                  gets one real turn to act on a correct critique first (issue #54).
  --stuck-repeat-threshold N      abort after N identical normalized verifier failures (default 3).
  --stuck-oscillation <bool>      toggle diff-hash oscillation detection (default true).

Phased decomposition (issue #48 — split one big goal into a frozen plan of small, verified phases):
  --phased            turn one big goal into a PLAN of ordered sub-goals, each run as its OWN frozen,
                      two-key contract with an internal checkpoint (issue #47) between phases so each
                      phase's diff stays small — finished by a CUMULATIVE ACCEPTANCE contract on the
                      ORIGINAL goal (so decomposition can't green a goal whose parts pass but whole
                      doesn't). Flow: PLAN → [plan Seal] → per phase {compile → Seal → loop → checkpoint}
                      → ACCEPT → DONE | FAILED. The plan is frozen (hashed + logged) and no transition
                      rewrites it; re-planning is only the bounded, human-gated plan-Seal revise path.
                      The whole-run --budget-tokens cap is the sum across ALL phases. The acceptance
                      contract reuses your original verification: --verify-cmd becomes the cumulative
                      deterministic bar, or --generate authors cumulative acceptance on the original goal.
  --plan-file <p>     source the plan from a JSON file ({ "phases": [{ "goal", "intent"?, "rubric"? }] })
                      instead of authoring it with the LLM. Parsed fail-closed; a bad file is a typed
                      PLAN_FAILED, never a skipped decomposition.
  --max-phases N      cap the number of sub-goals a plan may contain (default 10); a longer plan is a
                      fail-closed PLAN_FAILED.
  --max-plan-revisions N  cap the free-text plan-Seal revise rounds (default 10; 0 disables revision).
  --planner-model <m> model for the planner step only (cascades like the other LLM-step models).
  --autonomous        also auto-accepts the plan AND each phase contract — still frozen + logged loudly.

Compile resilience (issue #51):
  --max-compile-retries N    on a COMPILE_FAILED, re-author the verification with the error as
                             feedback up to N times before failing the run (default 2; 0 disables).
                             A correctable authoring mistake (bad path, transient parse miss) no
                             longer discards a valid plan. Exhausting the budget is still a typed
                             FAILED — never a skipped check.

Model selection (all optional; default = each tool's own default):
  --model <m>           model for the harness AND the LLM steps (the global default)
  --llm-model <m>       model for all LLM steps (judge / approver / compiler)
  --judge-model <m>     model for the LLM-judge rung only
  --approver-model <m>  model for the Sign-off approver only
  --compiler-model <m>  model for the verification compiler only
  --planner-model <m>   model for the phased planner only (issue #48)
  --llm-provider <p>    which CLI runs the LLM steps: claude (default) | codex | droid
  Precedence per LLM step: per-step flag → --llm-model → --model. The harness follows --model.

Seal (contract approval):
  default                     print the frozen contract and prompt for one of:
                                a / approve   accept it and start the loop
                                f / feedback  type a note; the contract is re-authored & re-shown
                                r / reject    abort the run (the loop never starts)
  --max-seal-revisions N    cap the free-text revise rounds (default 10; 0 disables revision)
  --autonomous                skip the prompt: auto-accept (still frozen; logged loudly)

  Note: piping the goal via stdin (--goal -) leaves no stdin for the interactive prompt;
  pair it with --autonomous, or read the goal from a file (--goal-file) instead.

Per-step timeouts (subprocess kill-timeouts in milliseconds; all optional, pure wiring):
  --harness-timeout-ms N      cap the harness (coding-agent) subprocess (default 600000 = 10 min)
  --harness-idle-timeout-ms N idle/heartbeat cap on the harness: kill it only after N ms with NO
                              stream output, so a slow-but-progressing build turn survives while a
                              genuine stall is reaped. Recommended for build-heavy / --phased runs
                              that legitimately exceed the wall-clock cap. The wall-clock
                              --harness-timeout-ms stays the absolute backstop. Default: off.
  --llm-timeout-ms N       cap each LLM step: judge / approver / compiler (default 600000)
  --verify-timeout-ms N    cap the verify command (default: unbounded). A timeout is a
                           fail-closed non-zero exit, i.e. a verifier FAIL — never a green. Also caps
                           each deterministic rung run during the Fix #2 pre-flight.
  --setup-timeout-ms N     cap the one-time --setup-cmd bootstrap (default 600000 = 10 min). A
                           timeout is a fail-closed SETUP_FAILED.

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
  goaly runs show <runId>   the frozen contract (+ hash), Seal outcome, the per-iteration
                            verifier-ladder results and Sign-off verdicts, the stuck/failure reason,
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

/**
 * Parse a tri-state boolean flag (issue #54): a bare `--flag` ⇒ true, `--flag true|1|yes` ⇒ true,
 * `--flag false|0|no` ⇒ false. Returns undefined when absent so the schema default applies; fails
 * closed (invariant #6) on any other value. Used for the stuck-policy toggles, which must be
 * DISABLE-able (so a plain coerced boolean — where any non-empty string is truthy — won't do).
 */
function boolFlag(flags: RawFlags, key: string): boolean | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  // A bare CLI flag is `true`; a config-file JSON boolean may be either literal.
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new UsageError(`--${key}: expected true or false, got '${String(v)}'`);
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

  // `--max-gate-a-revisions` was renamed to `--max-seal-revisions` (no alias). The CLI otherwise
  // ignores unknown flags, so reject the removed spelling explicitly — silently dropping a flag a
  // user's script used to rely on would lose the setting without warning.
  if (cliFlags['max-gate-a-revisions'] !== undefined) {
    throw new UsageError('--max-gate-a-revisions was renamed to --max-seal-revisions');
  }

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
    ...(str(flags, 'smoke') !== undefined ? { smoke: str(flags, 'smoke') } : {}),
    ...(str(flags, 'setup-cmd') !== undefined ? { setupCmd: str(flags, 'setup-cmd') } : {}),
    ...(flags['no-setup'] !== undefined ? { noSetup: true } : {}),
    ...(resolved.intent !== undefined ? { intent: resolved.intent } : {}),
    ...(resolved.rubric !== undefined ? { rubric: resolved.rubric } : {}),
    ...(flags['autonomous'] !== undefined ? { autonomous: true } : {}),
    ...(str(flags, 'max-iterations') !== undefined
      ? { maxIterations: str(flags, 'max-iterations') }
      : {}),
    ...(flags['phased'] !== undefined ? { phased: true } : {}),
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
    ...(boolFlag(flags, 'stuck-no-diff') !== undefined
      ? { stuckNoDiff: boolFlag(flags, 'stuck-no-diff') }
      : {}),
    ...(str(flags, 'stuck-repeat-threshold') !== undefined
      ? { stuckRepeatThreshold: str(flags, 'stuck-repeat-threshold') }
      : {}),
    ...(boolFlag(flags, 'stuck-oscillation') !== undefined
      ? { stuckOscillation: boolFlag(flags, 'stuck-oscillation') }
      : {}),
    ...(str(flags, 'budget-tokens') !== undefined
      ? { budgetTokens: str(flags, 'budget-tokens') }
      : {}),
    ...(str(flags, 'budget-wall-ms') !== undefined
      ? { budgetWallClockMs: str(flags, 'budget-wall-ms') }
      : {}),
    ...(str(flags, 'diff-ignore') !== undefined ? { diffIgnore: str(flags, 'diff-ignore') } : {}),
    ...(flags['delta-verify'] !== undefined ? { deltaVerify: true } : {}),
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
    baseline: str(flags, 'baseline'),
    verifyDir: str(flags, 'verify-dir'),
    planFile: str(flags, 'plan-file'),
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
  const harnessIdleMs = ms('harness-idle-timeout-ms');
  const llmMs = ms('llm-timeout-ms');
  const verifyMs = ms('verify-timeout-ms');
  const setupMs = ms('setup-timeout-ms');
  return {
    ...(harnessMs !== undefined ? { harnessMs } : {}),
    ...(harnessIdleMs !== undefined ? { harnessIdleMs } : {}),
    ...(llmMs !== undefined ? { llmMs } : {}),
    ...(verifyMs !== undefined ? { verifyMs } : {}),
    ...(setupMs !== undefined ? { setupMs } : {}),
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
 * Parse the `--sandbox-net` value into the policy's `network` shape. `none`/`allow` map to the
 * literals; an `allow:<host,host,…>` value (issue #39) maps to an `{ allowlist }` object so only the
 * listed hosts are reachable. Returns the raw value untouched for anything else so the Zod seam
 * produces the usage error (fail-closed, invariant #6).
 */
function parseSandboxNet(net: string): unknown {
  const prefix = 'allow:';
  if (!net.startsWith(prefix)) return net;
  const allowlist = net
    .slice(prefix.length)
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h.length > 0);
  return { allowlist };
}

/**
 * Build the opt-in sandbox policy from the flags, validating each at the Zod seam (invariant #6):
 * an unknown `--sandbox` mode / `--sandbox-net` value / `--sandbox-runtime` is a usage error, never
 * a silent fallback. `--sandbox` with NO value (a boolean flag) means `--sandbox=auto`. Absent flags
 * are omitted so the schema's defaults apply (`mode: 'none'` ⇒ behavior unchanged). The `network`
 * here is the VERIFIER default; the harness seam re-overrides to `allow` downstream UNLESS an
 * allowlist is set (issue #39), in which case the allowlist constrains both seams.
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
    ...(net !== undefined ? { network: parseSandboxNet(net) } : {}),
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
  add('plannerModel', 'planner-model');
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
    baseline: undefined,
    verifyDir: undefined,
    planFile: undefined,
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
