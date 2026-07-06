import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';
import type { Command, OrchestratorEvent, RunExtension } from '../domain/events';
import type { ContractHash, DiffHash } from '../domain/ids';
import type { OrchestratorState } from '../orchestrator/state';
import { initial, step } from '../orchestrator/step';
import type { RunLogEntry } from './runlog';

/**
 * The header config with every logged RUN_EXTENDED overlay applied, in order (operator control,
 * ADR 0012). Only the OPERATIONAL knobs are overlayable — caps and stuck thresholds — never the
 * goal / verifier / rubric, so the frozen contract can't be renegotiated through an extension.
 * This is the config the fold must run with: a raised `maxIterations` makes the fold simply not
 * terminate at the old cap, which is what turns "resume a FAILED-at-cap run" into a continuation.
 * Shared by replay (below) and the CLI's resume path (which composes deps from the SAME config).
 */
export function extendedRunConfig(config: RunConfig, entries: readonly RunLogEntry[]): RunConfig {
  let cfg = config;
  for (const entry of entries) {
    if (entry.event.tag !== 'RUN_EXTENDED') continue;
    cfg = applyRunExtension(cfg, entry.event);
  }
  return cfg;
}

/** Apply ONE extension overlay to a config — shared by the fold and the CLI's resume composition. */
export function applyRunExtension(cfg: RunConfig, x: RunExtension): RunConfig {
  const s = x.stuck ?? {};
  return {
    ...cfg,
    ...(x.maxIterations !== undefined ? { maxIterations: x.maxIterations } : {}),
    ...(x.candidates !== undefined ? { candidates: x.candidates } : {}),
    budget: {
      ...cfg.budget,
      ...(x.budgetTokens !== undefined ? { tokens: x.budgetTokens } : {}),
      ...(x.budgetWallMs !== undefined ? { wallClockMs: x.budgetWallMs } : {}),
    },
    stuckPolicy: {
      ...cfg.stuckPolicy,
      ...(s.noDiff !== undefined ? { noDiff: s.noDiff } : {}),
      ...(s.repeatFailureThreshold !== undefined
        ? { repeatFailureThreshold: s.repeatFailureThreshold }
        : {}),
      ...(s.oscillation !== undefined ? { oscillation: s.oscillation } : {}),
      ...(s.harnessCrashThreshold !== undefined
        ? { harnessCrashThreshold: s.harnessCrashThreshold }
        : {}),
      ...(s.unevaluableThreshold !== undefined
        ? { unevaluableThreshold: s.unevaluableThreshold }
        : {}),
    },
  };
}

/**
 * Re-judge a persisted AGENT_RAN budget snapshot against the EXTENDED caps. The `exceeded` flag was
 * baked into the event by the meter that observed the OLD caps; when an extension raises them, the
 * fold must read the snapshot's raw numbers against the new caps or the run would re-abort at the
 * old cap forever. Only the flag is recomputed — the spent numbers are the persisted facts.
 */
function rejudgeBudget(event: OrchestratorEvent, cfg: RunConfig): OrchestratorEvent {
  if (event.tag !== 'AGENT_RAN') return event;
  const b = event.budget;
  const tokenCapHit = cfg.budget.tokens !== undefined && (b.tokensSpent ?? 0) >= cfg.budget.tokens;
  const timeCapHit =
    cfg.budget.wallClockMs !== undefined && (b.wallClockMs ?? 0) >= cfg.budget.wallClockMs;
  return { ...event, budget: { ...b, exceeded: tokenCapHit || timeCapHit } };
}

/** The reconstructed result of folding the pure reducer over a persisted event stream. */
export type ReplayResult = {
  /** The final orchestrator state the run reached (terminal or interrupted mid-loop). */
  readonly state: OrchestratorState;
  /** The commands the reducer would emit next (empty in a terminal state). */
  readonly commands: Command[];
  /** The last (frozen) contract that was compiled, or null if compile never succeeded. */
  readonly contract: CompiledContract | null;
  /** The frozen contract's hash, mirrored for convenience (null before compile). */
  readonly contractHash: ContractHash | null;
  /**
   * The tree SHA of the most recent internal checkpoint (issue #47), or null if none was taken. The
   * Driver re-points the workspace's diff baseline at this on `--resume` so the resumed run keeps the
   * same small-diff baseline it had advanced to. Updated by BOTH the standalone CHECKPOINTED marker
   * and a phased run's PHASE_ADVANCED (which also checkpoints between phases — issue #48).
   */
  readonly baseline: DiffHash | null;
  /**
   * The tree SHA of the most recent PHASE boundary (a phased run's PHASE_ADVANCED), or null before the
   * first phase completes. Distinct from {@link baseline}: under `--delta-verify` per-iteration
   * CHECKPOINTED markers advance the judge's baseline, but the terminal Sign-off approver is pinned to
   * the CURRENT PHASE's start so it always reviews that phase's whole cumulative change (issue #49).
   * The Driver re-points the approver baseline at this on `--resume`. Null ⇒ the approver falls back to
   * the run-start baseline (the classic single-contract run, or phase 0 before any advance).
   */
  readonly phaseBaseline: DiffHash | null;
  /** The frozen plan a phased run authored (issue #48), or null on a classic single-contract run. */
  readonly plan: PhasePlan | null;
  /**
   * Un-consumed operator note(s) (ADR 0012): the text of every RUN_EXTENDED `note` with NO AGENT_RAN
   * after it in the log — i.e. guidance the worker has not seen yet. The Driver appends it to the
   * next agent prompt on resume. Null when there is nothing pending. Consumption is positional and
   * deterministic: once a turn runs after the note, later replays no longer surface it.
   */
  readonly pendingNote: string | null;
};

