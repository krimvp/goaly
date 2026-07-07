import { z } from 'zod';
import { DiffHash, SessionId, ContractHash, RunId } from './ids';
import { CompiledContract } from './contract';
import { PhasePlan } from './plan';
import { Verdict, ApprovalVerdict, SealDecision, type SealEditPatch } from './verdict';
import { RunConfig, StuckPolicy } from './config';
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
  z.object({
    status: z.literal('proceed'),
    /**
     * Tools the verification needs that are NOT installed, which goaly is delegating to the agent to
     * install (the default `--install-missing-tools` path). Threaded into the first prompt as a
     * bootstrap instruction. Absent/empty when every required tool was already present.
     */
    installTools: z.array(z.string()).optional(),
    /**
     * Set when a COMPILER-AUTHORED setup command (not a user `--setup-cmd`) failed and was degraded to
     * best-effort `proceed` instead of a fatal `SETUP_FAILED` (Fix A): on a from-scratch `--generate`
     * build the authored `go mod download`/`npm ci` presupposes scaffolding the agent has not written
     * yet, so a non-zero exit is expected, not fatal. Carries an actionable note (the failed command +
     * how to recover) threaded into the first prompt the way {@link installTools} is, so the agent
     * scaffolds and runs setup itself. Absent when setup ran clean, was absent, or was user-supplied.
     */
    setupHint: z.string().optional(),
  }),
  z.object({ status: z.literal('setup-failed'), detail: z.string() }),
  z.object({ status: z.literal('contract-unsound'), detail: z.string() }),
  /** Required tools are missing AND `--install-missing-tools false` opted out of agent-install. */
  z.object({ status: z.literal('tools-missing'), detail: z.string() }),
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
  /** The plan Seal: approve starts phase 0, reject aborts, revise re-plans. */
  z.object({ tag: z.literal('PLAN_SEAL_DECIDED'), decision: SealDecision }),
  /**
   * A phase completed (both keys) and the Driver took an internal checkpoint (issue #47) before
   * starting the next phase. Carries the snapshotted tree SHA so resume re-points the diff baseline
   * (like CHECKPOINTED) AND drives the reducer's advance to the next phase's contract compile.
   */
  z.object({ tag: z.literal('PHASE_ADVANCED'), tree: DiffHash }),
  /**
   * EXPERIMENTAL — a cooperative parallel WAVE completed (`--parallel-phases`): consecutive grouped
   * phases ran concurrently as isolated, frozen, two-key CHILD runs; the Driver merged the DONE
   * children in phase order and RE-VERIFIED each merged phase's frozen ladder on the combined tree.
   * One outcome per wave member:
   *  - `merged`    — child DONE, merged clean, frozen ladder green on the combined tree ⇒ the phase
   *                  is complete (the reducer SKIPS it when advancing).
   *  - `unmerged`  — the child failed to land (merge conflict, red re-verify, or a non-DONE child
   *                  outcome) ⇒ FAIL-CLOSED downgrade: the phase re-runs as a classic sequential
   *                  phase on the merged-so-far tree (a fresh frozen contract on the same sub-goal —
   *                  the bar never moves, only the starting tree).
   * Carries the post-merge checkpoint tree (the baseline for whatever follows, like PHASE_ADVANCED).
   * Fed to `step()` (it drives the advance) AND read by replay for baseline reconstruction.
   */
  z.object({
    tag: z.literal('WAVE_RAN'),
    outcomes: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('merged'),
            /** The plan phase index this outcome belongs to. */
            index: z.number().int().nonnegative(),
            /** The child run's total spend (all layers), for the parent's usage fold. */
            usage: TokenUsage.optional(),
          }),
          z.object({
            kind: z.literal('unmerged'),
            index: z.number().int().nonnegative(),
            /** Why the child did not land (conflict / red re-verify / child FAILED-ABORTED / error). */
            reason: z.string(),
            usage: TokenUsage.optional(),
          }),
        ]),
      )
      .min(1),
    /** The post-merge checkpoint tree — the diff baseline for the phases that follow. */
    tree: DiffHash,
  }),
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
    /** LLM spend by the pre-flight soundness classification (absent when it did not run — see prepare.ts). */
    llm: TokenUsage.optional(),
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
  /**
   * One best-of-N candidate finished (issue #85). When `--candidates N` (N>1), the Driver fans out K
   * isolated worker attempts in linked git worktrees, scores each against the SAME frozen ladder, and
   * appends ONE of these markers per candidate AS IT COMPLETES (write-ahead). Like CHECKPOINTED it is a
   * Driver-side MARKER, NEVER fed to `step()` (replay skips it): the reducer only ever folds the
   * winner's `AGENT_RAN` and never learns K existed (invariant #1). On `--resume` these markers let the
   * tournament replay deterministically — already-logged candidate indices are read back, never re-run.
   */
  z.object({
    tag: z.literal('CANDIDATE_RAN'),
    /** The 1-based loop iteration this candidate belongs to (a candidate set per iteration). */
    iteration: z.number().int().nonnegative(),
    /** This candidate's index within the fan-out (0-based, stable; the final selection tie-break). */
    index: z.number().int().nonnegative(),
    /** The candidate's post-run tree SHA — promoted into the canonical workspace if it wins. */
    tree: DiffHash,
    /** The candidate's budget snapshot — its token cost is the second-key selection tie-break. */
    budget: BudgetSnapshot,
    /** Whether this candidate PASSED the frozen ladder (a passing candidate beats any failing one). */
    pass: z.boolean(),
    /**
     * How far this candidate got up the frozen ladder (issue #85 graded ranking): rungs passed before
     * the short-circuit. Persisted so a `--resume` re-selection (esp. `--resume-best-of-incomplete
     * collapse`) ranks the already-logged candidates by the SAME graded key, not the boolean alone.
     * Optional for backward-compatible replay of logs written before graded ranking (fall back to
     * `pass ? rungsTotal : 0`).
     */
    rungsPassed: z.number().int().min(0).optional(),
    /** The frozen ladder's total rung count (the depth denominator). Optional for old-log replay. */
    rungsTotal: z.number().int().min(0).optional(),
    /** The candidate's harness run result (status + session id), re-fed as the winner's AGENT_RAN. */
    run: HarnessRunResult,
  }),
  /**
   * The best-of-N tournament selected its winner (issue #85). Appended write-ahead BEFORE the winning
   * tree is promoted and BEFORE the winner's `AGENT_RAN`, so `--resume` knows the selection was already
   * made (and which tree to adopt) even if a crash lands between the choice and the promotion. Also a
   * Driver-side MARKER, never fed to `step()` (replay skips it).
   */
  z.object({
    tag: z.literal('CANDIDATE_SELECTED'),
    /** The 1-based loop iteration this selection belongs to. */
    iteration: z.number().int().nonnegative(),
    /** The winning candidate's index within the fan-out. */
    winner: z.number().int().nonnegative(),
    /** The winning candidate's tree SHA (promoted into the canonical workspace). */
    tree: DiffHash,
  }),
  /**
   * The operator EXTENDED or STEERED the run at a `--resume` boundary (operator control, ADR 0012).
   * Like CHECKPOINTED it is a Driver-side MARKER, NEVER fed to `step()` — replay applies it as a
   * CONFIG OVERLAY (caps / stuck thresholds) BEFORE the fold, so a raised `--max-iterations` or
   * `--budget-tokens` simply makes the fold not terminate at the old cap, and surfaces the `note`
   * into the next agent prompt (an un-consumed note is one with no AGENT_RAN after it). Only the
   * OPERATIONAL knobs are extendable — never the goal / verifier / rubric: the frozen contract stays
   * frozen (invariant #2), and both keys still gate DONE. Appended write-ahead at resume time so the
   * extension is auditable and every later replay/inspection folds with the same effective config.
   */
  z.object({
    tag: z.literal('RUN_EXTENDED'),
    /** New iteration cap (replaces the config's `maxIterations`). */
    maxIterations: z.number().int().positive().optional(),
    /** New token budget cap (replaces `budget.tokens`; past snapshots are re-judged against it). */
    budgetTokens: z.number().int().positive().optional(),
    /** New wall-clock budget cap (replaces `budget.wallClockMs`). */
    budgetWallMs: z.number().int().positive().optional(),
    /** Stuck-policy overrides (each field replaces its counterpart; absent fields keep the prior). */
    stuck: StuckPolicy.partial().optional(),
    /**
     * Best-of-N candidates override (issue #85): raise/lower the per-iteration parallel fan-out
     * mid-run — an OPERATIONAL loop knob like `maxIterations`, never the frozen contract. Capped at
     * 16 like the config seam (each candidate is a full concurrent worker + worktree). Typically
     * set from an explicit `--candidates` at resume or a natural-language `--note` directive
     * ("try 4 parallel attempts" — see `src/cli/delegation.ts`).
     */
    candidates: z.number().int().positive().max(16).optional(),
    /** Operator guidance appended to the NEXT agent prompt (worker steering, never the contract). */
    note: z.string().min(1).optional(),
  }),
]);
export type OrchestratorEvent = z.infer<typeof OrchestratorEvent>;

