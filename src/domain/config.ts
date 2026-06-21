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
  /** Frozen after compile; seeds the LLM-judge portion of the ladder when present. */
  rubric: z.string().optional(),
  /** Gates contract approval (Gate A) ONLY. Never skips the freeze. */
  autonomous: z.boolean().default(false),
  maxIterations: z.number().int().positive().default(10),
  budget: BudgetConfig.default({}),
  stuckPolicy: StuckPolicy.default({}),
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
  intent: z.string().optional(),
  rubric: z.string().optional(),
  autonomous: z.coerce.boolean().optional(),
  maxIterations: z.coerce.number().int().positive().optional(),
  budgetTokens: z.coerce.number().int().positive().optional(),
  budgetWallClockMs: z.coerce.number().int().positive().optional(),
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

  return RunConfig.parse({
    goal: input.goal,
    verifier,
    ...(input.rubric !== undefined ? { rubric: input.rubric } : {}),
    ...(input.autonomous !== undefined ? { autonomous: input.autonomous } : {}),
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
    budget,
  } satisfies RunConfigInput);
}
