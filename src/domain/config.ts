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
  /** Frozen after compile; seeds the LLM-judge portion of the ladder when present. */
  rubric: z.string().optional(),
  /** Gates contract approval (Gate A) ONLY. Never skips the freeze. */
  autonomous: z.boolean().default(false),
  /**
   * Max free-text "revise" rounds a human may take at Gate A before the run aborts. Bounds
   * the pre-loop renegotiation (each round re-authors and re-freezes the contract). 0 disables
   * revision entirely (Gate A stays binary). Ignored in `--autonomous` (auto-approve, no pause).
   */
  maxGateARevisions: z.number().int().nonnegative().default(10),
  /**
   * Max bounded compile-retry-with-feedback rounds (issue #51). On a `COMPILE_FAILED` the contract is
   * re-authored with the error text as guidance, up to this many extra attempts, before the phase
   * fails. Mirrors the Gate A revise loop: the reducer stays pure (a counter + a feedback-carrying
   * command) and exhausting the budget is still a typed `FAILED`, never a skipped check. 0 disables
   * retry (a single bad compile is terminal, the previous behavior).
   */
  maxCompileRetries: z.number().int().nonnegative().default(2),
  maxIterations: z.number().int().positive().default(10),
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
  autonomous: z.coerce.boolean().optional(),
  maxGateARevisions: z.coerce.number().int().nonnegative().optional(),
  maxCompileRetries: z.coerce.number().int().nonnegative().optional(),
  maxIterations: z.coerce.number().int().positive().optional(),
  budgetTokens: z.coerce.number().int().positive().optional(),
  budgetWallClockMs: z.coerce.number().int().positive().optional(),
  /** Comma-separated extra paths to keep out of diffHash/diff. */
  diffIgnore: z.string().optional(),
  /** Stuck-policy tuning (issue #54); booleans are pre-parsed by the CLI, the threshold coerced. */
  stuckNoDiff: z.boolean().optional(),
  stuckRepeatThreshold: z.coerce.number().int().min(2).optional(),
  stuckOscillation: z.boolean().optional(),
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

  return RunConfig.parse({
    goal: input.goal,
    verifier,
    ...(input.smoke !== undefined ? { smoke: input.smoke } : {}),
    ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
    ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
    ...(input.maxGateARevisions !== undefined
      ? { maxGateARevisions: input.maxGateARevisions }
      : {}),
    ...(input.maxCompileRetries !== undefined
      ? { maxCompileRetries: input.maxCompileRetries }
      : {}),
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
    budget,
    ...(diffIgnore.length > 0 ? { diffIgnore } : {}),
    ...(Object.keys(stuckPolicy).length > 0 ? { stuckPolicy } : {}),
  } satisfies RunConfigInput);
}