/**
 * The payload of a RUN_EXTENDED marker (ADR 0012), minus its tag — the shape the CLI collects from
 * explicit `--resume`-time flags and the Driver persists write-ahead. Operational knobs + a worker
 * note only; the frozen contract fields are unrepresentable here by construction (invariant #2).
 */
export type RunExtension = Omit<Extract<OrchestratorEvent, { tag: 'RUN_EXTENDED' }>, 'tag'>;

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
  /**
   * Manual-edit refreeze (ADR 0016): the operator answered the Seal with `edited`. The Driver
   * re-reads the contract's authored files from the workspace, re-pins their content hashes,
   * applies the operator's field `patch`, and re-freezes a NEW contract — returned as a normal
   * `CONTRACT_COMPILED` so it is write-ahead logged and re-presented at Seal. The reducer only
   * NAMES the effect (the parked contract + the patch are data it already holds); all IO/hashing
   * is Driver-side, exactly like `COMPILE_VERIFIER`. No LLM call is involved.
   */
  | { tag: 'REFREEZE_CONTRACT'; contract: CompiledContract; patch?: SealEditPatch }
  | { tag: 'REQUEST_SEAL'; contract: CompiledContract }
  | {
      tag: 'PREPARE_WORKSPACE';
      contract: CompiledContract;
      installMissingTools: boolean;
      /**
       * True when this contract's `setup` was COMPILER-AUTHORED (under `--generate`) rather than
       * user-supplied (`--setup-cmd`). Pure wiring derived in the reducer — NOT part of the frozen
       * contract (that would churn `contractHash`); it mirrors `installMissingTools` as "how to
       * prepare," not "what done means." An authored setup that fails is best-effort (degrades to
       * proceed); a user setup that fails stays fatal `SETUP_FAILED` (Fix A).
       */
      setupAuthored: boolean;
    }
  | { tag: 'RUN_AGENT'; prompt: string; sessionId: SessionId | undefined }
  /**
   * Best-of-N tournament (issue #85). Emitted by `startIteration` INSTEAD of `RUN_AGENT` when
   * `config.candidates > 1` — decided PURELY from config so the reducer stays pure and still emits
   * EXACTLY ONE command per non-terminal state (the Driver `commands.length === 1` invariant). The
   * Driver performs the WHOLE tournament (K isolated worktrees, score each against the frozen ladder,
   * promote the winner's tree) and feeds back the EXISTING `AGENT_RAN` event for the winner — so
   * `stepRunningAgent` is unchanged and the reducer never learns K existed (invariant #1).
   */
  | { tag: 'RUN_AGENT_BEST_OF'; prompt: string; sessionId: SessionId | undefined; candidates: number }
  | { tag: 'RUN_VERIFIER'; contract: CompiledContract }
  | { tag: 'REQUEST_SIGNOFF'; goal: string; rubric: string; verdicts: Verdict[] }
  /**
   * EXPERIMENTAL — run a cooperative parallel WAVE (`--parallel-phases`): the consecutive grouped
   * phases at `phases[i].index`, each as its own frozen, two-key CHILD goaly run in an isolated
   * worktree (per-phase config derived by the reducer exactly as for a sequential phase), then merge
   * the DONE children in phase order and re-verify each merged ladder on the combined tree. The
   * Driver performs the whole wave through the injected {@link WaveRunner} seam and feeds back ONE
   * `WAVE_RAN` event. Emitted INSTEAD of the first phase's `COMPILE_VERIFIER` when the plan groups
   * consecutive phases and `config.parallelPhases` is on — still exactly one command per state.
   */
  | { tag: 'RUN_WAVE'; phases: { index: number; config: RunConfig }[] };

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
  /**
   * The run's last REAL (non-sentinel) harness session id (Capability A) — the handle to continue the
   * underlying CLI session, surfaced for the end-of-run banner and embedders. Absent when no real id
   * was recovered (e.g. a compile-time failure, or the fake harness).
   */
  sessionId: SessionId.optional(),
});
export type RunOutcome = z.infer<typeof RunOutcome>;
