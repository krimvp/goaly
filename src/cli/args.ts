import { z } from 'zod';
import { CliInput, cliInputToRunConfig, type RunConfig } from '../domain/config';
import type { RunExtension } from '../domain/events';
import { SandboxPolicy } from '../sandbox/policy';
import { LogLevel } from '../log/logger';
import { ModelSelection, type ModelSelectionInput } from './models';
import { resolveInputSources, defaultReaders, type InputReaders } from './input-sources';
import { loadConfig, type LoadedConfig } from './config-file';
import type { AgentCli } from '../agent-cli/registry';
import type { WorktreeCommand } from './worktree-cmd';
import { WorktreeName } from '../workspace/worktree-manager';

/**
 * The harness (write-role coding agent): any bundled CLI, the IO-free `fake`, plus `goaly-code` — the
 * non-codec goaly-code harness that drives an OpenAI-compatible endpoint through goaly's own agent loop.
 */
export type HarnessChoice = AgentCli | 'fake' | 'goaly-code';

/**
 * Which provider runs the LLM workflow steps (judge / approver / compiler). Any bundled CLI, plus
 * `openai` — a direct OpenAI-compatible chat-completions endpoint (no coding CLI installed).
 */
export type LlmProviderChoice = AgentCli | 'openai';

/**
 * The read-only run-inspection subcommand (`goaly runs list` / `goaly runs show <id>` /
 * `goaly runs resume-cmd <id>`). `resume-cmd` (Capability A) prints how to continue the run's
 * underlying CLI session; `harness` is an optional fallback for a log written before the header
 * recorded the harness identity.
 */
export type RunsCommand =
  | { readonly kind: 'list' }
  | { readonly kind: 'show'; readonly runId: string }
  | { readonly kind: 'resume-cmd'; readonly runId: string; readonly harness: string | undefined }
  | { readonly kind: 'watch'; readonly runId: string };

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

/** The `goaly ui` subcommand: the local web UI server (ADR 0014). */
export type UiCommand = {
  /** Port to listen on (default 4180). */
  readonly port: number | undefined;
};

export type ParsedArgs = {
  command: 'run' | 'help' | 'runs' | 'worktree' | 'ui';
  /** The read-only inspection subcommand; present only when `command === 'runs'`. */
  runs: RunsCommand | undefined;
  /** The worktree-management subcommand; present only when `command === 'worktree'`. */
  worktree: WorktreeCommand | undefined;
  /** The web-UI subcommand; present only when `command === 'ui'`. */
  ui: UiCommand | undefined;
  /**
   * Run inside a goaly-managed worktree (`--worktree [<name>]`): the run's whole workspace —
   * state dir, run lock, harness cwd, diff scope — is re-rooted at `.goaly/worktrees/<name>`
   * (created on branch `goaly/<name>` if absent). A bare `--worktree` auto-names one. Pure wiring;
   * never enters the frozen contract.
   */
  worktreeRun: string | true | undefined;
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
};

