/**
 * The Driver's dependency bag and drive options, split out of `driver.ts` so the modules the Driver
 * composes (`resume`, `best-of-driver`, `perform`, `bootstrap`) can name them without importing the
 * effect loop back. Types only — `driver.ts` re-exports both for embedders and `index.ts`.
 */
import type { RunExtension } from '../domain/events';
import type { RunFollowup, RunLog, RunProvenance } from '../runlog/runlog';
import type { DegradedMode } from '../domain/degraded';
import type { CompiledContract } from '../domain/contract';
import type { VerifierCompiler } from '../compile/compiler';
import type { SealGate } from '../compile/seal';
import type { Planner } from '../plan/planner';
import type { PlanGate } from '../plan/plan-gate';
import type { HarnessAdapter } from '../harness/adapter';
import type { Verifier } from '../verify/verifier';
import type { Approver } from '../verify/approver';
import type { WaveRunner } from './wave';
import type { LlmProvider } from '../llm/provider';
import type { Workspace, WorktreeHost } from '../workspace/workspace';
import type { Clock } from './clock';
import type { BudgetMeter } from './budget';
import type { LlmTokenMeter } from './llm-meter';
import type { Logger } from '../log/logger';
import type { PhasedStreamSink } from '../agent-cli/stream';
import type { Observer } from '../observe/observer';
import type { Telemetry } from '../telemetry/telemetry';
import type { PrepareTimeouts } from './prepare';
import type { DefectCorpus } from '../defects/corpus';

/**
 * Everything the Driver needs to perform effects. The ladder is built once from the frozen
 * contract via `makeLadder` (the composition root knows how to assemble deterministic +
 * judge rungs); the Driver treats it as an opaque Verifier.
 */
export type DriverDeps = {
  compiler: VerifierCompiler;
  seal: SealGate;
  /**
   * The planner seam (issue #48), used ONLY by a phased run's PLAN phase. Optional: a classic
   * single-contract run never emits COMPILE_PLAN, so it needs no planner. When a phased run somehow
   * has none, the PLAN command fails closed (a typed PLAN_FAILED).
   */
  planner?: Planner;
  /** The plan Seal gate (issue #48); like {@link planner}, used only by a phased run. */
  planGate?: PlanGate;
  harness: HarnessAdapter;
  makeLadder: (contract: CompiledContract) => Verifier;
  approver: Approver;
  workspace: Workspace;
  /**
   * The worktree lifecycle seam for best-of-N (issue #85). REQUIRED only when `config.candidates > 1`:
   * the Driver fans out K isolated worktrees off the baseline tree, scores each against the frozen
   * ladder, and promotes the winner's tree — all here, never in the reducer. Absent ⇒ a `--candidates 1`
   * run never touches it (the classic single attempt is byte-for-byte unchanged). When `candidates > 1`
   * but this is absent, the run refuses to start (fail-closed).
   */
  worktrees?: WorktreeHost;
  /**
   * EXPERIMENTAL — the cooperative parallel-wave seam (`--parallel-phases`). Used ONLY when a
   * grouped, phased run fans a wave out; absent ⇒ a `RUN_WAVE` fails closed by DOWNGRADING every
   * wave member to the classic sequential phase (never a crash, never a skipped phase).
   */
  wave?: WaveRunner;
  clock: Clock;
  budget: BudgetMeter;
  /**
   * Backoff sleep used by the harness crash-retry (see `HARNESS_CRASH_RETRIES` in `perform.ts`).
   * Injectable so tests never wait a real timer; defaults to a real `setTimeout`.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Cooperative interrupt probe (Ctrl-C / SIGTERM): polled between steps — and before a crash-retry
   * — so a graceful shutdown finishes the in-flight effect, persists its event write-ahead, and
   * resolves to a typed ABORTED (with a resume path) instead of dying mid-iteration. Absent ⇒ never
   * interrupted. The write-ahead log makes even a HARD kill safe (at-least-once resume); this just
   * turns the common case into a clean, resumable exit with a clear outcome.
   */
  interrupted?: () => boolean;
  /**
   * Meters LLM-step token spend (compiler / judge / approver). The composition root wraps each
   * workflow-step provider with `meterLlm` feeding this one meter; the Driver reads it per command
   * to attribute spend. Optional: when absent, LLM spend is simply reported as "unknown".
   */
  llmMeter?: LlmTokenMeter;
  runlog: RunLog;
  /**
   * Per-step kill-timeouts for the one-time prepare phase (Fix #1 setup + Fix #2 pre-flight). Pure
   * wiring — never enters the frozen contract; absent fields fall back to defaults/unbounded.
   */
  prepareTimeouts?: PrepareTimeouts;
  /**
   * The (read-only) LLM provider the pre-flight uses to classify a failing deterministic rung as a
   * broken frozen verifier (→ CONTRACT_UNSOUND) vs. an honest red (→ proceed). Metered like the other
   * LLM steps. Optional: when absent, pre-flight never aborts on a red — it proceeds and lets the
   * runtime ladder + stuck detection govern (see `prepare.ts`).
   */
  prepareLlm?: LlmProvider;
  /**
   * The cross-run DEFECT CORPUS (issue #122), written from EXACTLY ONE place: a `CONTRACT_DEFECTIVE`
   * adjudication (see `perform.ts`). Advisory and fail-open, and unable to influence THIS run — the
   * record is minted after the run has already decided to abort. Absent (`--no-defect-corpus`) ⇒ no writes.
   */
  defectCorpus?: DefectCorpus;
  /**
   * Diagnostic logger (the Driver is the orchestration choke-point: it sees every Command, Event,
   * verdict and decision). Optional and defaults to a no-op so logging never affects control flow,
   * never touches the filesystem in tests, and is pure wiring — it has no bearing on the contract,
   * the run log, or replay.
   */
  logger?: Logger;
  /**
   * Optional streaming sink (issue #23): receives the agent run's intermediate turns as
   * phase-tagged {@link PhasedStreamSink} events (phase `agent`). The composition root fans this
   * out to the `--stream` live view, the debug logger, and any embedder subscription, and wires
   * the same sink into the LLM-step providers. Pure observability — events are NEVER written to
   * the replay log, so resume stays a fold over `OrchestratorEvent` only.
   */
  onStreamEvent?: PhasedStreamSink;
  /**
   * Optional `--explain` observer (issue #8): a strictly read-only side-LLM narrator fed the SAME
   * lifecycle events the Driver already sees, fired at the contract / verifier / outcome checkpoints.
   * Advisory only — it can never influence the frozen contract, the ladder, DECIDE, or the two-key
   * DONE, and its summaries are written to a sink, never to the replay log. Internally fail-closed;
   * the Driver also guards every call so even a programming error here can never reject `drive()`.
   * Absent ⇒ no narration (the default).
   */
  observer?: Observer;
  /**
   * Optional telemetry sink: a synchronous, fire-and-forget observability seam fed one datapoint
   * per lifecycle beat (run start, each folded reducer event, terminal outcome). Like {@link logger}
   * and {@link observer} it is strictly OFF the control flow — never fed to the reducer, never
   * written to the replay log, and unable to touch the frozen contract or the two-key DONE. The
   * Driver guards every call, so a throwing sink degrades to "no telemetry" rather than crashing a
   * run (invariant #4). Absent ⇒ telemetry is disabled (a no-op sink).
   */
  telemetry?: Telemetry;
};

