import { z } from 'zod';
import { SessionId } from './ids';

/**
 * How the user wants the goal verified (the input to the compile phase):
 *  - `existing`: point at a command/test that already exists.
 *  - `generate`: have the agent author the verification, optionally guided by `intent`.
 */
export const VerifierIntent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('existing'),
    /** A shell command / test invocation that exits 0 on success. */
    ref: z.string().min(1),
  }),
  z.object({
    kind: z.literal('generate'),
    /** Free-form guidance for the authoring agent (e.g. "add a vitest for the parser"). */
    intent: z.string().optional(),
  }),
]);
export type VerifierIntent = z.infer<typeof VerifierIntent>;

/** Token / wall-clock caps, enforced independently of iteration count. */
export const BudgetConfig = z.object({
  tokens: z.number().int().positive().optional(),
  wallClockMs: z.number().int().positive().optional(),
});
export type BudgetConfig = z.infer<typeof BudgetConfig>;

/** Thresholds for the stuck detectors (ARCHITECTURE "Stuck detection"). */
export const StuckPolicy = z.object({
  /** Abort if a whole iteration leaves the working tree unchanged. */
  noDiff: z.boolean().default(true),
  /** Abort after this many identical normalized verifier failures in a row. */
  repeatFailureThreshold: z.number().int().min(2).default(3),
  /** Abort if the diff hash flip-flops between two states. */
  oscillation: z.boolean().default(true),
  /**
   * Abort after this many consecutive harness crashes (the agent CLI exited abnormally and never
   * completed a turn). A crash is an environment/harness failure, not a code problem, so retrying it
   * is near-useless and disguises the real cause behind a downstream verifier red. A single crash may
   * be transient (one retry); this many in a row is a typed `STUCK_HARNESS_CRASH`.
   */
  harnessCrashThreshold: z.number().int().min(2).default(2),
});
export type StuckPolicy = z.infer<typeof StuckPolicy>;
export type StuckPolicyInput = z.input<typeof StuckPolicy>;

