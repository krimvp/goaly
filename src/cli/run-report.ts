import { recontractCommand } from '../followup/recontract';
import type { RunOutcome, RunExtension } from '../domain/events';
import type { RunLogEntry } from '../runlog/runlog';
import { adjudicationVerdict } from '../runlog/replay';
import { CONTRACT_SOUND_MARKER } from '../orchestrator/stuck';
import { hintSubject } from './reason-text';
import { renderResumeHint, type ResumeHint } from './resume-cmd';
import { degradedModeDetail, degradedModeTag, type DegradedMode } from '../domain/degraded';
import type { CostView } from './cost';
import { formatDuration, formatUsage } from './usage-format';

/**
 * The human-facing TEXT of the `goaly run` path: the end-of-run outcome report, its one-line
 * "what do I do now" hint, and the resume-time notices that quote the run log. Pure string
 * builders — no IO — split out of `run-cmd.ts` so the wording sits together and stays testable
 * without a run.
 */

/**
 * Human-readable summary of a {@link resumeStreakRelief} overlay, for the one-line notice the resume
 * path prints. Names each raised threshold and its new value so the relief is auditable on screen,
 * not just in the log's RUN_EXTENDED marker.
 */
export function describeRelief(relief: NonNullable<RunExtension['stuck']>): string {
  const parts: string[] = [];
  if (relief.harnessCrashThreshold !== undefined) {
    parts.push(`--stuck-crash-threshold ${relief.harnessCrashThreshold}`);
  }
  if (relief.unevaluableThreshold !== undefined) {
    parts.push(`--stuck-unevaluable-threshold ${relief.unevaluableThreshold}`);
  }
  if (relief.repeatFailureThreshold !== undefined) {
    parts.push(`--stuck-repeat-threshold ${relief.repeatFailureThreshold}`);
  }
  return parts.join(', ');
}

/**
 * The warning for `--resume <id> --stuck-repeat-threshold N` on a run that ADJUDICATED its contract
 * in-loop (issue #116) — and the route that actually exists, chosen by the VERDICT.
 *
 * Why the flag cannot work, for either verdict: an adjudicated run ends on a RECORDED
 * `CONTRACT_ADJUDICATED` event. Replay folds that event and lands on ABORTED no matter what the
 * stuck thresholds say, so no `--resume` extension un-terminates it. (A plain repeat abort ends on a
 * re-derived detector trip, which is why the same flag genuinely continues THAT run.)
 *
 * Why the route differs: `planRecontract` guard 1 accepts a `defective: true` verdict — the bar is
 * the thing to replace — and REFUSES a `defective: false` one, whose whole meaning is that the bar
 * is fine. Pointing a sound-verdict run at `--recontract` (as this warning used to, unconditionally)
 * named a command that refuses it, closing the last exit. A sound verdict keeps the tree and carries
 * the goal forward with `--from-run`.
 */
export function adjudicatedResumeWarning(
  entries: readonly RunLogEntry[],
  runId: string,
): string | undefined {
  const verdict = adjudicationVerdict(entries);
  if (verdict === undefined) return undefined;
  const head =
    `goaly: --resume: this run's contract was already adjudicated in-loop, so ` +
    `--stuck-repeat-threshold does not continue it — the recorded adjudication replays as it ` +
    `happened, and the run re-terminates before the harness gets a turn.`;
  if (verdict === 'defective') {
    return `${head} The bar itself was judged unsatisfiable, so more iterations against it cannot help; re-contract instead: ${recontractCommand(runId)}`;
  }
  return `${head} The bar was judged SATISFIABLE, so --recontract refuses this run (there is no defect to repair). Keep the tree and carry the goal forward: goaly "<goal>" --from-run ${runId}`;
}

