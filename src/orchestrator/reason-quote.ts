/**
 * WHERE A TERMINAL REASON STOPS BEING GOALY'S OWN WORDS.
 *
 * A terminal reason carries external evidence so the failure is diagnosable: the repeated verifier
 * signature, an adjudicator's prose, the harness's last stderr, a setup command's output. All of it
 * is WORKER-REACHABLE — a test name, an assertion message or a crashing tool's output becomes part
 * of the reason — so anything that makes a DECISION from a reason (today: the CLI's next-step hint,
 * `goalyAuthoredReason` in `src/cli/reason-text.ts`) must read only the part goaly authored.
 *
 * This module owns that boundary for the WHOLE reducer, so the rule is not stated in one module and
 * broken in another. Two rules make the boundary statable, and both are enforced by the test
 * `src/orchestrator/reason-boundary.test.ts` — which enumerates every stuck kind, every exported
 * reason builder and every terminal prepare outcome from the code itself, feeds each a poisoned
 * payload, and fails when the payload reaches the prefix (or when a NEW builder is not covered):
 *
 *  1. every reason builder that interpolates external text puts one of these lead-ins immediately
 *     in front of it, and
 *  2. every goaly-authored marker (`CONTRACT_DEFECTIVE`, `CONTRACT_ADJUDICATED_SOUND`, `STUCK_*`,
 *     `TOOLS_MISSING`, `SETUP_FAILED`, `CONTRACT_UNSOUND`) is emitted BEFORE the first quote.
 *
 * So `reason.slice(0, indexOfFirstLeadIn)` is the goaly-authored part, and a reader that matches
 * only that prefix cannot be steered by the worker: moving the boundary earlier only removes the
 * worker's OWN text from view.
 *
 * HONEST SCOPE — what the prefix is, exactly. It is text goaly authored, plus two kinds of value
 * that were FROZEN before the loop began and that the worker cannot reach mid-run: the compiled
 * contract's authored file paths (`contractDefectiveReason`) and, in a phased run, the sealed plan's
 * sub-goal title (`phaseReason`). It is NOT a claim about reasons that are wholly DELEGATED rather
 * than built here — a compile/plan failure message (`COMPILE_FAILED` / `PLAN_FAILED`, whose text is
 * the compiler LLM's or an exception's) and a human Seal reject reason are passed through verbatim,
 * so for those the "prefix" is the entire reason. They are authored before any worker turn, so the
 * worker cannot steer them, but they are not goaly's own words either.
 */

/** The repeated (normalized) verifier failure signature — worker-authored (test names, assertions). */
export const SIGNATURE_QUOTE = 'Repeated failure signature: ';

/** The in-loop adjudicator's prose about the frozen bar — LLM-authored over worker-authored input. */
export const ADJUDICATOR_QUOTE = 'Adjudicator: ';

/** The agent CLI's own last output on a crash streak — whatever the harness printed. */
export const HARNESS_OUTPUT_QUOTE = 'Last harness output: ';

/** The verifier's own last output on an unevaluable streak — whatever the check printed. */
export const VERIFIER_OUTPUT_QUOTE = 'Last verifier output: ';

/** The pre-loop required-tools check's detail — names the tools the verification could not find. */
export const TOOLS_DETAIL_QUOTE = 'Missing tools: ';

/** The one-time setup command's own stderr/stdout (see `runSetup` in `src/driver/prepare.ts`). */
export const SETUP_OUTPUT_QUOTE = 'Setup output: ';

/** The soundness pre-flight's evidence: the classifier's prose plus the rung's raw output. */
export const PREFLIGHT_OUTPUT_QUOTE = 'Pre-flight output: ';

/**
 * A NESTED reason carried as context (`contractSoundReason` / `contractDefectiveReason` both append
 * the original stuck condition). The nested reason has its own goaly-authored prefix, but composing
 * one reason into another would make "the earliest lead-in" depend on which detector tripped — so the
 * whole nested reason is treated as quoted, and the composing builder puts its marker ahead of it.
 */
export const NESTED_REASON_QUOTE = 'Original stuck condition: ';

/** All of the above, in no particular order — a reader takes the EARLIEST match in a reason. */
export const QUOTED_TEXT_LEAD_INS: readonly string[] = [
  SIGNATURE_QUOTE,
  ADJUDICATOR_QUOTE,
  HARNESS_OUTPUT_QUOTE,
  VERIFIER_OUTPUT_QUOTE,
  TOOLS_DETAIL_QUOTE,
  SETUP_OUTPUT_QUOTE,
  PREFLIGHT_OUTPUT_QUOTE,
  NESTED_REASON_QUOTE,
];