/**
 * Replay = a pure fold of `step` over the event stream. This is the SINGLE source of truth for
 * "what state did this run reach": the Driver's `--resume` path and the read-only `runs`
 * inspection both call it, so an inspected run's status/iterations match exactly what the Driver
 * computed (invariant #7 — resume is a replay-fold). No effect is performed, only `step`.
 */
export function replay(config: RunConfig, entries: readonly RunLogEntry[]): ReplayResult {
  // Operator extensions (ADR 0012) are applied to the CONFIG *before* the fold, so a raised cap
  // means the fold never terminates at the old one. Purely derived from the log, so every replayer
  // (resume, `runs list/show`, watch) folds with the same effective config.
  const effective = extendedRunConfig(config, entries);
  const budgetExtended = entries.some(
    (e) =>
      e.event.tag === 'RUN_EXTENDED' &&
      (e.event.budgetTokens !== undefined || e.event.budgetWallMs !== undefined),
  );

  let [state, commands] = initial(effective);
  let contract: CompiledContract | null = null;
  let contractHash: ContractHash | null = null;
  let baseline: DiffHash | null = null;
  let phaseBaseline: DiffHash | null = null;
  let plan: PhasePlan | null = null;
  let pendingNotes: string[] = [];

  for (const entry of entries) {
    // A CHECKPOINTED entry is a diff-baseline marker, NOT a reducer transition: it is never fed to
    // `step()` (the reducer stays unaffected, invariant #1). We only remember the latest tree so the
    // Driver can re-point the baseline on resume.
    if (entry.event.tag === 'CHECKPOINTED') {
      baseline = entry.event.tree;
      continue;
    }
    // Best-of-N tournament markers (issue #85) are Driver-side ONLY: like CHECKPOINTED they are NEVER
    // fed to `step()` — the reducer only ever folds the winner's AGENT_RAN and never learns K existed
    // (invariant #1). They exist so the Driver's tournament can replay deterministically on `--resume`
    // (already-logged candidates read back, never re-run); the pure fold here simply skips them.
    if (entry.event.tag === 'CANDIDATE_RAN' || entry.event.tag === 'CANDIDATE_SELECTED') {
      continue;
    }
    // A RUN_EXTENDED entry is an operator-control marker (ADR 0012): its config overlay was already
    // applied above; here we only track its note, which stays pending until a turn consumes it.
    if (entry.event.tag === 'RUN_EXTENDED') {
      if (entry.event.note !== undefined) pendingNotes.push(entry.event.note);
      continue;
    }
    if (entry.event.tag === 'AGENT_RAN') {
      pendingNotes = []; // the turn after a note has seen it — consumed
    }
    if (entry.event.tag === 'CONTRACT_COMPILED') {
      contract = entry.event.contract;
      contractHash = entry.event.contract.contractHash;
    }
    if (entry.event.tag === 'PLAN_COMPILED') {
      plan = entry.event.plan;
    }
    // A phased run's PHASE_ADVANCED both DRIVES the reducer (advance to the next phase) AND records
    // the checkpoint tree for baseline reconstruction on resume (issue #48) — so it is fed to step()
    // *and* updates `baseline`, unlike the pure CHECKPOINTED marker.
    if (entry.event.tag === 'PHASE_ADVANCED') {
      baseline = entry.event.tree;
      phaseBaseline = entry.event.tree;
    }
    // With extended budget caps, the persisted `exceeded` flags are re-judged against the new caps
    // (raw spent numbers stay the persisted facts) — else the fold would re-abort at the old cap.
    [state, commands] = step(state, budgetExtended ? rejudgeBudget(entry.event, effective) : entry.event);
  }

  return {
    state,
    commands,
    contract,
    contractHash,
    baseline,
    phaseBaseline,
    plan,
    pendingNote: pendingNotes.length > 0 ? pendingNotes.join('\n\n') : null,
  };
}