/** The full, validated configuration for one orchestration run. */
export const RunConfig = z.object({
  goal: z.string().min(1),
  verifier: VerifierIntent,
  /**
   * Optional artifact-running smoke command (issue #53): an extra deterministic rung that RUNS the
   * built artifact (e.g. `node smoke.mjs`, `./smoke.sh`, a headless-browser script). It is just a
   * second deterministic rung — harness-agnostic and runtime-agnostic — placed after the main verify
   * command and before any judge, frozen into the contract and never weakened by the loop. Authored
   * from `--smoke`, not the LLM.
   */
  smoke: z.string().min(1).optional(),
  /**
   * One-time workspace setup/bootstrap command (Fix #1). When set it OVERRIDES whatever the
   * `--generate` compiler would author for setup; with `--verify-cmd` it is the only way to add one.
   * Runs once after SEAL, before the first agent turn; a non-zero exit is a typed `SETUP_FAILED`.
   * The resolved value is frozen into the contract's `setup`.
   */
  setupCmd: z.string().min(1).optional(),
  /**
   * Disable the setup phase entirely (Fix #1 escape hatch): drop any compiler-authored or
   * `--setup-cmd` bootstrap so the worker starts on the tree as-is. Default false.
   */
  noSetup: z.boolean().default(false),
  /**
   * What to do when a tool the verification requires (`contract.requiredTools`) is missing before the
   * loop. `true` (default) DELEGATES the install to the agent: goaly skips its own pre-loop setup (it
   * would only fail on the absent toolchain) and threads the missing tools — plus the setup command —
   * into the first prompt as a bootstrap instruction, so the experience stays seamless. `false` opts
   * out: a missing tool is a typed, fail-closed `TOOLS_MISSING` abort with guidance, before any token
   * is spent (for environments that must not be mutated by the agent).
   */
  installMissingTools: z.boolean().default(true),
  /** Frozen after compile; seeds the LLM-judge portion of the ladder when present. */
  rubric: z.string().optional(),
  /** Gates contract approval (Seal) ONLY. Never skips the freeze. */
  autonomous: z.boolean().default(false),
  /**
   * Max free-text "revise" rounds a human may take at Seal before the run aborts. Bounds
   * the pre-loop renegotiation (each round re-authors and re-freezes the contract). 0 disables
   * revision entirely (Seal stays binary). Ignored in `--autonomous` (auto-approve, no pause).
   */
  maxSealRevisions: z.number().int().nonnegative().default(10),
  /**
   * Max bounded compile-retry-with-feedback rounds (issue #51). On a `COMPILE_FAILED` the contract is
   * re-authored with the error text as guidance, up to this many extra attempts, before the phase
   * fails. Mirrors the Seal revise loop: the reducer stays pure (a counter + a feedback-carrying
   * command) and exhausting the budget is still a typed `FAILED`, never a skipped check. 0 disables
   * retry (a single bad compile is terminal, the previous behavior).
   */
  maxCompileRetries: z.number().int().nonnegative().default(2),
  maxIterations: z.number().int().positive().default(10),
  /**
   * Best-of-N parallel worker (issue #85). When > 1, each loop iteration fans out K independent worker
   * attempts in ISOLATED git worktrees off the current baseline tree, scores each against the SAME
   * frozen verifier ladder, keeps the best candidate's tree, and feeds the reducer exactly ONE winning
   * AGENT_RAN event (it never learns K existed). The whole tournament is Driver-side; the reducer only
   * picks RUN_AGENT_BEST_OF over RUN_AGENT purely from this number. Default 1 ⇒ the classic single
   * attempt, byte-for-byte unchanged (no markers, RUN_AGENT exactly as before). An operational LOOP
   * knob (it inherits into a --phased sub-goal via the LoopPolicy view), never the frozen contract.
   */
  candidates: z.number().int().positive().default(1),
  /**
   * How `--resume` handles an iteration whose best-of-N fan-out crashed mid-flight — prior
   * `CANDIDATE_RAN` markers but no `CANDIDATE_SELECTED` (issue #85 follow-up):
   *  - `'rerun'` (default): re-run ONLY the not-yet-logged candidate indices, then select over the
   *    FULL set — byte-for-byte the historical behavior, maximally faithful to the original fan-out.
   *  - `'collapse'`: select the winner from ONLY the already-logged candidates and re-run NOTHING —
   *    cheaper + deterministic, at the cost of considering a smaller set. Fail-closed: if ZERO
   *    candidates were logged it STILL runs the full set (you can't collapse to an empty set; never a
   *    green-from-nothing). Selection still uses the same graded {@link selectWinner}.
   * Loop-policy/driver WIRING — never frozen into the contract; inherited by a `--phased` sub-goal
   * via the LoopPolicy view (so a long phased run resumes consistently across phases).
   */
  resumeBestOfIncomplete: z.enum(['rerun', 'collapse']).default('rerun'),
  /**
   * Phased decomposition (issue #48). When true the run starts with a PLAN phase that turns the goal
   * into a frozen, ordered plan of sub-goals; each sub-goal runs as its own frozen, two-key contract
   * (with a checkpoint between phases), finished by a cumulative ACCEPT contract on the ORIGINAL goal.
   * Default false ⇒ the classic single-contract run, behavior byte-for-byte unchanged. The reducer
   * reads this in `initial()` to seed PLANNING instead of COMPILING.
   */
  phased: z.boolean().default(false),
  /** Max sub-goals a phased plan may contain; a planner that exceeds it is a fail-closed PLAN_FAILED. */
  maxPhases: z.number().int().positive().default(10),
  /**
   * Max free-text "revise" rounds a human may take at the plan Seal before the run aborts — the plan
   * analogue of `maxSealRevisions`. Bounds re-planning (each round re-authors and re-freezes the plan).
   * 0 disables plan revision (the plan Seal stays binary). Ignored in `--autonomous` (auto-approve).
   */
  maxPlanRevisions: z.number().int().nonnegative().default(10),
  budget: BudgetConfig.default({}),
  stuckPolicy: StuckPolicy.default({}),
  /**
   * Extra paths kept out of `diffHash`/`diff` beyond the orchestrator's own `.goaly` state dir.
   * Verifier side effects (coverage dirs, `__pycache__`, build output) otherwise land between
   * the iter-N and iter-N+1 tree snapshots and make a no-op agent look like it changed something —
   * list those artifact paths here so stuck-detection hashes only the agent's real work. Pure
   * wiring; never enters the frozen contract.
   */
  diffIgnore: z.array(z.string().min(1)).default([]),
  /**
   * Per-iteration delta diffs for the judge (issue #49). When true the Driver takes an internal
   * checkpoint after each continuation iteration (issue #47), so the next iteration's LLM judge sees
   * only the delta since that checkpoint instead of the full cumulative diff — keeping its prompt flat
   * across a long run. The DONE decision stays cumulative: the deterministic rungs always run on the
   * full working tree (ungameable key) and the terminal Sign-off approver reviews the diff against the
   * run's START baseline (the cumulative guard). Scoped to the classic single-contract loop; a no-op
   * under `--phased`, which already decomposes. Default false. Pure wiring; never enters the frozen
   * contract.
   */
  deltaVerify: z.boolean().default(false),
  /**
   * Quorum size + confidence floor for any LLM-judge rung. Frozen with the contract.
   */
  judge: z
    .object({
      quorum: z.number().int().min(1).default(3),
      confidenceFloor: z.number().min(0).max(1).default(0.66),
    })
    .default({}),
  /**
   * Sign-off (second-key) approver panel (issue #84). `quorum` reviewers behind the unchanged
   * Approver seam: with `quorum === 1` (the default) Sign-off is byte-for-byte the historical single
   * call. `quorum > 1` runs a perspective-diverse panel that greens ONLY on a strict supermajority of
   * no-veto votes (every counted reviewer must parse) and otherwise vetoes — never weaker than the
   * single veto. `diversityTemperature` is applied ONLY when `quorum > 1`. Pure WIRING — never frozen
   * into the contract (it's how the second key is produced, not part of what "done" means).
   */
  approver: z
    .object({
      quorum: z.number().int().min(1).default(1),
      diversityTemperature: z.number().min(0).max(2).default(0.5),
    })
    .default({}),
  /**
   * Follow-up session inheritance (Capability C, `--from-run … --inherit-session`). When set, the
   * follow-up's FIRST agent turn resumes this prior harness session so the agent keeps its working
   * memory; after turn 1 the real returned session id overwrites it. The NEW frozen contract still
   * SOLELY governs DONE — inheritance only seeds the agent's memory, never the bar (invariants #2/#3).
   * Pure DATA in `LoopCtx` (read by `initialCtx`) — no new transition; because it lives in the
   * RunConfig (header + replay), resume == replay stays exact. Deliberately OUTSIDE the lifetime
   * views (`GatePolicy`/`LoopPolicy`/`DriverWiring`): it is a one-time, run-level seed, NOT an
   * operational knob a phased sub-goal should inherit (the classic single-contract loop only).
   */
  seedSessionId: SessionId.optional(),
});
export type RunConfig = z.infer<typeof RunConfig>;
export type RunConfigInput = z.input<typeof RunConfig>;

