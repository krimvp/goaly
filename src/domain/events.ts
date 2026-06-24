import { z } from 'zod';
import { DiffHash, SessionId, ContractHash, RunId } from './ids';
import { CompiledContract } from './contract';
import { PhasePlan } from './plan';
import { Verdict, ApprovalVerdict, SealDecision } from './verdict';
import { RunConfig } from './config';
import { TokenUsage, TokenBreakdown, UsageReport } from './usage';

/** What a harness adapter returns. `diffHash` is computed by the Workspace, not here. */
export const HarnessRunResult = z.object({
  output: z.string(),
  sessionId: SessionId,
  status: z.enum(['completed', 'crashed', 'truncated', 'timeout']),
  tokensUsed: z.number().int().nonnegative().optional(),
  /**
   * Whether `tokensUsed` is the harness's own `reported` count or a local `estimated` fallback
   * (issue #24), counted from the streamed turns when the CLI emits no `usage`. Absent when
   * `tokensUsed` is absent (the spend is genuinely unknown — never a silent zero).
   */
  tokenSource: z.enum(['reported', 'estimated']).optional(),
  /**
   * Per-category split of `tokensUsed` (input/output/cache-read/cache-write) when the harness
   * reported one. Present only for a `reported` count (an estimate has no split); absent otherwise.
   */
  tokenBreakdown: TokenBreakdown.optional(),
});
export type HarnessRunResult = z.infer<typeof HarnessRunResult>;

/** A budget reading stamped by the Driver after an iteration (the reducer reads `.exceeded`). */
export const BudgetSnapshot = z.object({
  tokensSpent: z.number().int().nonnegative().optional(),
  /** The portion of `tokensSpent` that is a local estimate (issue #24). Omitted when none was. */
  tokensEstimated: z.number().int().nonnegative().optional(),
  /**
   * True when ≥1 token-spending call reported NO usage and could not be estimated, so
   * `tokensSpent` understates true spend — the token cap is partially blind and wall-clock is the
   * real backstop. Surfaced loudly (logged + in the report) rather than silently read as zero spend
   * (invariant #4, fail-closed). Omitted when every call's spend was accounted for.
   */
  tokensUnknown: z.boolean().optional(),
  wallClockMs: z.number().int().nonnegative().optional(),
  exceeded: z.boolean(),
});
export type BudgetSnapshot = z.infer<typeof BudgetSnapshot>;

/**
 * The classified outcome of the one-time prepare phase (Fix #1 setup + Fix #2 pre-flight), resolved
 * by the Driver before the reducer decides. `proceed` means the workspace is ready (setup ran clean —
 * or there was none — and the deterministic pre-flight either passed or failed as an HONEST red, i.e.
 * the implementation is simply missing); the loop starts. `setup-failed` and `contract-unsound` are
 * the two typed, fail-closed aborts that happen BEFORE any worker token is spent.
 */
export const PreparedOutcome = z.discriminatedUnion('status', [
  z.object({ status: z.literal('proceed') }),
  z.object({ status: z.literal('setup-failed'), detail: z.string() }),
  z.object({ status: z.literal('contract-unsound'), detail: z.string() }),
]);
export type PreparedOutcome = z.infer<typeof PreparedOutcome>;

/**
 * EVENTS — the only things fed to the pure reducer. Each is the already-resolved result
 * of a Command's effect: every stochastic/IO operation completed in the Driver before the
 * Event was built. Events are persisted (write-ahead) and re-parsed on resume, so each has
 * a Zod schema.
 */