export const USAGE = `goaly — run a coding agent until a frozen success contract is met.

Quick start (the LLM authors & checks everything, with Claude — just give it a goal):
  goaly "<goal>"            run with all defaults; approve the contract interactively at Seal
  goaly -d "<goal>"         hands-off: -d / --defaults also auto-accepts the (still-frozen) contract
  Put your personal defaults in ~/.goalyrc once (e.g. { "autonomous": true }) and only the goal
  need ever be typed. The goal is a positional (sugar for --goal); 'run' is optional.

Usage:
  goaly [run] "<goal>" [flags]   (or --goal "<goal>"; see "Goal / intent / rubric input" below)
  goaly run --goal "<goal>" [--verify-cmd "<cmd>" | --generate [--intent "<hint>"]]
               [--smoke "<cmd>"] [--setup-cmd "<cmd>" | --no-setup] [--setup-timeout-ms N]
               [--install-missing-tools true|false]
               [--rubric "<rubric>"] [--autonomous] [--max-iterations N] [--candidates N]
               [--phased [--max-phases N] [--max-plan-revisions N] [--plan-file <p>]
                         [--planner-model <m>]]
               [--max-seal-revisions N] [--max-compile-retries N] [--verify-dir <dir>]
               [--budget-tokens N] [--budget-wall-ms N] [--diff-ignore "<p1,p2,…>"]
               [--stuck-no-diff true|false] [--stuck-repeat-threshold N]
               [--stuck-oscillation true|false] [--stuck-crash-threshold N]
               [--harness claude|codex|droid|pi|goaly-code] [--max-agent-turns N] [--model <m>]
               [--llm-model <m>] [--approver-quorum N] [--approver-diversity-temp T]
               [--approver-models m1,m2,…] [--approver-lenses l1,l2,…]
               [--llm-provider claude|codex|droid|pi|openai] [--harness-timeout-ms N]
               [--base-url <url>] [--llm-api-key-env <NAME>]
               [--llm-timeout-ms N] [--verify-timeout-ms N] [--config <path>]
               [--sandbox[=none|auto|bwrap|firejail|container]]
               [--sandbox-net none|allow|allow:<host,…>]
               [--sandbox-image <ref>] [--sandbox-runtime docker|podman]
               [--cost-table <path>] [--baseline <ref>] [--delta-verify] [--workspace <dir>]
               [--worktree [<name>]]
               [--resume <runId> [--note "<text>"]]
               [--from-run <runId> [--inherit-session]]
               [--log-level debug|info|warn|error] [--log-file <path>] [--no-log-file]
               [--stream] [--stream-transcript] [--stream-file <path>] [--explain] [--explain-model <m>]

  goaly runs list [--workspace <dir>]
  goaly runs show <runId> [--workspace <dir>]
  goaly runs watch <runId> [--workspace <dir>]
  goaly runs resume-cmd <runId> [--harness <name>] [--workspace <dir>]

  goaly worktree create <name> [--base <ref>] [--workspace <dir>]
  goaly worktree list [--workspace <dir>]
  goaly worktree remove <name> [--force] [--delete-branch] [--workspace <dir>]

  goaly ui [--port N] [--workspace <dir>]

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
  --install-missing-tools <bool>  what to do when a tool the verification needs (cargo, python, go…)
                      isn't on PATH (default true). true = the agent installs it (goaly skips its own
                      setup, which would only fail on the absent toolchain, and threads the install
                      into the first prompt). false = a typed, fail-closed TOOLS_MISSING abort with
                      guidance, before any token is spent.
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
                    approver reviews the cumulative diff against the run's START baseline (or, under
                    --phased, the current PHASE's start) — so a change smeared across iterations is
                    still caught. Default off. Composes with --phased: per-iteration deltas feed the
                    judge within a phase while Sign-off stays per-phase cumulative. For a huge
                    MONOLITHIC change, --phased bounds the cumulative diff the terminal approver sees.

Stuck-detection tuning:
  --diff-ignore "<p1,p2,…>"  comma-separated extra paths kept OUT of the working-tree hash that
                             drives no-diff/oscillation detection, ADDED to the always-excluded
                             .goaly state dir and the built-in ephemeral-artifact defaults (Python
                             bytecode/__pycache__, pytest/mypy/ruff caches, JS .nyc_output/htmlcov).
                             List your own verifier side effects so they don't make a no-op agent
                             look like it changed something. Each is a git pathspec (* spans /).
  --stuck-no-diff <bool>          toggle the no-diff abort (default true). Even when on, a no-diff
                                  iteration is NOT terminal if the previous turn timed out, or if the
                                  ladder is green and a FRESH veto is the only blocker — the agent
                                  gets one real turn to act on a correct critique first (issue #54).
  --stuck-repeat-threshold N      abort after N identical normalized verifier failures (default 3).
  --stuck-oscillation <bool>      toggle diff-hash oscillation detection (default true).
  --stuck-crash-threshold N       abort after N consecutive harness crashes (default 2) — a typed
                                  STUCK_HARNESS_CRASH that surfaces the harness error itself, instead
                                  of looping on the downstream verifier red an unfinished turn leaves.
  --stuck-unevaluable-threshold N abort after N consecutive iterations whose frozen verifier ladder
                                  could not be EVALUATED to a real pass/fail (default 2) — the check
                                  itself failed to RUN (a missing tool, a network/package-manager
                                  error, a timeout, or an LLM judge that errored or overflowed its
                                  context). A typed CONTRACT_UNEVALUABLE that says the verification
                                  ENVIRONMENT is broken and your tree may be correct-but-unverified,
                                  instead of a misleading no-diff/repeat abort that blames (and
                                  discards) possibly-correct work. Still fail-closed (never DONE).

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

Best-of-N parallel worker (issue #85 — tournament-select candidates against the frozen ladder):
  --candidates N      (alias --best-of N) run N independent worker attempts EACH loop iteration in
                      ISOLATED git worktrees off the current baseline tree, score each against the SAME
                      frozen verifier ladder, keep the BEST candidate's tree, and advance. N multiplies
                      per-iteration WORKER spend up to ~N× (the K attempts run concurrently); K is
                      capped at 16 (a value > 16 is a fail-closed error — each candidate is a full
                      worker + worktree), and --budget-tokens still governs total spend. Default 1 ⇒
                      the classic single attempt, byte-for-byte unchanged. The whole tournament is
                      Driver-side: the reducer sees exactly ONE winning agent run and never learns N
                      existed (the pure state machine is untouched). Ranking: a candidate that PASSES the
                      frozen ladder beats any failing one; ties break to lower token cost, then lowest
                      candidate index. If all N fail it's a normal red iteration (least-cost failing
                      candidate) that loops as usual. A candidate that crashes/times out scores a hard
                      red and can't win on merit. Composes with --phased (each sub-goal inherits N),
                      --delta-verify (the judge still sees the winner's delta), and --sandbox (each of
                      the N execs goes through the same jail). Needs a committed HEAD: on a repo with no
                      resolvable HEAD (unborn branch) a --candidates > 1 run refuses to start (fail-closed)
                      — make an initial commit or run with --candidates 1.

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
  --approver-quorum N   run Sign-off as an N-reviewer PANEL behind the unchanged approver seam
                        (default 1 = the single call, byte-for-byte unchanged). The panel greens
                        ONLY on a strict supermajority of no-veto votes (noVetoCount*2 > N) AND only
                        when every counted reviewer parsed; a reviewer that throws / times out /
                        returns unparseable output counts as a VETO, and zero parseable ⇒ veto — so
                        a panel is never weaker than the single veto. The reducer/driver still see
                        exactly one verdict. A quorum on ONE model is variance reduction, not
                        perspective independence — pair it with --approver-model (single model) or
                        --approver-models (per-reviewer models) for a genuinely independent second key.
                        COST: the panel multiplies approver LLM spend ~quorum×; that spend is metered
                        and counts against --budget-tokens. A small panel (≈3–5 reviewers) is the
                        recommended practical range; quorum 1 (the default) is cost-neutral.
  --approver-models m1,m2,…  run Sign-off as a panel of DISTINCT models for REAL per-reviewer
                        independence (follow-up to issue #84): reviewer i uses model i (cycled),
                        paired with lens i. Each is an 'approve'-metered provider on the SAME
                        --llm-provider, so all panel spend stays attributed to the approver. With ≥2
                        distinct models the panel IS the independent second key (not just variance
                        reduction). If --approver-quorum is unset it defaults to the model count;
                        a quorum > the count cycles the models. Overrides --approver-model for the panel.
  --approver-diversity-temp T  sampling temperature for an --approver-quorum > 1 panel (default 0.5,
                        in [0,2]); applied ONLY when the quorum is > 1 (a single reviewer stays at 0).
  --approver-lenses l1,l2,…  override the panel's review-lens taxonomy (issue #84): a comma-separated
                        list of operator-supplied lenses, cycled across reviewers when quorum > 1
                        (ignored at quorum 1). Each lens biases one reviewer toward a failure mode and
                        rides the approver SYSTEM prompt (operator config — the worker diff stays
                        fenced). Absent ⇒ the built-in correctness/security/goal-met/injection lenses.
  --compiler-model <m>  model for the verification compiler only
  --planner-model <m>   model for the phased planner only (issue #48)
  --explain-model <m>   model for the --explain observer only (issue #8)
  --llm-provider <p>    which provider runs the LLM steps: claude (default) | codex | droid | pi |
                        openai. 'openai' calls an OpenAI-compatible chat endpoint directly (no coding
                        CLI installed) — pair it with --base-url and a resolved --llm-model/--model.
  Precedence per LLM step: per-step flag → --llm-model → --model. The harness follows --model.
  Note: pi (pi.dev) is provider-agnostic — pass --model as "provider/id" (e.g.
  "anthropic/claude-opus-4-8", "ollama/qwen3:8b") to pick the provider+model on one flag, or omit
  --model to use pi's own configured default. Credentials come from your env / pi's config.

goaly-code harness / OpenAI-compatible endpoint (--harness goaly-code, --llm-provider openai):
  --harness goaly-code        run goaly's OWN agent loop against an OpenAI-compatible chat-completions
                        endpoint (the first non-CLI harness), instead of delegating to a coding CLI.
                        goaly owns the tool-use loop, file edits (path-guarded), and run_shell (the
                        only sandboxed exec). Requires --base-url and a resolved --model.
  --base-url <url>     the chat-completions endpoint base, e.g. https://api.openai.com/v1 or a local
                        http://localhost:11434/v1 (ollama). '/chat/completions' is appended.
  --llm-api-key-env <NAME>  env var holding the bearer token (default OPENAI_API_KEY). A keyless local
                        endpoint needs no token — leave the var unset and no Authorization is sent.
  --max-agent-turns N  cap the goaly-code agent loop at N model turns per run (default 50). A run that
                        hits the cap ends as 'truncated' (not a failure) and gets another iteration.
                        Raise it (100–200) for a hard from-scratch task whose long self-authored
                        contract eats turns. ONLY the goaly-code harness reads this — the codec
                        harnesses (claude / codex / droid / pi) manage their own turn budgets.

Seal (contract approval — the review point before any execution):
  default                     print the frozen contract and prompt for one of:
                                a / approve   accept it and start the loop
                                f / feedback  type a note; the contract is re-authored & re-shown
                                e / edited    you changed the authored verification files in your
                                              OWN editor — goaly re-reads them from disk, re-pins
                                              their hashes, RE-FREEZES the contract (new hash,
                                              logged) and re-shows it. No LLM call; never counts
                                              against --max-seal-revisions. Without this, a manual
                                              edit after compile would trip the integrity guard.
                                r / reject    abort the run (the loop never starts)
  --max-seal-revisions N    cap the free-text revise rounds (default 10; 0 disables revision —
                            [e]dited stays available even then)
  --autonomous                skip the prompt: auto-accept (still frozen; logged loudly)
  -d, --defaults              hands-off sugar for --autonomous. The other easy-mode defaults
                              (--generate, the claude LLM provider, the claude harness) already
                              apply with no flag, so -d's only effect is auto-accepting the contract.

  Note: piping the goal via stdin (--goal -) leaves no stdin for the interactive prompt, so a
  non-autonomous run refuses to start (fail-closed): pair it with --autonomous, or read the goal
  from a file (--goal-file) instead.

Per-step timeouts (subprocess kill-timeouts in milliseconds; all optional, pure wiring):
  --harness-timeout-ms N      cap the harness (coding-agent) subprocess (default 600000 = 10 min)
  --harness-idle-timeout-ms N idle/heartbeat cap on the harness: kill it only after N ms with NO
                              stream output, so a slow-but-progressing build turn survives while a
                              genuine stall is reaped. Recommended for build-heavy / --phased runs
                              that legitimately exceed the wall-clock cap. The wall-clock
                              --harness-timeout-ms stays the absolute backstop. Default: off.
  --llm-timeout-ms N       cap each LLM step: judge / approver / compiler (default 600000)
  --verify-timeout-ms N    cap the verify command (default 600000 = 10 min). A timeout is a
                           fail-closed could-not-evaluate — never a green — so a hanging check can
                           never hang the whole run. Also caps each deterministic rung run during
                           the Fix #2 pre-flight.
  --setup-timeout-ms N     cap the one-time --setup-cmd bootstrap (default 600000 = 10 min). A
                           timeout is a fail-closed SETUP_FAILED.

Sandboxing (opt-in OS isolation — issue #9; default OFF, behavior unchanged without it):
  --sandbox[=<mode>]  jail the two untrusted-code execs — the coding agent AND the verify command —
                      where <mode> is one of:
                        none       (default) no isolation; the caller is responsible (CI/container)
                        auto       detect the best available mechanism (bwrap, then firejail, on
                                   Linux, else container)
                        bwrap      Linux bubblewrap
                        firejail   Linux firejail (fallback when bwrap is absent)
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
  Defaults are read from a JSON config in three layers (later overrides earlier):
    1. a home-level ~/.goalyrc — your personal defaults across every project — optional,
    2. an implicit .goalyrc found in --workspace (or the cwd) — project defaults — optional,
    3. an explicit --config <path> JSON file — when given it must exist.
  Keys mirror the flag names in kebab-case (e.g. "verify-cmd", "max-iterations",
  "harness-timeout-ms"); booleans like "autonomous" take true/false. Any flag passed on the
  command line overrides the file. Example ~/.goalyrc for a hands-off, just-give-the-goal setup:
    { "autonomous": true }
  Example project .goalyrc:
    { "harness": "codex", "max-iterations": 8, "verify-cmd": "npm test" }
  Precedence: CLI flag > --config file > <workspace>/.goalyrc > ~/.goalyrc > tool default.
  Per-invocation flags (--workspace, --resume, --config) are never read from a file.

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
                    log. All bundled harnesses stream (claude & droid via stream-json, codex
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

Plain-language run narration (opt-in observability — issue #8):
  --explain         turn on a read-only side-LLM "observer" that narrates the run in plain language
                    at three checkpoints: the frozen contract at Seal (what "done" means), each
                    verifier-ladder run (passed/failed and why), and the terminal outcome (why it
                    ended — especially a stuck stop). Strictly advisory: it reuses the read-only LLM
                    seam and can NEVER influence the frozen contract, the verifier ladder, DECIDE, or
                    the two-key DONE. Fail-closed (an observer error degrades to "no summary", never a
                    changed outcome) and OFF by default — it costs an extra LLM call per checkpoint.
                    Summaries print to stderr (prefixed "[explain] "), separate from --stream.
  --explain-model <m>  model for the --explain observer only (cascades like the other LLM-step
                    models: --explain-model → --llm-model → --model).

Resume, steer & extend (operator control over ONE run — the frozen contract never changes):
  --resume <runId>    re-enter an INCOMPLETE run's loop exactly where the write-ahead log left it
                      (crash, Ctrl-C, kill — nothing completed is repeated). Pass any of the flags
                      below WITH --resume to extend/steer the resumed run; each is recorded in the
                      log (a RUN_EXTENDED marker) so the extension is auditable and later resumes
                      keep it. Only these OPERATIONAL knobs are extendable — never the goal, the
                      verifier, or the rubric (the contract stays frozen; both keys still gate DONE):
                        --max-iterations N      also REVIVES a run that FAILED at its iteration cap
                        --budget-tokens N       also revives a budget-ABORTED run (spend re-judged
                        --budget-wall-ms N        against the new cap; prior spend still counts)
                        --stuck-* flags         raise/toggle a tripped stuck detector to continue
                      Live in another terminal: goaly runs watch <runId>.
  --note "<text>"     (with --resume) operator guidance appended to the NEXT agent prompt — steer
                      the worker without touching the bar. Combine with Ctrl-C for mid-run steering:
                      interrupt, then 'goaly --resume <id> --note "try the other approach"'.

Follow-up after a run ends (build on a finished run — keeps every invariant by construction):
  --from-run <runId>  start a NEW run whose contract is authored AWARE of a finished run: a concise,
                      deterministic COMPACTION of the prior run (its goal, frozen bar, outcome) is fed
                      into the new run's compile-phase feedback, so the follow-up knows what just
                      happened. It runs in the SAME workspace (the prior outcome is already on disk),
                      compiles its OWN frozen, two-key contract, and is otherwise an ordinary run —
                      composes with every flag (--harness, --generate, --autonomous, --phased,
                      --baseline). Distinct from --resume (which re-enters an INCOMPLETE run's loop);
                      --from-run starts a fresh, re-verified run that builds on a terminal one.
  --inherit-session   with --from-run, also resume the prior harness session on the follow-up's FIRST
                      turn so the agent keeps its working memory. The NEW frozen contract still SOLELY
                      governs DONE — inheritance only seeds the agent's memory, never the bar. Only
                      valid with the same --harness as the prior run (session ids are harness-specific);
                      ignored under --phased. Default off (fresh session + the compaction).

Run history & inspection (read-only — pure replay of the write-ahead run log, no re-running):
  goaly runs list           a table of past runs under <workspace>/.goaly: id, status, iterations,
                            tokens, started/ended, goal. Corrupt logs are flagged, never dropped.
  goaly runs show <runId>   the frozen contract (+ hash), Seal outcome, the per-iteration
                            verifier-ladder results and Sign-off verdicts, the stuck/failure reason,
                            and totals — reconstructed by the same replay-fold that --resume uses.
  goaly runs watch <runId>  attach to a run from ANOTHER terminal and follow it LIVE: one line per
                            event (contract, seal, each agent turn / verify verdict / sign-off) as
                            it lands in the write-ahead log. Read-only (never takes the run lock).
                            Exits 0 at the terminal state; exits 1 when the run is incomplete and
                            no live process is driving it (names the --resume command).
  goaly runs resume-cmd <runId>  print the command to CONTINUE the run's underlying CLI session in its
                            OWN interactive mode (e.g. 'claude --resume <id>', 'codex resume <id>').
                            Read-only; for a goaly-code run it routes you to --from-run --inherit-session.
                            --harness <name>  fallback when the log predates harness recording.
  --workspace <dir>         where to look for the .goaly run-log directory (default: cwd).

Worktrees (run on an isolated copy of the repo; merge back with plain git):
  --worktree [<name>]       run inside the goaly-managed worktree .goaly/worktrees/<name> on branch
                            goaly/<name> — created off HEAD if absent, reused if present. The run's
                            whole workspace (state dir, run lock, agent cwd, diff scope) is rooted at
                            the worktree, so the main tree is never touched. A bare --worktree
                            auto-names one (wt-<8 hex>). Resume a worktree run with the SAME
                            --worktree <name> (its log lives under the worktree). NOTE a bare
                            --worktree followed by the goal is ambiguous — put the goal first or use
                            --worktree=<name>. Runs never commit: the merge-back hint printed at the
                            end shows the commit + 'git merge goaly/<name>' steps.
  goaly worktree create <name> [--base <ref>]  create it up front (default base: HEAD). If branch
                            goaly/<name> survives from a removed worktree, re-attach to it.
  goaly worktree list       NAME / BRANCH / HEAD / DIRTY / RUNS / PATH for every managed worktree;
                            a checkout deleted out-of-band (e.g. git clean -dfx) shows as PRUNABLE.
  goaly worktree remove <name> [--force] [--delete-branch]
                            refuses while a LIVE run is inside (always) or the tree is dirty
                            (without --force). The branch is KEPT by default for merge-back;
                            --delete-branch removes it too (unmerged commits then need --force).
  WARNING: worktrees live inside the git-ignored .goaly dir — 'git clean -dfx' on the main tree
  deletes them (committed work survives on the goaly/<name> branch; uncommitted work does not).

Web UI (observe, start & steer runs from the browser):
  goaly ui [--port N]       serve a local web UI (default http://127.0.0.1:4180) over this
                            workspace's runs AND every managed worktree's runs: a live runs table,
                            per-run detail (frozen contract, iteration ladder, sign-off verdicts,
                            spend), a live event feed (the write-ahead log tailed over SSE — works
                            for runs started in ANY terminal, read-only), and the worktrees panel
                            (create/remove). Runs can be STARTED from the browser too — they
                            execute through the exact same path as the CLI (same guards, lock,
                            write-ahead log); a non-autonomous run parks at a browser Seal modal
                            (approve / revise / reject — a real SealGate implementation, never a
                            bypass), and any non-live run can be resumed with a --note + raised
                            operational caps. One live run per tree (use worktrees to parallelize).
                            Binds 127.0.0.1 only; a non-local Host, a cross-site Origin, or a
                            state-changing request without the X-Goaly-Ui header is refused
                            (fail-closed). Ctrl-C stops the server; UI-owned runs stop cleanly and
                            stay resumable, watched runs are unaffected.`;

