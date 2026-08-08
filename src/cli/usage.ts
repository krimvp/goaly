/**
 * The complete `goaly help` text — every flag and subcommand, grouped by workflow. Kept in its
 * own module (Phase 3.1 of the improvement plan) so the parser coordinator (`args.ts`) stays
 * readable; the config-file drift test and the docs-sync check both treat this string as the
 * user-facing flag contract, so a flag that isn't documented here effectively doesn't exist.
 */
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
               [--rubric "<rubric>"] [--autonomous] [--mode review|hands-off|aggressive]
               [--preset <name>|none] [--max-iterations N]
               [--candidates N] [--resume-best-of-incomplete rerun|collapse]
               [--phased [--max-phases N] [--max-plan-revisions N] [--max-plan-retries N]
                         [--plan-file <p>] [--planner-model <m>] [--parallel-phases]]
               [--max-seal-revisions N] [--max-compile-retries N] [--verify-dir <dir>]
               [--budget-tokens N] [--budget-wall-ms N] [--diff-ignore "<p1,p2,…>"]
               [--stuck-no-diff true|false] [--stuck-repeat-threshold N]
               [--stuck-oscillation true|false] [--stuck-crash-threshold N]
               [--stuck-unevaluable-threshold N] [--auto-remediate-stuck]
               [--harness claude|codex|droid|pi|goaly-code] [--harness-autonomy low|medium|high]
               [--max-agent-turns N] [--model <m>]
               [--llm-model <m>] [--approver-quorum N] [--approver-diversity-temp T]
               [--approver-models m1,m2,…] [--approver-lenses l1,l2,…]
               [--adversarial [--adversarial-plan-critics N] [--adversarial-contract-critics N]
                              [--adversarial-refuters N] [--critic-model <m>]]
               [--llm-provider claude|codex|droid|pi|openai] [--harness-timeout-ms N]
               [--base-url <url>] [--llm-api-key-env <NAME>]
               [--llm-timeout-ms N] [--verify-timeout-ms N] [--config <path>]
               [--sandbox[=none|auto|bwrap|firejail|container]]
               [--sandbox-net none|allow|allow:<host,…>]
               [--sandbox-image <ref>] [--sandbox-runtime docker|podman]
               [--cost-table <path>] [--baseline <ref>] [--delta-verify] [--workspace <dir>]
               [--workspace-mode git|file|auto]
               [--worktree [<name>]] [--dry-run]
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

  goaly doctor [--base-url <url>] [--workspace <dir>]
  goaly init [--harness <name>] [--autonomous] [--model <m>] [--verify-cmd "<cmd>"] [--yes] [--force]
             [--workspace <dir>]
  goaly config validate <path>
  goaly completion bash|zsh|fish

  goaly help

Goal / intent / rubric input (choose ONE source per field):
  --goal "<text>"   inline value
  --goal-file <p>   read the value from a file
  --goal -          read the value from stdin (a lone "-")
  --intent/--intent-file and --rubric/--rubric-file work the same way.
  Giving a field more than one source — or piping stdin to more than one field — is an error.

