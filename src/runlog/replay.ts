import type { RunConfig } from '../domain/config';
import type { CompiledContract } from '../domain/contract';
import type { PhasePlan } from '../domain/plan';
import type { Command, OrchestratorEvent, RunExtension } from '../domain/events';
import type { ContractHash, DiffHash } from '../domain/ids';
import type { LoopCtx, OrchestratorState } from '../orchestrator/state';
import { initial, step } from '../orchestrator/step';
import { normalizeDetail } from '../orchestrator/stuck';
import { isUnevaluable } from '../domain/verdict';
import type { RunLogEntry } from './runlog';

/**
 * Streak relief on `--resume` — the counted stuck detectors re-derive their streaks by replaying the
 * log, so a run that ABORTED at the harness-crash threshold hits it again on the very first fold and
 * terminates before the harness gets a single turn. That is wrong on its face: `--resume` is the
 * operator's explicit statement that something was changed (a flag, a credential, an autonomy level,
 * the tree), and goaly's own remediation already tells them to work around it by hand with
 * `--resume … --stuck-crash-threshold 4`.
 *
 * This computes that workaround instead of asking for it: for each COUNTED detector, raise its
 * threshold by the length of the streak the log has already banked, so the resumed run must earn a
 * fresh streak of the configured length before aborting again. Deliberate properties:
 *
 *  - Derived from the ENTRIES, not the replayed state: a terminal `ABORTED` state has already
 *    discarded its `LoopCtx`, so the histories are unreachable there.
 *  - Measured off the ORIGINAL (header) thresholds, so resuming repeatedly re-measures rather than
 *    compounding a bump on top of a bump.
 *  - Only for a run that actually ABORTED; a resume of an interrupted or at-cap run changes nothing.
 *  - Only the counted detectors. `noDiff` is a TOGGLE, not a counter, so "relief" could only mean
 *    disabling it for the rest of the run — too blunt to do implicitly (it is also already excused
 *    when the previous turn crashed/timed out/was truncated). Pass `--stuck-no-diff false` for that.
 *  - NOT `timeoutNoDiffThreshold` (issue #119) either, even though it IS a counter: relief there
 *    would buy more ten-minute no-op turns at the same cap, which is the very waste that detector
 *    exists to stop. What makes those turns worth having is more room — `--harness-timeout-ms` /
 *    `--harness-idle-timeout-ms` — but be precise about what a resume can do with them: they are
 *    compose-time flags, NOT `RunExtension` fields, so a resume carrying only them produces no
 *    extension, this fold re-trips the detector at the tail, and the run re-terminates before a
 *    single turn. Continuing such a run therefore REQUIRES an explicit
 *    `--stuck-timeout-no-diff-threshold` on the resume (it is in `RunExtension.stuck`), which is
 *    what the abort message names first. Its own fold-desynchronization hazard (a log predating the
 *    detector can trip it MID-log, which relief here — tail-only by construction — could not cover
 *    anyway) is handled where it belongs, in the fold itself: see
 *    {@link TIMEOUT_NO_DIFF_UNREACHABLE}.
 *
 * It is not a weakening of stuck detection: the returned overlay is persisted as an ordinary
 * RUN_EXTENDED marker (ADR 0012 — operational knobs only, the frozen contract is unreachable
 * through it), so it is auditable in the log, and an explicit `--stuck-*` flag still overrides it.
 * Pure: no IO, no clock.
 */
export function resumeStreakRelief(
  config: RunConfig,
  entries: readonly RunLogEntry[],
): NonNullable<RunExtension['stuck']> {
  if (entries[entries.length - 1]?.stateTagAfter !== 'ABORTED') return {};
  const base = config.stuckPolicy;
  const crash = trailingCrashStreak(entries);
  const uneval = trailingUnevaluableStreak(entries);
  const repeat = adjudicated(entries) ? 0 : trailingRepeatStreak(entries);
  return {
    ...(crash > 0 ? { harnessCrashThreshold: base.harnessCrashThreshold + crash } : {}),
    ...(uneval > 0 ? { unevaluableThreshold: base.unevaluableThreshold + uneval } : {}),
    ...(repeat > 1 ? { repeatFailureThreshold: base.repeatFailureThreshold + repeat } : {}),
  };
}