export type RawFlags = Record<string, string | boolean>;

/** Tokenized argv for a `run`: the `--flag` overlay plus any bare positionals (the goal). */
type ParsedTokens = { flags: RawFlags; positionals: string[] };

/** Single-dash short flags, mapped to their canonical long (boolean) name. */
const SHORT_FLAGS: Record<string, string> = { d: 'defaults' };

/**
 * Long flags that never take a value (pure booleans). A bare `--flag` is `true` and the NEXT token
 * is left for a positional — without this set the value heuristic below would wrongly swallow the
 * goal in `goaly --generate "my goal"`. (Tri-state toggles like `--stuck-no-diff` deliberately stay
 * out: they may take an explicit true/false; put the goal first to keep them unambiguous.)
 */
const VALUELESS_FLAGS = new Set([
  'generate',
  'no-setup',
  'autonomous',
  'phased',
  'delta-verify',
  'no-log-file',
  'stream',
  'explain',
  'stream-transcript',
  'defaults',
  'inherit-session',
]);

/**
 * `--defaults` / `-d` is hands-off sugar for `--autonomous`: the other easy-mode defaults
 * (generate, the claude LLM provider, the claude harness) already apply with no flag, so the
 * only thing it adds is auto-accepting the (still-frozen, still-logged) contract at Seal.
 */