Verification (--verify-cmd and --generate are mutually exclusive — passing both on the command line
is a usage error; --generate still overrides a verify-cmd inherited from a config file, loudly):
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
                    unaffected (it always hashes the working tree). Recorded in the run-log header
                    (like the raised-autonomy auto-pin) and re-adopted on --resume — a re-passed
                    --baseline wins over the recorded one. Precedence: CLI flag > config.
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
  --auto-remediate-stuck <bool>   opt-in BOUNDED self-recovery (default false): instead of aborting,
                                  remediate each remediable stuck condition ONCE per run (max 3
                                  total) — a no-diff turn gets a canned try-a-different-approach
                                  hint and its burned iteration back; a repeat-failure or
                                  harness-crash streak gets one extra attempt. Never remediates
                                  CONTRACT_UNEVALUABLE, budget, or oscillation. Every remediation is
                                  visible in the next agent prompt and logged loudly.

  On --resume of a run that ABORTED on a counted streak (harness-crash, contract-unevaluable, or
  repeat-failure), the banked streak is RELIEVED: the matching threshold is raised by the length of
  the trailing streak the log replays, so the resumed run gets a real turn instead of re-aborting on
  history. Resuming is the operator's signal that something was changed. The relief is logged and
  recorded as a normal RUN_EXTENDED marker; an explicit --stuck-* flag always wins over it. no-diff
  is a toggle, not a counter, so it is not relieved — pass --stuck-no-diff false for that resume.

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
  --parallel-phases   EXPERIMENTAL, opt-in — cooperative parallel WAVES: consecutive plan phases
                      sharing a "group" value (plan-file: {"goal": …, "group": 1}) execute
                      CONCURRENTLY, each as its own frozen, two-key CHILD goaly run in an isolated
                      git worktree on the SHARED --budget-tokens meter. The children are then merged
                      in phase order (3-way git merge-tree — plumbing only, no commits) and each
                      merged phase's frozen DETERMINISTIC rungs are RE-VERIFIED on the combined tree
                      — a merge is never trusted. Fail-closed everywhere: a merge conflict, a red
                      re-verify, or a child that can't reach DONE simply DOWNGRADES that phase to
                      the classic sequential run on the merged tree (the bar never moves, only the
                      starting tree); the cumulative ACCEPTANCE contract still gates the whole run.
                      Requires --phased and --autonomous (children seal concurrently). Without this
                      flag, grouped plans run strictly sequentially. Resume note: a crash mid-wave
                      re-runs the WHOLE wave on --resume (children live in ephemeral worktrees).

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
  Natural-language delegation: you can also just SAY it — a delegation directive in the goal
                      ("fix the flaky test, work with 4 subagents", "… using 3 parallel attempts",
                      "use subagents" ⇒ 3) maps onto --candidates and the directive clause is
                      STRIPPED from the goal (it must never enter the frozen contract), loudly
                      logged as phrase → N. Detection is a small DETERMINISTIC grammar, never an
                      LLM parse, and deliberately narrow: only "subagents"/"parallel attempts|
                      candidates|tries" introduced by a delegation verb trigger it — goals about
                      app-domain parallelism ("a queue with 4 parallel workers") never match. The
                      explicit --candidates/--best-of always wins. Mid-run, the same grammar reads
                      your resume note: goaly --resume <id> --note "try 4 parallel attempts" raises
                      the fan-out as a RUN_EXTENDED candidates overlay (ADR 0012) and keeps any
                      remaining note text as worker guidance.