/**
 * `RunConfig` viewed by LIFETIME, so each seam is handed only the fields it may read. The runtime
 * value is ONE flat `RunConfig`; these `Pick<>` views narrow the SEAM SIGNATURES — a compiler typed
 * `ContractInput` cannot read a loop knob; the driver reads `DriverWiring`; the reducer reads loop /
 * gate policy. `RunConfig` is a superset of every view, so passing the whole config where a view is
 * expected needs no conversion (covariance) — the narrowing is purely about what a seam can *read*.
 */
/** Authored ONCE into the frozen `CompiledContract`: the goal, the verification intent, the bar. */
export type ContractInput = Pick<
  RunConfig,
  'goal' | 'verifier' | 'smoke' | 'setupCmd' | 'noSetup' | 'rubric' | 'judge'
>;
/** The pre-loop, human-gated renegotiation bounds (Seal / plan revise + compile retry). */
export type GatePolicy = Pick<
  RunConfig,
  'autonomous' | 'maxSealRevisions' | 'maxCompileRetries' | 'maxPlanRevisions'
>;
/** Operational loop policy the pure reducer reads: iteration cap, stuck, budget, phasing, tools. */
export type LoopPolicy = Pick<
  RunConfig,
  | 'maxIterations'
  | 'candidates'
  | 'resumeBestOfIncomplete'
  | 'stuckPolicy'
  | 'budget'
  | 'phased'
  | 'maxPhases'
  | 'installMissingTools'