/**
 * Did this run adjudicate its contract in-loop (issue #116), and how did it come out?
 * `'defective'` / `'sound'` / `undefined` (never adjudicated). The LAST verdict wins; a run
 * adjudicates at most once in practice.
 *
 * Both verdicts suppress the repeat-failure relief above, and the reason is the SAME for both — but
 * it is NOT the one the old comment gave ("more iterations against an unsatisfiable assertion are
 * still unsatisfiable"), which is true only of `defective`. The real reason is structural: an
 * adjudicated run's ABORTED comes from a RECORDED `CONTRACT_ADJUDICATED` event, and replay folds
 * that event to ABORTED whatever the thresholds say. Raising the threshold — automatically here, or
 * through the ADR-0012 operator door (`--resume <id> --stuck-repeat-threshold N`) — therefore cannot
 * un-terminate the run in either case. Emitting relief for a `sound` verdict would not continue the
 * run; it would only bank an inert RUN_EXTENDED marker and print a promise goaly cannot keep.
 *
 * That is a real dead end for a `sound` verdict, and it is closed by MESSAGING, not by relief: the
 * abort carries `CONTRACT_ADJUDICATED_SOUND` (see `contractSoundReason`) so `nextStepHint` and the
 * CLI's resume warning name `goaly "<goal>" --from-run <id>` — a route that exists — instead of a
 * threshold flag that does nothing or a `--recontract` that `planRecontract` refuses for a sound bar.
 *
 * Suppression here is also deliberately NOT what keeps the fold in sync — the operator door reaches
 * the same config anyway. The fold defends itself: see {@link adjudicationPrecursors}, which pins
 * the historical threshold for BOTH verdicts.
 */
export function adjudicationVerdict(
  entries: readonly RunLogEntry[],
): 'defective' | 'sound' | undefined {
  let verdict: 'defective' | 'sound' | undefined;
  for (const e of entries) {
    if (e.event.tag === 'CONTRACT_ADJUDICATED') verdict = e.event.defective ? 'defective' : 'sound';
  }
  return verdict;
}

/** True when the run adjudicated its contract in-loop, whatever the verdict. */
export function adjudicated(entries: readonly RunLogEntry[]): boolean {
  return adjudicationVerdict(entries) !== undefined;
}

/** How many of the most recent harness turns crashed, back-to-back. Mirrors `isCrashStreak`. */
function trailingCrashStreak(entries: readonly RunLogEntry[]): number {
  let streak = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const event = entries[i]?.event;
    if (event?.tag !== 'AGENT_RAN') continue;
    if (event.run.status !== 'crashed') break;
    streak++;
  }
  return streak;
}

/** How many of the most recent ladder verdicts were could-not-evaluate. Mirrors `isUnevaluableStreak`. */
function trailingUnevaluableStreak(entries: readonly RunLogEntry[]): number {
  let streak = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const event = entries[i]?.event;
    if (event?.tag !== 'VERIFIED') continue;
    if (!isUnevaluable(event.verdict)) break;
    streak++;
  }
  return streak;
}

/**
 * How many of the most recent ladder verdicts were the SAME normalized failure, back-to-back.
 * Mirrors `isRepeating` over `verifierDetailHistory`, including its reset on a pass (the reducer
 * clears that history whenever the ladder goes green).
 */