export type DriveOptions = {
  /** Resume from an existing run log instead of starting fresh. */
  resume?: boolean;
  /**
   * Which harness (coding-agent CLI) backs this run — recorded once in the run-log header so the
   * follow-up resume-hint (Capability A) can print the harness-correct `--resume` command. Pure
   * wiring, never the frozen contract; absent ⇒ the header omits it (old behavior unchanged).
   */
  harness?: string;
  /**
   * Typed degraded-mode label for the header (issue #125) — e.g. a fully self-judged model wiring,
   * so that DONE is labelled wherever reported. Wiring like {@link harness}: never contract/gate.
   */
  degraded?: DegradedMode;
  /**
   * Operator extension/steering for THIS resume (ADR 0012). Ignored on a fresh run and on a log
   * that doesn't exist yet. Appended as a RUN_EXTENDED marker BEFORE the resume fold, so a raised
   * cap un-terminates a FAILED-at-cap / budget-ABORTED run and a `note` reaches the next prompt.
   */
  extend?: RunExtension;
  /**
   * Successor provenance (`--recontract`, issue #117): this run re-authors the bar of a predecessor
   * whose contract was adjudicated DEFECTIVE, over the tree that run left behind. Recorded once in
   * the log header (never in the contract, never fed to the reducer) and used to widen the pre-flight
   * NEGATIVE CONTROL — a re-authored bar that already passes is exactly as suspicious as one that
   * passes on a from-scratch tree. Absent ⇒ an ordinary run, unchanged in every respect.
   */
  provenance?: RunProvenance;
  /**
   * Follow-up provenance (`--from-run`, Capability C): the predecessor run + the bounded prior-run
   * compaction that seeded authoring. Header-only wiring (never contract, never reducer) so a resume
   * that must still COMPILE can rebuild the seed instead of re-authoring with no prior context.
   */
  followup?: RunFollowup;
};
