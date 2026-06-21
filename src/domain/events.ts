import { z } from 'zod';
import { DiffHash, SessionId, ContractHash, RunId } from './ids';
import { CompiledContract } from './contract';
import { Verdict, ApprovalVerdict, GateDecision } from './verdict';
import { RunConfig } from './config';

/** What a harness adapter returns. `diffHash` is computed by the Workspace, not here. */
export const HarnessRunResult = z.object({
  output: z.string(),
  sessionId: SessionId,
  status: z.enum(['completed', 'crashed', 'truncated', 'timeout']),
  tokensUsed: z.number().int().nonnegative().optional(),
});
export type HarnessRunResult = z.infer<typeof HarnessRunResult>;

/** A budget reading stamped by the Driver after an iteration (the reducer reads `.exceeded`). */
export const BudgetSnapshot = z.object({
  tokensSpent: z.number().int().nonnegative().optional(),
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
  z.object({ tag: z.literal('CONTRACT_COMPILED'), contract: CompiledContract }),
  z.object({ tag: z.literal('COMPILE_FAILED'), reason: z.string() }),
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
  z.object({ tag: z.literal('VERIFIED'), verdict: Verdict }),
  z.object({ tag: z.literal('GATE_B_DECIDED'), approval: ApprovalVerdict }),
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
});
export type RunOutcome = z.infer<typeof RunOutcome>;