function canonicalFlag(name: string): string {
  return name === 'defaults' ? 'autonomous' : name;
}

/**
 * Tokenize a `run`'s argv into a flag overlay plus positionals. A token that doesn't start with `-`
 * is a positional (the goal); `--flag`/`--flag=value`/`-d` are flags. Fails closed on an unknown
 * single-dash flag (invariant #6) rather than silently treating it as a value or positional.
 */
function parseFlags(tokens: string[]): ParsedTokens {
  const flags: RawFlags = {};
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.startsWith('-')) {
      positionals.push(tok);
      continue;
    }
    if (!tok.startsWith('--')) {
      const long = SHORT_FLAGS[tok.slice(1)];
      if (long === undefined) throw new UsageError(`unknown flag: ${tok}`);
      flags[canonicalFlag(long)] = true; // every registered short flag is a valueless boolean
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[canonicalFlag(body.slice(0, eq))] = body.slice(eq + 1);
      continue;
    }
    if (VALUELESS_FLAGS.has(body)) {
      flags[canonicalFlag(body)] = true;
      continue;
    }
    const next = tokens[i + 1];
    // A lone `-` (the stdin sentinel for --goal/--intent/--rubric) is a value, not a flag, so the
    // value-consumption check stays at `--` to keep `--goal -` working.
    if (next === undefined || next.startsWith('--')) {
      flags[canonicalFlag(body)] = true; // boolean flag
    } else {
      flags[canonicalFlag(body)] = next;
      i++;
    }
  }
  return { flags, positionals };
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

