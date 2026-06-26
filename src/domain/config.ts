import { z } from 'zod';

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
});
export type RunConfig = z.infer<typeof RunConfig>;
export type RunConfigInput = z.input<typeof RunConfig>;

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
    ...(input.phased !== undefined ? { phased: input.phased } : {}),
    ...(input.maxPhases !== undefined ? { maxPhases: input.maxPhases } : {}),
    ...(input.maxPlanRevisions !== undefined
      ? { maxPlanRevisions: input.maxPlanRevisions }
      : {}),
    budget,
    ...(diffIgnore.length > 0 ? { diffIgnore } : {}),
    ...(input.deltaVerify !== undefined ? { deltaVerify: input.deltaVerify } : {}),
    ...(Object.keys(stuckPolicy).length > 0 ? { stuckPolicy } : {}),
  } satisfies RunConfigInput);
}