/**
 * A one-line, always-on "what do I do now" for the common terminal reasons — the zero-cost,
 * non-LLM complement to `--explain`. A first-time user seeing `status: ABORTED / reason: no-diff:
 * working tree unchanged…` should not need to read the architecture docs to know the next step.
 * Matched on the typed reason prefixes/tags the reducer and stuck detectors emit (`no-diff`,
 * `oscillation`, `STUCK_HARNESS_CRASH`, `STUCK_TIMEOUT_NO_DIFF`, `CONTRACT_DEFECTIVE`, …); an
 * unknown reason gets no hint.
 *
 * Matched against {@link hintSubject}, NOT the raw reason. An abort reason quotes worker-steerable
 * text (the repeated verifier signature, the adjudicator's prose, the harness's stderr), and the
 * generic rows below are plain substrings — so a test named `handles no-diff` inside an adjudicated
 * run's signature used to hijack the hint and point the operator at `--stuck-no-diff false`, which
 * provably cannot continue that run (an adjudicated abort is folded from a RECORDED event; no
 * threshold un-terminates it). Reading only goaly's own words closes that; the typed-marker rows are
 * additionally ordered ahead of the generic ones so the marker always wins on its own reason.
 */
export function nextStepHint(o: RunOutcome): string | undefined {
  const reason = hintSubject(o.reason ?? '');
  const inspect = `inspect with: goaly runs show ${o.runId}`;
  const resume = `goaly --resume ${o.runId}`;
  if (o.status === 'DONE' || reason.length === 0) return undefined;
  if (reason.includes('interrupted by user')) return undefined; // the reason already says how to resume
  // Every "…and continue" hint names the EXACT extension flag: a terminal run replays back to the
  // same terminal state on a plain resume — only a --resume extension (ADR 0012) un-terminates it.
  const table: readonly (readonly [RegExp, string])[] = [
    // A harness that REFUSED an action (droid at `--auto low`) is not a crashing CLI: the reason
    // already carries goaly's own `autonomy-refused` remediation (the codec named only the kind —
    // see REMEDIATION_ADVICE in `src/orchestrator/stuck.ts`), so this row matches goaly-authored
    // words, points at the autonomy flag rather than install/auth, and at a plain resume rather
    // than at raising the crash threshold.
    [/STUCK_HARNESS_CRASH[\s\S]*autonomy level/, `the harness refused an action at its autonomy level — raise it and continue: ${resume} --harness-autonomy medium`],
    [/STUCK_HARNESS_CRASH/, `the agent CLI kept crashing — run it once by hand to check install/auth, then continue: ${resume} --stuck-crash-threshold 4`],
    [/CONTRACT_UNEVALUABLE/, `the verification could not RUN (environment problem, not a code red) — fix the tool/network it names, then continue: ${resume} --stuck-unevaluable-threshold 4`],
    // Matched BEFORE the generic /no-diff/ row: the tree stopped changing because the turn kept
    // being killed, so the fix is more room per turn, not `--stuck-no-diff false`.
    // --harness-timeout-ms / --harness-idle-timeout-ms are NOT RunExtension fields, so a resume
    // carrying only them produces no extension, the fold re-trips the detector at the tail, and the
    // run lands back in the identical terminal ABORTED with zero turns run. The threshold is what
    // un-terminates it; the timeouts are what make the extra turns worth having.
    [/STUCK_TIMEOUT_NO_DIFF/, `the agent kept being killed by the harness timeout with nothing to show — give a turn more room and continue: ${resume} --stuck-timeout-no-diff-threshold 4 --harness-timeout-ms 1800000 --harness-idle-timeout-ms 300000`],
    [/TOOLS_MISSING/, `install the tools named above (or rerun with --install-missing-tools true)`],
    [/SETUP_FAILED/, `fix the setup command, or override it with --setup-cmd / disable it with --no-setup`],
    [/CONTRACT_UNSOUND/, `the frozen verification itself is broken on this tree — start a fresh run with a corrected goal or an explicit --verify-cmd`],
    // Matched BEFORE the repeat-failure row (issue #116): a CONTRACT_DEFECTIVE reason CONTAINS the
    // repeat-failure text as context, and raising --stuck-repeat-threshold cannot help against a bar
    // no implementation can satisfy. The tree is worth keeping, so point at a fresh contract over the
    // SAME workspace, not at more iterations.
    [/CONTRACT_DEFECTIVE/, `the frozen bar itself was adjudicated defective — your tree may be correct, so KEEP it and re-contract: ${recontractCommand(o.runId)} (re-authors the bar from the defect report, keeps the tree, freezes a NEW contract under a NEW run id). Or own the bar yourself: goaly "<goal>" --from-run ${o.runId} --verify-cmd "<a check that is actually satisfiable>", or ${inspect}`],
    // Matched BEFORE the repeat-failure row: an adjudicated-SOUND run ends on a RECORDED event, so
    // --stuck-repeat-threshold (that row's advice) cannot un-terminate it.
    [new RegExp(CONTRACT_SOUND_MARKER), `the bar was adjudicated SATISFIABLE, so the tree simply has not met it yet — and the recorded adjudication ends THIS run whatever the thresholds say. Keep the tree and carry the goal forward: goaly "<goal>" --from-run ${o.runId}, or ${inspect}`],
    [/STUCK_REPEATED_FAILURE|identical .*failures/, `the same verifier failure repeated — steer it: ${resume} --stuck-repeat-threshold 6 --note "<hint>", or ${inspect}`],
    // ── Generic substring rows LAST ────────────────────────────────────────────────────────────
    // Everything above keys off a marker goaly itself emits; these match ordinary English that a
    // typed reason may also happen to contain, so they only get a say once no marker matched.
    [/budget exceeded/, `raise the cap and continue: ${resume} --budget-tokens <N> (or --budget-wall-ms <N>)`],
    [/reached maxIterations/, `continue with more room: ${resume} --max-iterations <N> --note "<guidance>", or ${inspect}`],
    [/no-diff/, `the agent stopped changing the tree — steer it: ${resume} --stuck-no-diff false --note "<hint>", or refine the goal in a follow-up: --from-run ${o.runId}`],
    [/oscillation/, `the agent is flip-flopping between two states — ${inspect}; steer it: ${resume} --stuck-oscillation false --note "<which way to go>"`],
    // COMPILE_FAILED / PLAN_FAILED are the typed markers the reducer now emits ahead of the quoted
    // authoring message (`src/orchestrator/reason-quote.ts`); the prose alternatives keep older logs
    // matching. Still a generic row: the marker sits in goaly's own words either way.
    [/COMPILE_FAILED|PLAN_FAILED|compile failed|plan failed/i, `the contract/plan could not be authored — check the --llm-provider CLI runs & is authenticated, then retry`],
  ];
  for (const [pattern, hint] of table) if (pattern.test(reason)) return hint;
  return undefined;
}