>;
/** Pure Driver wiring — NEVER the frozen contract, never the reducer's decision (the diff scope). */
export type DriverWiring = Pick<RunConfig, 'diffIgnore' | 'deltaVerify' | 'approver'>;

/** Extract the {@link GatePolicy} fields. Pure; used to re-derive a phase config from the base. */
export const pickGatePolicy = (c: GatePolicy): GatePolicy => ({
  autonomous: c.autonomous,
  maxSealRevisions: c.maxSealRevisions,
  maxCompileRetries: c.maxCompileRetries,
  maxPlanRevisions: c.maxPlanRevisions,
});
/** Extract the {@link LoopPolicy} fields. Pure. */
export const pickLoopPolicy = (c: LoopPolicy): LoopPolicy => ({
  maxIterations: c.maxIterations,
  candidates: c.candidates,
  resumeBestOfIncomplete: c.resumeBestOfIncomplete,
  stuckPolicy: c.stuckPolicy,
  budget: c.budget,
  phased: c.phased,
  maxPhases: c.maxPhases,
  installMissingTools: c.installMissingTools,
});
/** Extract the {@link DriverWiring} fields. Pure. */
export const pickDriverWiring = (c: DriverWiring): DriverWiring => ({
  diffIgnore: c.diffIgnore,
  deltaVerify: c.deltaVerify,
  approver: c.approver,
});

/**
 * Raw CLI shape, coerced into a `RunConfig`. Kept separate so the boundary between
 * "stringly-typed argv" and the validated domain object is explicit (parse, don't validate).
 */
export const CliInput = z.object({
  goal: z.string().min(1),
  verifyCmd: z.string().min(1).optional(),
  generate: z.coerce.boolean().optional(),
  /** Artifact-running smoke command (issue #53): an extra deterministic rung running the artifact. */
  smoke: z.string().min(1).optional(),
  intent: z.string().optional(),
  rubric: z.string().optional(),
  /** One-time setup/bootstrap command override (Fix #1). */
  setupCmd: z.string().min(1).optional(),
  /** Disable the setup phase entirely (Fix #1). */
  noSetup: z.coerce.boolean().optional(),
  /** Missing-tool policy: default true (agent installs); the CLI pre-parses this tri-state boolean. */
  installMissingTools: z.boolean().optional(),
  autonomous: z.coerce.boolean().optional(),
  maxSealRevisions: z.coerce.number().int().nonnegative().optional(),
  maxCompileRetries: z.coerce.number().int().nonnegative().optional(),
  maxIterations: z.coerce.number().int().positive().optional(),
  /** Best-of-N parallel worker (issue #85): a positive-int candidate count (default 1). */
  candidates: z.coerce.number().int().positive().optional(),
  /** Resume policy for an incomplete best-of-N fan-out (issue #85 follow-up); enum, fail-closed. */
  resumeBestOfIncomplete: z.enum(['rerun', 'collapse']).optional(),
  /** Phased decomposition (issue #48). */
  phased: z.coerce.boolean().optional(),
  maxPhases: z.coerce.number().int().positive().optional(),
  maxPlanRevisions: z.coerce.number().int().nonnegative().optional(),
  budgetTokens: z.coerce.number().int().positive().optional(),
  budgetWallClockMs: z.coerce.number().int().positive().optional(),
  /** Comma-separated extra paths to keep out of diffHash/diff. */
  diffIgnore: z.string().optional(),
  /** Per-iteration delta diffs for the judge (issue #49); the CLI pre-parses the boolean. */
  deltaVerify: z.boolean().optional(),
  /** Stuck-policy tuning (issue #54); booleans are pre-parsed by the CLI, the threshold coerced. */
  stuckNoDiff: z.boolean().optional(),
  stuckRepeatThreshold: z.coerce.number().int().min(2).optional(),
  stuckOscillation: z.boolean().optional(),
  stuckCrashThreshold: z.coerce.number().int().min(2).optional(),
  /** Sign-off approver panel (issue #84): a positive-int reviewer quorum (default 1). */
  approverQuorum: z.coerce.number().int().positive().optional(),
  /** Diversity temperature for a `> 1` approver panel (issue #84); ignored at quorum 1. */
  approverDiversityTemp: z.coerce.number().min(0).max(2).optional(),
});
export type CliInput = z.infer<typeof CliInput>;

