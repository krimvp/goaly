import { z } from 'zod';
import { DiffHash, SessionId, ContractHash, RunId } from './ids';
import { CompiledContract } from './contract';
import { Verdict, ApprovalVerdict, GateDecision } from './verdict';
import { RunConfig } from './config';
import { TokenUsage, UsageReport } from './usage';

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
 * EVENTS — the only things fed to the pure reducer. Each is the already-resolved result
 * of a Command's effect: every stochastic/IO operation completed in the Driver before the
 * Event was built. Events are persisted (write-ahead) and re-parsed on resume, so each has
 * a Zod schema.
 */
export const OrchestratorEvent = z.discriminatedUnion('tag', [
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
  z.object({ tag: z.literal('GATE_A_DECIDED'), decision: GateDecision }),
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
    tag: z.literal('GATE_B_DECIDED'),
    approval: ApprovalVerdict,
    /** LLM spend by the approver (absent only if the call never reached the model). */
    llm: TokenUsage.optional(),
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
  | { tag: 'COMPILE_VERIFIER'; config: RunConfig; feedback?: string }
  | { tag: 'REQUEST_GATE_A'; contract: CompiledContract }
  | { tag: 'RUN_AGENT'; prompt: string; sessionId: SessionId | undefined }
  | { tag: 'RUN_VERIFIER'; contract: CompiledContract }
  | { tag: 'REQUEST_GATE_B'; goal: string; rubric: string; verdicts: Verdict[] };

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
