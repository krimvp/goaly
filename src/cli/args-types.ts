import type { RunConfig } from '../domain/config';
import type { RunExtension } from '../domain/events';
import type { SandboxPolicy } from '../sandbox/policy';
import type { LogLevel } from '../log/logger';
import type { ModelSelection } from './models';
import type { Delegation } from './delegation';
import type { DefectCorpusOptions } from '../defects/wiring';
import type { AutonomyLevel } from '../agent-cli/droid-codec';
import type { WorktreeCommand } from './worktree-cmd';
import type { DoctorCommand } from './doctor';
import type { InitCommand } from './init';
import type { HarnessChoice, LlmProviderChoice } from './flags/harness-flags';
import type { StepTimeouts } from './flags/budget-flags';
import type { RecontractRequest } from './flags/misc-flags';
import type { RunsCommand, UiCommand } from './flags/subcommands';
import type { ConfigCommand } from './config-cmd';
import type { CompletionCommand } from './completion';

/**
 * The shape `parseArgs` produces — the one {@link ParsedArgs} the rest of the CLI consumes — plus
 * the two small constants its assembly and its consumers share. Types only (no logic) so every
 * `args-*` module can name the result without importing the coordinator.
 */

export type ParsedArgs = {
  command:
    | 'run'
    | 'help'
    | 'version'
    | 'runs'
    | 'worktree'
    | 'ui'
    | 'doctor'
    | 'init'
    | 'config'
    | 'completion';
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
  delegation: Delegation | undefined;
  /**
   * The cross-run DEFECT CORPUS (issue #122): `--no-defect-corpus` disables it, `--defect-corpus
   * <path>` moves it off `~/.goaly/defects.jsonl`. Pure wiring — it shapes the AUTHORING prompt
   * before the freeze and can never relax the frozen bar or the two keys.
   */
  defects: DefectCorpusOptions;
};

/** Fields that may be sourced inline / from a file / from stdin; a CLI source overrides config. */
export const MULTI_SOURCE_FIELDS = ['goal', 'intent', 'rubric'] as const;

/**
 * Stand-in goal used when `--resume` is given without one. On resume the RunConfig parseArgs builds is
 * discarded — main.ts continues from the frozen run log's config — so the goal is never read; this only
 * satisfies `CliInput`'s non-empty-goal schema. It must never surface (a real resume overwrites it).
 */
export const RESUMED_GOAL_PLACEHOLDER = '(resumed run — goal is read from the frozen run log)';