/**
 * Collect the operator extension for a `--resume` (ADR 0012) from EXPLICITLY-passed CLI flags
 * (never the config-file overlay — an extension is a per-invocation operator act). The values are
 * read off the already-validated RunConfig (so every coercion/floor is applied once); only flags
 * actually present become part of the extension — absent ones keep whatever the run log's
 * effective config says. `--note` is resume-only: on a fresh run there is no next-turn boundary to
 * attach it to, so it fails closed with the fix.
 */
function collectResumeExtension(flags: RawFlags, config: RunConfig): RunExtension | undefined {
  const resuming = str(flags, 'resume') !== undefined;
  const note = str(flags, 'note');
  if (!resuming) {
    if (note !== undefined) {
      throw new UsageError(
        '--note steers a RESUMED run (it is appended to the next agent prompt) — pair it with ' +
          '--resume <runId>. To guide a fresh run, put the guidance in the goal or --intent.',
      );
    }
    return undefined;
  }
  const has = (key: string): boolean => flags[key] !== undefined;
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
    ...(note !== undefined ? { note } : {}),
  };
  return Object.keys(extension).length > 0 ? extension : undefined;
}

/** Fields that may be sourced inline / from a file / from stdin; a CLI source overrides config. */
const MULTI_SOURCE_FIELDS = ['goal', 'intent', 'rubric'] as const;