function trailingRepeatStreak(entries: readonly RunLogEntry[]): number {
  let streak = 0;
  let signature: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const event = entries[i]?.event;
    if (event?.tag !== 'VERIFIED') continue;
    if (event.verdict.pass) break;
    const detail = normalizeDetail(event.verdict.detail);
    if (signature === undefined) signature = detail;
    else if (detail !== signature) break;
    streak++;
  }
  return streak;
}

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
      ...(s.timeoutNoDiffThreshold !== undefined
        ? { timeoutNoDiffThreshold: s.timeoutNoDiffThreshold }
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
 * Driver-side marker events: recorded in the log for replay fidelity but NEVER fed to `step()`
 * (invariant #1 — the reducer never learns they existed). Shared by the fold below and by
 * {@link lastFoldedIndex}, so "which entry is the last one the reducer sees" cannot drift from
 * "which entries the reducer sees".
 */
const DRIVER_ONLY_TAGS: ReadonlySet<string> = new Set([
  'CHECKPOINTED',
  'CANDIDATE_RAN',
  'CANDIDATE_SELECTED',
  'RUN_EXTENDED',
]);

/** Index of the last entry the reducer actually folds, or -1 when there is none. */
function lastFoldedIndex(entries: readonly RunLogEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const tag = entries[i]?.event.tag;
    if (tag !== undefined && !DRIVER_ONLY_TAGS.has(tag)) return i;
  }
  return -1;
}

/**
 * An effectively unreachable timeout-no-diff threshold — the streak is bounded by the iteration
 * count, so this DISABLES the detector for the fold it is applied to.
 *
 * Back-compat for the timeout-no-diff detector (issue #119) — the ONE detector that turned a
 * decision which previously returned `CONTINUE` into a terminal `ABORTED`. A run log written
 * BEFORE it existed can therefore contain a mid-log timeout+no-diff streak that the run simply
 * continued past; folding such a log under the new binary would go terminal in the MIDDLE, and the
 * next entry would hit `step() called on terminal state ABORTED` — permanently bricking `--resume`
 * and `runs show/list` for a run whose tree may be perfectly fine.
 *
 * So the trip is made TAIL-SENSITIVE: every fold except the LAST one the reducer sees runs with the
 * detector disabled, which is exactly the pre-#119 semantics (`noDiffExcusedByRun` reads the same
 * threshold, so an unreachable value restores the unbounded timeout excuse too). Nothing is
 * weakened for a log written after #119: the trip is terminal, so its VERIFIED entry IS the last
 * folded entry, and the tail fold uses the real (possibly RUN_EXTENDED-overlaid) threshold.
 *
 * This is a REPLAY-side concern, not a reducer one (invariant #1/#8): `detectStuck` stays pure and
 * purely history-driven — it is only ever handed a config, and here replay chooses which one.
 */
const TIMEOUT_NO_DIFF_UNREACHABLE = Number.MAX_SAFE_INTEGER;

/**
 * Entry index → the repeat-failure threshold the fold MUST use, for every entry the log PROVES the
 * repeat detector tripped at.
 *
 * `CONTRACT_ADJUDICATED` is only ever recorded out of `ADJUDICATING`, which `decide` enters ONLY on
 * a `repeat` stuck trip (issue #116). So such an entry is proof that the repeat detector tripped at
 * the folded entry just before it — a historical trip with a recorded downstream event, which no
 * later relief may un-trip. The automatic resume relief already refuses to raise the threshold once
 * a verdict is recorded, but the ADR-0012 OPERATOR extension reaches the same config through a
 * different door (`--resume <id> --stuck-repeat-threshold N` — which goaly's own `nextStepHint`
 * printed after a `defective:false` adjudication, whose abort text used to be identical to the pre-#116
 * repeat abort). Whichever door it came through, applying it before the fold made that VERIFIED
 * return CONTINUE and the very next entry throw
 * `invalid transition: event CONTRACT_ADJUDICATED in state RUNNING_AGENT` — a run that cannot be
 * continued at all.
 *
 * The threshold used is the one that was IN FORCE THERE: the header value plus every RUN_EXTENDED
 * overlay recorded BEFORE that entry. An overlay recorded after it cannot have applied to it (a
 * marker is only ever appended at the tail, and this entry already has a folded successor), and
 * using the historical value reproduces the recorded transition exactly — the abort reason QUOTES
 * the threshold, so a merely trip-forcing value would rewrite the run's own text.
 */
function adjudicationPrecursors(
  config: RunConfig,
  entries: readonly RunLogEntry[],
): ReadonlyMap<number, number> {
  const precursors = new Map<number, number>();
  let previousFolded = -1;
  let threshold = config.stuckPolicy.repeatFailureThreshold;
  let previousThreshold = threshold;
  for (let i = 0; i < entries.length; i += 1) {
    const event = entries[i]?.event;
    if (event === undefined) continue;
    if (event.tag === 'RUN_EXTENDED') {
      threshold = event.stuck?.repeatFailureThreshold ?? threshold;
      continue;
    }
    if (DRIVER_ONLY_TAGS.has(event.tag)) continue;
    if (event.tag === 'CONTRACT_ADJUDICATED' && previousFolded >= 0) {
      precursors.set(previousFolded, previousThreshold);
    }
    previousFolded = i;
    previousThreshold = threshold;
  }
  return precursors;
}

/**
 * Rewrite the fold-local stuck thresholds on a state's `LoopCtx`. The two knobs replay overrides —
 * `timeoutNoDiffThreshold` (see {@link TIMEOUT_NO_DIFF_UNREACHABLE}) and `repeatFailureThreshold`
 * (see {@link adjudicationPrecursors}) — are both cases of the SAME rule: relief may only change
 * whether a detector trips where the log recorded no outcome off that decision. Every fold sets
 * both explicitly, so the previous fold's override can never leak forward.
 *
 * This is a REPLAY-side concern, not a reducer one (invariant #1/#8): `detectStuck` stays pure and
 * purely history-driven — it is only ever handed a config, and here replay chooses which one.
 */
function withStuckThresholds(
  state: OrchestratorState,
  thresholds: { timeoutNoDiff?: number; repeat?: number },
): OrchestratorState {
  switch (state.tag) {
    case 'RUNNING_AGENT':
    case 'VERIFYING':
    case 'AWAIT_SIGNOFF':
    case 'ADJUDICATING': {
      const { config } = state.ctx;
      const timeoutNoDiff = thresholds.timeoutNoDiff ?? config.stuckPolicy.timeoutNoDiffThreshold;
      const repeat = thresholds.repeat ?? config.stuckPolicy.repeatFailureThreshold;
      if (
        config.stuckPolicy.timeoutNoDiffThreshold === timeoutNoDiff &&
        config.stuckPolicy.repeatFailureThreshold === repeat
      ) {
        return state;
      }
      const ctx: LoopCtx = {
        ...state.ctx,
        config: {
          ...config,
          stuckPolicy: {
            ...config.stuckPolicy,
            timeoutNoDiffThreshold: timeoutNoDiff,
            repeatFailureThreshold: repeat,
          },
        },
      };
      return { ...state, ctx };
    }
    default:
      return state;
  }
}

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
  // The last entry the reducer will fold — every earlier fold is a HISTORICAL decision the log has
  // already recorded the outcome of, so the timeout-no-diff trip is suppressed there (see
  // `TIMEOUT_NO_DIFF_UNREACHABLE`) and only the tail can go terminal on it.
  const tailIndex = lastFoldedIndex(entries);
  // Entries the log PROVES the repeat detector tripped at (a `CONTRACT_ADJUDICATED` was recorded off
  // them). A raised threshold — from the automatic relief or from an operator `--stuck-repeat-threshold`
  // — must not un-trip those, or the very next entry is an invalid transition.
  const precursors = adjudicationPrecursors(config, entries);

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
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
    // EXPERIMENTAL parallel waves: like PHASE_ADVANCED, a wave both DRIVES the reducer (skip/advance
    // bookkeeping) and records the post-merge checkpoint tree for baseline reconstruction on resume.
    if (entry.event.tag === 'WAVE_RAN') {
      baseline = entry.event.tree;
      phaseBaseline = entry.event.tree;
    }
    // With extended budget caps, the persisted `exceeded` flags are re-judged against the new caps
    // (raw spent numbers stay the persisted facts) — else the fold would re-abort at the old cap.
    const folded = withStuckThresholds(state, {
      timeoutNoDiff:
        index === tailIndex
          ? effective.stuckPolicy.timeoutNoDiffThreshold
          : TIMEOUT_NO_DIFF_UNREACHABLE,
      repeat: precursors.get(index) ?? effective.stuckPolicy.repeatFailureThreshold,
    });
    [state, commands] = step(
      folded,
      budgetExtended ? rejudgeBudget(entry.event, effective) : entry.event,
    );
  }
  // Hand the caller a state whose ctx carries the run's REAL thresholds: the overrides above are
  // fold-local scaffolding, and the Driver continues the live run from this very state.
  state = withStuckThresholds(state, {
    timeoutNoDiff: effective.stuckPolicy.timeoutNoDiffThreshold,
    repeat: effective.stuckPolicy.repeatFailureThreshold,
  });

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