export const OrchestratorEvent = z.discriminatedUnion('tag', [
  /**
   * The PLAN phase authored a FROZEN, ordered plan of sub-goals (issue #48). Logged loudly so the
   * decomposition is auditable; carries the plan (with its `planHash`) so resume reconstructs it.
   */
  z.object({
    tag: z.literal('PLAN_COMPILED'),
    plan: PhasePlan,
    /** LLM spend authoring the plan (absent for a `--plan-file` plan — no LLM call). */
    llm: TokenUsage.optional(),
  }),
  /** The planner errored / produced an unparseable or over-long plan — a typed, fail-closed FAILED. */
  z.object({
    tag: z.literal('PLAN_FAILED'),
    reason: z.string(),
    llm: TokenUsage.optional(),
  }),
  /** The plan Seal (Gate A on the plan): approve starts phase 0, reject aborts, revise re-plans. */
  z.object({ tag: z.literal('PLAN_SEAL_DECIDED'), decision: SealDecision }),
  /**
   * A phase completed (both keys) and the Driver took an internal checkpoint (issue #47) before
   * starting the next phase. Carries the snapshotted tree SHA so resume re-points the diff baseline
   * (like CHECKPOINTED) AND drives the reducer's advance to the next phase's contract compile.
   */
  z.object({ tag: z.literal('PHASE_ADVANCED'), tree: DiffHash }),
  z.object({
    tag: z.literal('CONTRACT_COMPILED'),
    contract: CompiledContract,
    /** LLM spend authoring this contract (absent for an existing-command contract — no LLM call). */
    llm: TokenUsage.optional(),
  }),
  z.object({
    tag: z.literal('COMPILE_FAILED'),
    reason: z.string(),
    /** LLM spend before the compile failed (tokens can be spent on a draft that then fails to parse). */
    llm: TokenUsage.optional(),
  }),
  z.object({ tag: z.literal('SEAL_DECIDED'), decision: SealDecision }),
  z.object({
    tag: z.literal('WORKSPACE_PREPARED'),
    /** The classified outcome of the one-time setup + deterministic pre-flight (Fix #1 / #2). */
    prepared: PreparedOutcome,
    /** Whether a setup command actually ran (for logs / `runs show`); false when the contract had none. */
    setupRan: z.boolean(),
  }),
  z.object({
    tag: z.literal('AGENT_RAN'),
    run: HarnessRunResult,
    /** Workspace tree hash captured immediately BEFORE this run (for no-op detection). */
    prevDiffHash: DiffHash,
    /** Workspace tree hash captured immediately AFTER this run. */
    diffHash: DiffHash,
    budget: BudgetSnapshot,
  }),
  z.object({
    tag: z.literal('VERIFIED'),
    verdict: Verdict,
    /** LLM spend by the judge rung (absent when the ladder had no LLM rung). */
    llm: TokenUsage.optional(),
  }),
  z.object({
    tag: z.literal('SIGNOFF_DECIDED'),
    approval: ApprovalVerdict,
    /** LLM spend by the approver (absent only if the call never reached the model). */
    llm: TokenUsage.optional(),
  }),
  /**
   * An internal workspace checkpoint (issue #47): the Driver snapshotted the working tree into a git
   * TREE object (no user-visible commit, no HEAD/branch move) and adopted it as the new diff baseline.
   * It is a baseline MARKER, not a reducer transition — it is NEVER fed to `step()` (replay skips it);
   * it exists only so `--resume` can reconstruct the advanced baseline by replaying the log. Carries
   * the tree SHA so the reconstruction is deterministic.
   */
  z.object({
    tag: z.literal('CHECKPOINTED'),
    /** The git tree SHA snapshotted as the new diff baseline. */
    tree: DiffHash,
  }),
]);
export type OrchestratorEvent = z.infer<typeof OrchestratorEvent>;

/** Inputs the Driver must gather (workspace diff) before running the approver. */
export type ApprovalInput = {
  goal: string;
  rubric: string;
  diff: string;
  verdicts: Verdict[];
};

/**
 * COMMANDS — data describing effects the Driver must perform. Never persisted (only the
 * resulting Events are). The reducer emits these; it never performs them, never holds an
 * adapter, never returns a Promise — which is what makes "zero LLM in control flow"
 * a structural guarantee rather than a discipline.
 */
export type Command =
  | { tag: 'COMPILE_PLAN'; config: RunConfig; feedback?: string }
  | { tag: 'REQUEST_PLAN_SEAL'; plan: PhasePlan }
  | { tag: 'CHECKPOINT_AND_ADVANCE' }
  | { tag: 'COMPILE_VERIFIER'; config: RunConfig; feedback?: string }
  | { tag: 'REQUEST_SEAL'; contract: CompiledContract }
  | { tag: 'PREPARE_WORKSPACE'; contract: CompiledContract }
  | { tag: 'RUN_AGENT'; prompt: string; sessionId: SessionId | undefined }
  | { tag: 'RUN_VERIFIER'; contract: CompiledContract }
  | { tag: 'REQUEST_SIGNOFF'; goal: string; rubric: string; verdicts: Verdict[] };

/** Terminal result of a whole run. */
export const RunOutcome = z.object({
  status: z.enum(['DONE', 'FAILED', 'ABORTED']),
  reason: z.string().optional(),
  iterations: z.number().int().nonnegative(),
  /** Null only when the run failed during compile, before any contract was frozen. */
  contractHash: ContractHash.nullable(),
  runId: RunId,
  /** Per-run token spend, folded from the event log. Absent only if the log could not be read. */
  usage: UsageReport.optional(),
});
export type RunOutcome = z.infer<typeof RunOutcome>;