/**
 * Stand-in goal used when `--resume` is given without one. On resume the RunConfig parseArgs builds is
 * discarded — main.ts continues from the frozen run log's config — so the goal is never read; this only
 * satisfies `CliInput`'s non-empty-goal schema. It must never surface (a real resume overwrites it).
 */
const RESUMED_GOAL_PLACEHOLDER = '(resumed run — goal is read from the frozen run log)';

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

  // On --resume the goal (and the whole contract) is read back from the FROZEN run log, not the CLI:
  // parseArgs still builds a RunConfig here, but main.ts discards it for the log's effective config.
  // So a goal is NOT required when resuming — synthesize a placeholder that will be overwritten. A
  // genuinely missing goal on a FRESH run is a clean usage error, not the raw ZodError that
  // `CliInput.parse({ goal: undefined })` would otherwise throw (which escapes as an ugly stack).
  const resuming = str(flags, 'resume') !== undefined;
  if (resolved.goal === undefined && !resuming) {
    throw new UsageError(
      'a goal is required — pass it positionally (goaly "<goal>"), or with --goal / --goal-file / ' +
        '--goal - (stdin)',
    );
  }
  const goalForParse = resolved.goal ?? RESUMED_GOAL_PLACEHOLDER;

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
    ...(candidatesFlag(flags) !== undefined ? { candidates: candidatesFlag(flags) } : {}),
    ...(parseResumeBestOfIncomplete(flags) !== undefined
      ? { resumeBestOfIncomplete: parseResumeBestOfIncomplete(flags) }
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
    ...(str(flags, 'stuck-crash-threshold') !== undefined
      ? { stuckCrashThreshold: str(flags, 'stuck-crash-threshold') }
      : {}),
    ...(str(flags, 'stuck-unevaluable-threshold') !== undefined
      ? { stuckUnevaluableThreshold: str(flags, 'stuck-unevaluable-threshold') }
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
  });

  const harness = parseHarness(str(flags, 'harness'));
  const config = cliInputToRunConfig(cliInput);
  // Explicitness for the resume extension is judged on CLI flags ONLY (never the config-file
  // overlay): a `.goalyrc` default like "budget-tokens" must not append a RUN_EXTENDED marker to
  // the log on every resume — an extension is an explicit per-invocation operator act.
  const resumeExtend = collectResumeExtension(cliFlags, config);

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
    worktreeRun: parseWorktreeRun(flags),
    config,
    harness,
    models: parseModels(flags),
    llmProvider: parseLlmProvider(str(flags, 'llm-provider')),
    workspace: str(flags, 'workspace') ?? process.cwd(),
    baseline: str(flags, 'baseline'),
    verifyDir: str(flags, 'verify-dir'),
    planFile: str(flags, 'plan-file'),
    resumeRunId: str(flags, 'resume'),
    resumeExtend,
    fromRunId: str(flags, 'from-run'),
    inheritSession: flags['inherit-session'] !== undefined,
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
    baseUrl: str(flags, 'base-url'),
    llmApiKeyEnv: str(flags, 'llm-api-key-env') ?? 'OPENAI_API_KEY',
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

/**
 * The hard upper bound on `--candidates` / `--best-of` (issue #85 OQ4). Each candidate is a full
 * CONCURRENT worker run in its own git worktree, so an unbounded K is a resource-exhaustion footgun —
 * a value above this is a fail-closed UsageError. `--budget-tokens` still governs total spend below it.
 */
export const MAX_CANDIDATES = 16;

/**
 * Resolve `--candidates N` (alias `--best-of N`) at the seam (issue #85): a positive integer best-of-N
 * candidate count CAPPED at {@link MAX_CANDIDATES}, fail-closed on anything else (invariant #6). The
 * two spellings are aliases; giving both is a conflict. Absent ⇒ undefined so the schema default (1)
 * applies.
 */
function candidatesFlag(flags: RawFlags): string | undefined {
  const primary = str(flags, 'candidates');
  const alias = str(flags, 'best-of');
  if (primary !== undefined && alias !== undefined) {
    throw new UsageError('use one of --candidates / --best-of, not both');
  }
  const value = primary ?? alias;
  if (value === undefined) return undefined;
  const parsed = z.coerce.number().int().positive().max(MAX_CANDIDATES).safeParse(value);
  if (!parsed.success) {
    throw new UsageError(
      `--candidates: expected a positive integer ≤ ${MAX_CANDIDATES}, got '${value}'`,
    );
  }
  return value;
}