export function formatOutcome(
  o: RunOutcome,
  cost?: CostView,
  resume?: ResumeHint,
  degraded?: DegradedMode,
  elapsedMs?: number,
): string {
  const lines = [
    '',
    `── goaly run ${o.runId} ──`,
    `status:      ${o.status}`,
    `iterations:  ${o.iterations}`,
    // This invocation's wall clock only — a resumed run's full span is in `goaly runs show`.
    ...(elapsedMs !== undefined ? [`elapsed:     ${formatDuration(elapsedMs)}`] : []),
    `contract:    ${o.contractHash ?? '(none — failed before compile)'}`,
  ];
  // Issue #125: the typed degraded-mode label rides WITH the status, so a DONE whose two keys were
  // one model is never reported as an independently reviewed one. A label, never a gate.
  if (degraded !== undefined) {
    lines.push(`degraded:    ${degradedModeTag(degraded)} — ${degradedModeDetail(degraded)}`);
  }
  if (o.reason !== undefined) lines.push(`reason:      ${o.reason}`);
  const hint = nextStepHint(o);
  if (hint !== undefined) lines.push(`next:        ${hint}`);
  if (o.usage !== undefined) lines.push(...formatUsage(o.usage, cost));
  // Capability A end-of-run banner: only printed when there is something useful to continue with
  // (a real interactive-resume command, or the goaly-code follow-up route). Quiet otherwise.
  if (resume !== undefined) {
    const hintLines = renderResumeHint(resume);
    if (hintLines.length > 0) {
      lines.push('', 'Continue this session:', ...hintLines.map((l) => `  ${l}`));
    }
  }
  return lines.join('\n');
}