Authoring resilience (issue #51):
  --max-compile-retries N    on a COMPILE_FAILED, re-author the verification with the error as
                             feedback up to N times before failing the run (default 2; 0 disables).
                             A correctable authoring mistake (bad path, transient parse miss) no
                             longer discards a valid plan. Exhausting the budget is still a typed
                             FAILED — never a skipped check.
  --max-plan-retries N       the same, one step earlier: on a PLAN_FAILED under --phased, re-ask the
                             planner with the error as feedback up to N times (default 2; 0
                             disables). Without it a single non-JSON reply ends the run at iteration
                             0, before any work — and the only other re-author path (the plan-Seal
                             revise) can never fire, because the run has already ended. A timeout is
                             instead reported with a hint to raise --llm-timeout-ms: re-asking a
                             call that timed out only times out again.

Adversarial review (opt-in; a run without --adversarial is byte-for-byte unchanged):
  --adversarial         red-team the loop at three points: an adversarial critic panel on the phased
                        PLAN before its Seal, a red-team panel on the compiled CONTRACT before the
                        Seal (each critical finding triggers a bounded re-author round; the Seal
                        gates still stand), and a REFUTER rung appended AFTER the frozen ladder —
                        it runs only when every frozen rung is green, votes refute-first, and can
                        only FAIL the iteration (never part of the contractHash, like the
                        generated-files guard). Also widens Sign-off to a 3-reviewer panel unless
                        --approver-quorum is set explicitly. Pre-Seal critics are advisory (a broken
                        critic ⇒ pass-through); the refuter rung is fail-closed (a broken refuter
                        counts as refuted; zero parseable refuters ⇒ unevaluable, never a green).
                        COST: critics/refuters are metered LLM calls counted against --budget-tokens;
                        refuters run only on candidate greens.
  --adversarial-plan-critics N      plan-critic panel size (default 2; 0 skips the plan critique)
  --adversarial-contract-critics N  contract red-team panel size (default 2; 0 skips it)
  --adversarial-refuters N          refuter votes on a green ladder (default 3; 0 skips the rung)
  --critic-model <m>    model for all adversarial critics/refuters (cascades like the other
                        LLM-step models: --critic-model → --llm-model → --model)

Harness selection:
  --harness <name>      the write-role coding agent: claude (default) | codex | droid | pi |
                        goaly-code.
  --harness-autonomy <level>  low | medium | high — how much the harness CLI is allowed to do, for
                        CLIs that gate privileged actions behind a tier (today: droid's --auto).
                        Default: the CLI's own least-privilege level (droid: low = edit files, but
                        NO git / installs / builds). Raise it for a FROM-SCRATCH build: at low the
                        agent cannot run 'npm install' or a build, so a --generate contract that
                        requires a populated tree is unreachable by construction. Above low the
                        agent can also 'git commit', so goaly AUTO-PINS the reviewed diff to the
                        run-start commit's SHA (recorded in the run log; --resume re-adopts it) —
                        an explicit --baseline <ref> overrides the pin. Only a tree with no
                        resolvable HEAD can't be pinned (goaly warns loudly then). Harnesses
                        without an autonomy tier ignore this flag.

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
  --llm-provider <p>    which provider runs the LLM steps: claude | codex | droid | pi | openai.
                        'openai' calls an OpenAI-compatible chat endpoint directly (no coding CLI
                        installed) — pair it with --base-url and a resolved --llm-model/--model.
                        Default: FOLLOWS --harness (claude→claude, codex→codex, droid→droid,
                        pi→pi, goaly-code→openai, fake→claude), so the compiler that authors a
                        --generate bar runs on the harness you picked — pass the flag to split them.
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
                              (--generate, the claude harness, the LLM provider following the
                              harness) already apply with no flag, so -d's only effect is
                              auto-accepting the contract.
  --mode review|hands-off|aggressive
                              an autonomy PROFILE that expands at parse time into the explicit
                              flags below (nothing invisible reaches the loop; every expansion is
                              logged). Explicit flags always override a profile default, loudly.
                                review:     human Seal, --harness-autonomy low, no adversarial, no
                                            candidates — and it DROPS a config-file 'autonomous'
                                            (review means a human at the gates).
                                hands-off:  --autonomous --harness-autonomy medium --delta-verify
                                            --candidates 1; warns if no independent
                                            --approver-model(s) is set.
                                aggressive: --autonomous --harness-autonomy high --adversarial
                                            --candidates 3.
                              Also settable as "mode" in .goalyrc; a --mode you type overrides it.
  --preset <name>|none        apply a NAMED preset — a flag bundle defined under "presets" in a
                              config file (see the Config file section below) — so one word selects
                              a whole way of running. One built-in ships so this works with no
                              config at all: 'default' ({ "mode": "hands-off" }), deliberately
                              language- and toolchain-neutral (no verify command, no harness or
                              model choice — verification falls back to the --generate default,
                              which fits any project); redefine "default" in a config file to make
                              it yours. Expands at parse time exactly like --mode (nothing
                              invisible reaches the loop; every expansion is logged), and may
                              itself set "mode". Layering: config base keys < preset < --mode <
                              explicit CLI flags. Also settable as a top-level "preset" in .goalyrc
                              to make it the default for every run — announced on each run, and
                              --preset none disables it for one invocation. Unknown names fail
                              closed listing what is defined (goaly config presets shows the same).

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
  Named presets: a "presets" block maps a name to the same flag keys; select one with
  --preset <name>, or persist "preset": "<name>" to apply it by default. Example:
    { "presets": { "quick": { "mode": "review", "max-iterations": 3 },
                   "ship":  { "mode": "hands-off", "budget-tokens": 500000 } },
      "preset": "quick" }
  A built-in 'default' preset ({ "mode": "hands-off" }) always exists; a config layer that
  redefines a preset name (built-in or not) replaces it wholesale (no body merging).

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
                      (crash, Ctrl-C, kill — nothing completed is repeated). The resumed run
                      CONTINUES ITS OWN harness (recorded in the run log) — session ids are
                      harness-specific, so it is never silently switched to the default; pass
                      --harness explicitly to override. Pass any of the flags below WITH --resume
                      to extend/steer the resumed run; each is recorded in the
                      log (a RUN_EXTENDED marker) so the extension is auditable and later resumes
                      keep it. Only these OPERATIONAL knobs are extendable — never the goal, the
                      verifier, or the rubric (the contract stays frozen; both keys still gate DONE):
                        --max-iterations N      also REVIVES a run that FAILED at its iteration cap
                        --budget-tokens N       also revives a budget-ABORTED run (spend re-judged
                        --budget-wall-ms N        against the new cap; prior spend still counts)
                        --stuck-* flags         raise/toggle a tripped stuck detector to continue
                        --candidates N          raise/lower the best-of-N fan-out for the remaining
                                                iterations (also via a --note directive, see above)
                      Live in another terminal: goaly runs watch <runId>.
  --note "<text>"     (with --resume) operator guidance appended to the NEXT agent prompt — steer
                      the worker without touching the bar. Combine with Ctrl-C for mid-run steering:
                      interrupt, then 'goaly --resume <id> --note "try the other approach"'. A
                      delegation directive in the note ("try 4 parallel attempts") is lifted out
                      into a --candidates extension (see natural-language delegation above).

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
  --workspace-mode git|file|auto
                            how goaly tracks the working tree. git (default when inside a git
                            repo) uses git plumbing. file uses a content-addressed file-system
                            manifest and stores baseline snapshots under .goaly/baselines/, so
                            goaly can run in a plain directory without git init. auto picks
                            git when the workspace is inside a git work tree and file
                            otherwise.

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
                            stay resumable, watched runs are unaffected.

Onboarding (first-time setup):
  goaly doctor              READ-ONLY environment report: Node version, git + workspace mode,
                            which harness CLIs are on PATH, config-file presence/validity, and
                            (with --base-url <url>) whether an OpenAI-compatible endpoint answers.
                            Exit 0 = goaly can run here; 1 = something needs fixing first.
  goaly init                write a starter .goalyrc (default harness, autonomy, model,
                            verify command). Interactive on a TTY; headless with flags
                            (--harness/--autonomous/--model/--verify-cmd) or --yes. Runs doctor
                            first, validates against the same schema every run parses, and never
                            overwrites an existing .goalyrc without --force.
  goaly config validate <path>
                            parse a config file through the exact fail-closed path every run uses
                            and report the verdict (exit 0 valid / 1 invalid). For editor
                            auto-completion, register the shipped goalyrc.schema.json (see the
                            reference's Config file section).
  goaly config presets [--names] [--workspace <dir>]
                            list the named presets — built-in plus every config layer's (name,
                            defining source, keys) — exactly as a run in <dir> would resolve
                            them. --names prints bare names only (used by shell completion for
                            --preset).
  goaly completion bash|zsh|fish
                            print a tab-completion script for every subcommand and documented flag.
                            Install: source <(goaly completion bash)   (zsh alike;
                            fish: goaly completion fish | source)`;