/**
 * Validate `--resume-best-of-incomplete <rerun|collapse>` at the seam (issue #85 follow-up): the
 * best-of-N resume policy, fail-closed on any other value (invariant #6). Absent ⇒ undefined so the
 * schema default (`'rerun'`, the historical behavior) applies.
 */
function parseResumeBestOfIncomplete(flags: RawFlags): 'rerun' | 'collapse' | undefined {
  const v = str(flags, 'resume-best-of-incomplete');
  if (v === undefined) return undefined;
  const parsed = z.enum(['rerun', 'collapse']).safeParse(v);
  if (!parsed.success) {
    throw new UsageError(
      `--resume-best-of-incomplete: expected 'rerun' or 'collapse', got '${v}'`,
    );
  }
  return parsed.data;
}

/**
 * Validate `--max-agent-turns N` at the seam (follow-on E): a positive integer turn cap for the
 * goaly-code agent loop, fail-closed on anything else (invariant #6). Absent ⇒ undefined so the
 * harness keeps its built-in default (50).
 */
function parseMaxAgentTurns(flags: RawFlags): number | undefined {
  const v = str(flags, 'max-agent-turns');
  if (v === undefined) return undefined;
  const parsed = z.coerce.number().int().positive().safeParse(v);
  if (!parsed.success) {
    throw new UsageError(`--max-agent-turns: expected a positive integer, got '${v}'`);
  }
  return parsed.data;
}

/**
 * Validate `--approver-quorum N` at the seam (issue #84): a positive integer reviewer count for the
 * Sign-off panel, fail-closed on anything else (invariant #6). Absent ⇒ undefined so the
 * approver-block default (1 ⇒ the single-call approver) applies.
 */
function parseApproverQuorum(flags: RawFlags): number | undefined {
  const v = str(flags, 'approver-quorum');
  if (v === undefined) return undefined;
  const parsed = z.coerce.number().int().positive().safeParse(v);
  if (!parsed.success) {
    throw new UsageError(`--approver-quorum: expected a positive integer, got '${v}'`);
  }
  return parsed.data;
}

/**
 * Validate `--approver-diversity-temp T` at the seam (issue #84): a sampling temperature in [0,2]
 * applied ONLY when the panel has `quorum > 1`, fail-closed on anything else. Absent ⇒ undefined so
 * the approver-block default (0.5) applies.
 */
function parseApproverDiversityTemp(flags: RawFlags): number | undefined {
  const v = str(flags, 'approver-diversity-temp');
  if (v === undefined) return undefined;
  const parsed = z.coerce.number().min(0).max(2).safeParse(v);
  if (!parsed.success) {
    throw new UsageError(`--approver-diversity-temp: expected a number in [0,2], got '${v}'`);
  }
  return parsed.data;
}

/**
 * Validate `--approver-lenses l1,l2,…` at the seam (issue #84 OQ4): a comma-separated LIST of
 * operator-supplied review lenses, each trimmed + non-empty, fail-closed on an empty entry / empty
 * list (invariant #6). Mirrors `--approver-models` exactly — splitting here just normalizes the wire
 * form; the Zod array seam (`.nonempty()`, `.min(1)` per entry) is the real fail-closed gate. Absent
 * ⇒ undefined so the approver keeps the default lens taxonomy (byte-for-byte unchanged).
 */
function parseApproverLenses(flags: RawFlags): [string, ...string[]] | undefined {
  const v = str(flags, 'approver-lenses');
  if (v === undefined) return undefined;
  const entries = v.split(',').map((l) => l.trim());
  const parsed = z.array(z.string().min(1)).nonempty().safeParse(entries);
  if (!parsed.success) {
    throw new UsageError(
      `--approver-lenses: expected a comma-separated list of non-empty lenses, got '${v}'`,
    );
  }
  return parsed.data;
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
  if (value === undefined) return 'claude';
  if (
    value === 'claude' ||
    value === 'codex' ||
    value === 'droid' ||
    value === 'pi' ||
    value === 'fake' ||
    value === 'goaly-code'
  ) {
    return value;
  }
  // The `claude-code` value was renamed to `claude` (one name per CLI across the harness and the
  // LLM-provider roles); fail closed with the migration hint rather than silently accept the old one.
  if (value === 'claude-code') {
    throw new UsageError(`unknown harness: claude-code (renamed — did you mean 'claude'?)`);
  }
  throw new UsageError(`unknown harness: ${value} (expected claude | codex | droid | pi | goaly-code | fake)`);
}

function parseLlmProvider(value: string | undefined): LlmProviderChoice {
  if (value === undefined) return 'claude';
  if (value === 'claude' || value === 'codex' || value === 'droid' || value === 'pi' || value === 'openai') {
    return value;
  }
  throw new UsageError(`unknown llm provider: ${value} (expected claude | codex | droid | pi | openai)`);
}