/** Translate validated CLI input into a `RunConfig` (still parsed, never trusted raw). */
export function cliInputToRunConfig(input: CliInput): RunConfig {
  const verifier: VerifierIntent =
    input.verifyCmd !== undefined && !input.generate
      ? { kind: 'existing', ref: input.verifyCmd }
      : { kind: 'generate', ...(input.intent !== undefined ? { intent: input.intent } : {}) };

  const budget: z.input<typeof BudgetConfig> = {};
  if (input.budgetTokens !== undefined) budget.tokens = input.budgetTokens;
  if (input.budgetWallClockMs !== undefined) budget.wallClockMs = input.budgetWallClockMs;

  // Split the comma-separated --diff-ignore into trimmed, non-empty paths.
  const diffIgnore =
    input.diffIgnore !== undefined
      ? input.diffIgnore
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [];

  // Stuck-policy tuning (issue #54): only override the fields the user set; the rest keep their
  // schema defaults. Omitted entirely when no flag was given so the StuckPolicy default applies.
  const stuckPolicy: StuckPolicyInput = {};
  if (input.stuckNoDiff !== undefined) stuckPolicy.noDiff = input.stuckNoDiff;
  if (input.stuckRepeatThreshold !== undefined)
    stuckPolicy.repeatFailureThreshold = input.stuckRepeatThreshold;
  if (input.stuckOscillation !== undefined) stuckPolicy.oscillation = input.stuckOscillation;
  if (input.stuckCrashThreshold !== undefined)
    stuckPolicy.harnessCrashThreshold = input.stuckCrashThreshold;

  // Sign-off approver panel (issue #84): override only the fields the user set; the rest keep their
  // schema defaults (quorum 1 ⇒ byte-for-byte the single-call approver). Omitted entirely when no
  // flag was given so the approver-block default applies.
  const approver: { quorum?: number; diversityTemperature?: number } = {};
  if (input.approverQuorum !== undefined) approver.quorum = input.approverQuorum;
  if (input.approverDiversityTemp !== undefined)
    approver.diversityTemperature = input.approverDiversityTemp;

  return RunConfig.parse({
    goal: input.goal,
    verifier,
    ...(input.smoke !== undefined ? { smoke: input.smoke } : {}),
    ...(input.setupCmd !== undefined ? { setupCmd: input.setupCmd } : {}),
    ...(input.noSetup !== undefined ? { noSetup: input.noSetup } : {}),
    ...(input.installMissingTools !== undefined
      ? { installMissingTools: input.installMissingTools }
      : {}),
    ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
    ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
    ...(input.maxSealRevisions !== undefined
      ? { maxSealRevisions: input.maxSealRevisions }
      : {}),
    ...(input.maxCompileRetries !== undefined
      ? { maxCompileRetries: input.maxCompileRetries }
      : {}),
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
    ...(input.candidates !== undefined ? { candidates: input.candidates } : {}),
    ...(input.resumeBestOfIncomplete !== undefined
      ? { resumeBestOfIncomplete: input.resumeBestOfIncomplete }
      : {}),
    ...(input.phased !== undefined ? { phased: input.phased } : {}),
    ...(input.maxPhases !== undefined ? { maxPhases: input.maxPhases } : {}),
    ...(input.maxPlanRevisions !== undefined
      ? { maxPlanRevisions: input.maxPlanRevisions }
      : {}),
    budget,
    ...(diffIgnore.length > 0 ? { diffIgnore } : {}),
    ...(input.deltaVerify !== undefined ? { deltaVerify: input.deltaVerify } : {}),
    ...(Object.keys(stuckPolicy).length > 0 ? { stuckPolicy } : {}),
    ...(Object.keys(approver).length > 0 ? { approver } : {}),
  } satisfies RunConfigInput);
}