/** Collect the model flags and validate them at the Zod seam (non-empty, fails closed). */
function parseModels(flags: RawFlags): ModelSelection {
  const raw: Partial<Record<keyof ModelSelectionInput, string | string[]>> = {};
  const add = (key: keyof ModelSelectionInput, flag: string): void => {
    const v = str(flags, flag);
    if (v !== undefined) raw[key] = v;
  };
  add('model', 'model');
  add('llmModel', 'llm-model');
  add('judgeModel', 'judge-model');
  add('approverModel', 'approver-model');
  // Per-reviewer Sign-off models (follow-up to issue #84): a comma-separated LIST split into trimmed,
  // non-empty entries. The Zod array seam (.nonempty(), .min(1) per entry) is the real fail-closed
  // gate — splitting here just normalizes the wire form; an all-empty `--approver-models ,,` becomes
  // an empty array that the schema rejects.
  const approverModelsRaw = str(flags, 'approver-models');
  if (approverModelsRaw !== undefined) {
    raw.approverModels = approverModelsRaw.split(',').map((m) => m.trim());
  }
  add('compilerModel', 'compiler-model');
  add('plannerModel', 'planner-model');
  add('explainModel', 'explain-model');
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
  if (sub === 'resume-cmd') {
    const runId = subRest[0];
    if (runId === undefined || runId.startsWith('--')) {
      throw new UsageError('runs resume-cmd requires a <runId> (e.g. goaly runs resume-cmd run-1234)');
    }
    const flags = parseFlags(subRest.slice(1)).flags;
    return {
      runs: { kind: 'resume-cmd', runId, harness: str(flags, 'harness') },
      workspace: str(flags, 'workspace') ?? process.cwd(),
    };
  }
  if (sub === 'watch') {
    const runId = subRest[0];
    if (runId === undefined || runId.startsWith('--')) {
      throw new UsageError('runs watch requires a <runId> (e.g. goaly runs watch run-1234)');
    }
    return { runs: { kind: 'watch', runId }, workspace: runsWorkspace(subRest.slice(1)) };
  }
  throw new UsageError(
    `unknown runs subcommand: ${sub ?? '(none)'} (expected list | show | resume-cmd | watch)`,
  );
}

function runsWorkspace(tokens: string[]): string {
  return str(parseFlags(tokens).flags, 'workspace') ?? process.cwd();
}

/**
 * Validate the `--worktree [<name>]` run flag at the seam: a bare flag (`true`) means auto-name;
 * a string must be a valid {@link WorktreeName} — fail-closed on anything else (invariant #6).
 */
function parseWorktreeRun(flags: RawFlags): string | true | undefined {
  const v = flags['worktree'];
  if (v === undefined) return undefined;
  if (v === true) return true;
  const parsed = WorktreeName.safeParse(v);
  if (!parsed.success) {
    throw new UsageError(`--worktree: ${parsed.error.issues[0]?.message ?? 'invalid worktree name'}`);
  }
  return parsed.data;
}

/**
 * Parse the `goaly worktree` subcommand (create / list / remove). `<name>` is a positional,
 * validated at this seam with the same fail-closed {@link WorktreeName} schema the manager uses.
 */
function parseWorktreeCommand(rest: string[]): { worktree: WorktreeCommand; workspace: string } {
  const [sub, ...subRest] = rest;
  if (sub === 'list') {
    return { worktree: { kind: 'list' }, workspace: runsWorkspace(subRest) };
  }
  if (sub === 'create') {
    const name = worktreeNamePositional(subRest, 'create');
    const flags = parseFlags(subRest.slice(1)).flags;
    return {
      worktree: { kind: 'create', name, base: str(flags, 'base') },
      workspace: str(flags, 'workspace') ?? process.cwd(),
    };
  }
  if (sub === 'remove') {
    const name = worktreeNamePositional(subRest, 'remove');
    const flags = parseFlags(subRest.slice(1)).flags;
    return {
      worktree: {
        kind: 'remove',
        name,
        force: flags['force'] !== undefined,
        deleteBranch: flags['delete-branch'] !== undefined,
      },
      workspace: str(flags, 'workspace') ?? process.cwd(),
    };
  }
  throw new UsageError(
    `unknown worktree subcommand: ${sub ?? '(none)'} (expected create | list | remove)`,
  );
}

function worktreeNamePositional(subRest: string[], sub: string): string {
  const raw = subRest[0];
  if (raw === undefined || raw.startsWith('-')) {
    throw new UsageError(`worktree ${sub} requires a <name> (e.g. goaly worktree ${sub} feature-x)`);
  }
  const parsed = WorktreeName.safeParse(raw);
  if (!parsed.success) {
    throw new UsageError(
      `worktree ${sub} '${raw}': ${parsed.error.issues[0]?.message ?? 'invalid worktree name'}`,
    );
  }
  return parsed.data;
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

/** Parse `goaly ui [--port N] [--workspace <dir>]`, each validated fail-closed at the seam. */
function parseUiCommand(rest: string[]): { ui: UiCommand; workspace: string } {
  const flags = parseFlags(rest).flags;
  const rawPort = str(flags, 'port');
  let port: number | undefined;
  if (rawPort !== undefined) {
    const parsed = z.coerce.number().int().min(1).max(65535).safeParse(rawPort);
    if (!parsed.success) {
      throw new UsageError(`--port: expected an integer in 1..65535, got '${rawPort}'`);
    }
    port = parsed.data;
  }
  return {
    ui: { port },
    workspace: str(flags, 'workspace') ?? process.cwd(),
  };
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
    worktreeRun: undefined,
    // a placeholder config; never used for the help / runs commands.
    config: cliInputToRunConfig(CliInput.parse({ goal: 'help', verifyCmd: 'true' })),
    harness: 'claude',
    models: ModelSelection.parse({}),
    llmProvider: 'claude',
    workspace,
    baseline: undefined,
    verifyDir: undefined,
    planFile: undefined,
    resumeRunId: undefined,
    fromRunId: undefined,
    inheritSession: false,
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
    baseUrl: undefined,
    llmApiKeyEnv: 'OPENAI_API_KEY',
    resumeExtend: undefined,
  };
}
