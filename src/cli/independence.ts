import type { HarnessChoice, LlmProviderChoice } from './args';
import type { ResolvedModels } from './models';
import type { DegradedMode } from '../domain/degraded';

/**
 * "Two independent keys" (invariant #3) is only real if the verifier's judge rung and the Sign-off
 * approver — and ideally the worker — do not collapse onto a single model with correlated blind
 * spots. The cascade in {@link resolveModels} makes that collapse the DEFAULT: with a
 * single `--model X` (or no overrides at all) the judge and the approver resolve to the same model.
 * These are advisory warnings, surfaced loudly at composition; they never fail a run.
 */

/** The llm-provider family whose model vendor matches a given harness CLI. */
function harnessFamily(harness: HarnessChoice): LlmProviderChoice | undefined {
  switch (harness) {
    case 'claude':
      return 'claude';
    case 'codex':
      return 'codex';
    case 'droid':
      return 'droid';
    case 'goaly-code':
      // The goaly-code harness drives an OpenAI-compatible endpoint — the same family as the openai provider.
      return 'openai';
    case 'pi':
    case 'fake':
      return undefined;
  }
}

/** `undefined` means "that tool's own default"; two undefineds are the same default model. */
const sameModel = (a: string | undefined, b: string | undefined): boolean => a === b;

const label = (m: string | undefined): string => m ?? 'the tool default';

/**
 * How independent one role is FROM the Sign-off approver. Three states, not two — because goaly can
 * only ever compare the models it was ASKED for, and one wiring leaves it comparing a known id
 * against an id it cannot resolve:
 *
 *  - `collapsed`   — the two resolved to the SAME model. Observed, not inferred.
 *  - `independent` — the two resolved to DIFFERENT KNOWN models (or different vendors entirely).
 *  - `unverified`  — the approver was defaulted to the LLM provider's OWN model (issue #125's
 *    approver-independence default) and goaly cannot resolve that provider's default id. `X !==
 *    undefined` is then not evidence of anything: if the provider's default IS X, the roles have
 *    collapsed and a strict-equality check reports independence anyway. This is exactly the
 *    silent-degradation the third state exists to make impossible.
 */
type Independence = 'collapsed' | 'independent' | 'unverified';

/**
 * True when the approver was left on the LLM provider's own default model by the issue-#125
 * independence default: `approver` is unset AND `approverIndependentFrom` records the agent model it
 * declined. That pairing is what marks "goaly asked for a different model but cannot confirm it got
 * one" — an ordinary `undefined` approver (no `--model` in play at all) is a plain shared default and
 * still compares equal, so it stays a `collapsed`.
 */
function approverOnUnresolvableDefault(resolved: ResolvedModels): boolean {
  return resolved.approver === undefined && resolved.approverIndependentFrom !== undefined;
}

/** Compare one role's model against the approver's, honestly — including "cannot tell". */
function independenceFrom(role: string | undefined, resolved: ResolvedModels): Independence {
  if (sameModel(role, resolved.approver)) return 'collapsed';
  if (approverOnUnresolvableDefault(resolved)) return 'unverified';
  return 'independent';
}

/**
 * Run-shape context (follow-on H) that lets the independence check ESCALATE for the most
 * deadlock-prone wiring: `--generate --autonomous`, where the model both self-authors its bar AND
 * self-judges it with no human in the loop. Both default to false so a caller that omits them gets
 * the plain advisory warnings (back-compat with the 3-arg callers).
 */
export type IndependenceContext = {
  /** The verification is LLM-authored (`--generate`), not a user-supplied `--verify-cmd`. */
  generate?: boolean;
  /** Seal (and the plan) are auto-accepted (`--autonomous`) — no human reviews the frozen bar. */
  autonomous?: boolean;
  /**
   * Sign-off approver panel size (issue #84). A `> 1` quorum on ONE model is VARIANCE REDUCTION, not
   * perspective independence — it does not break the judge↔/worker↔approver collapse below. Surfaced
   * so a multi-vote panel on the same model isn't mistaken for a genuinely independent second key.
   * Default 1 ⇒ the single-call approver (no extra note).
   */
  approverQuorum?: number;
  /**
   * Per-reviewer Sign-off models (follow-up to issue #84). When this lists ≥2 DISTINCT models, the
   * panel IS perspective-independent — distinct vendors/models with uncorrelated blind spots, not one
   * model re-sampled. That genuinely supplies the independent second key, so the judge↔approver,
   * worker↔approver, and variance-reduction warnings are all SUPPRESSED. A single distinct model (a
   * one-entry list, or every entry the same) collapses back to the single-model panel and the
   * warnings still apply. Absent ⇒ the single-model approver.
   */
  approverModels?: string[];
};

/** True when the per-reviewer list supplies ≥2 DISTINCT models — a genuinely independent panel. */
function panelIsModelIndependent(models: string[] | undefined): boolean {
  if (models === undefined) return false;
  return new Set(models).size >= 2;
}

/**
 * Which of the two collapses the resolved wiring has. Shared by the advisory warnings and the typed
 * degraded-mode label so the WARN on screen and the flag in the run header can never disagree.
 *
 * A `--approver-models` panel with ≥2 DISTINCT models is the genuinely independent second key: the
 * approver no longer collapses onto the judge's or the worker's model, so both collapses are false.
 * (A one-model panel — a single entry or all-identical entries — falls back to the single-model
 * approver and the collapses still apply.)
 */
function collapses(
  resolved: ResolvedModels,
  harness: HarnessChoice,
  llmProvider: LlmProviderChoice,
  context: IndependenceContext,
): { judgeApprover: Independence; workerApprover: Independence } {
  if (panelIsModelIndependent(context.approverModels)) {
    return { judgeApprover: 'independent', workerApprover: 'independent' };
  }
  return {
    judgeApprover: independenceFrom(resolved.judge, resolved),
    // A worker on a DIFFERENT vendor family than the approver's provider cannot share its model at
    // all, so that pair is independent without needing to resolve any default id.
    workerApprover:
      harnessFamily(harness) === llmProvider ? independenceFrom(resolved.harness, resolved) : 'independent',
  };
}

/**
 * The typed degraded-mode label (issue #125) for a resolved wiring: present when BOTH pairs — the
 * judge rung and the coding agent, each against the Sign-off approver — fail to be established as
 * independent. That is the configuration where the two keys may be drawn from a single distribution,
 * so a DONE it produces is labelled in the run header, the terminal summary and `goaly runs show`
 * instead of only in a startup WARN nobody is present to read. A partial collapse (judge↔approver
 * only, say) still gets its advisory warning below but is NOT recorded as a degraded run — the second
 * key is still a different model than the one that wrote the code.
 *
 * Two kinds, and the distinction is load-bearing:
 *  - `self-judged` — both pairs OBSERVED to be the same model (goaly compared two known ids).
 *  - `independence-unverified` — at least one pair could not be established either way, because the
 *    approver sits on the provider's own unresolvable default. goaly asked for a distinct second key
 *    and cannot confirm it got one. Before this, that wiring produced NO label and NO warning at all,
 *    which reads as "verified independent" — strictly worse than the loud self-judged label it
 *    replaced. An unverifiable claim is never reported as a verified one.
 *
 * Pure: it labels, it never gates. Nothing here can promote or block a DONE.
 */
export function degradedMode(
  resolved: ResolvedModels,
  harness: HarnessChoice,
  llmProvider: LlmProviderChoice,
  context: IndependenceContext = {},
): DegradedMode | undefined {
  const c = collapses(resolved, harness, llmProvider, context);
  if (c.judgeApprover === 'independent' || c.workerApprover === 'independent') return undefined;
  const verified = c.judgeApprover === 'collapsed' && c.workerApprover === 'collapsed';
  // `self-judged` names the model every role shares; `independence-unverified` names the model the
  // agent + judge share — the one the approver's unresolvable default might turn out to be.
  const model = verified ? resolved.approver : resolved.approverIndependentFrom;
  return {
    kind: verified ? 'self-judged' : 'independence-unverified',
    ...(model !== undefined ? { model } : {}),
    generate: context.generate === true,
    autonomous: context.autonomous === true,
  };
}

/**
 * The startup notice for issue #125's approver-independence default: the Sign-off approver DECLINED
 * to inherit the agent's `--model` and was defaulted to the LLM provider's own model. `undefined`
 * when the default did not fire (nothing to announce).
 *
 * It branches on the SAME {@link Independence} value the warnings and {@link degradedMode} compute,
 * because the two wordings are not interchangeable. Declining to inherit `--model X` is a REQUEST
 * for a distinct second key, not a confirmed one: when the harness family and the LLM provider are
 * the same vendor, goaly cannot resolve that provider's own default model id, so "the second key is
 * a different model than the one that wrote the code" is a claim it never established — and it was
 * printed sandwiched between two INDEPENDENCE-UNVERIFIED warnings, the most strongly-worded of the
 * four being the false one. Only a pair established `independent` (a cross-vendor worker, or two
 * different known ids) earns the confirmed wording.
 */
export function approverSwapNotice(
  resolved: ResolvedModels,
  harness: HarnessChoice,
  llmProvider: LlmProviderChoice,
  context: IndependenceContext = {},
): string | undefined {
  const agent = resolved.approverIndependentFrom;
  if (agent === undefined) return undefined;
  const { workerApprover } = collapses(resolved, harness, llmProvider, context);
  const head =
    `Sign-off approver DECLINED to inherit the coding agent's --model ${agent}: --model selects ` +
    `the agent (and the judge rung), so the approver falls back to the ${llmProvider} provider's ` +
    'own model instead of inheriting it. ';
  const tail =
    `Pass --approver-model ${agent} to collapse them again, or --approver-model <other> / ` +
    '--approver-models to choose the skeptic yourself.';
  if (workerApprover === 'independent') {
    return `${head}The coding agent runs on a DIFFERENT vendor family than the approver's provider, so the second key cannot be the model that wrote the code. ${tail}`;
  }
  return `${head}INDEPENDENCE UNVERIFIED: goaly cannot resolve that provider's default model id, so it CANNOT confirm the second key differs from the model that wrote the code — if the default IS ${agent}, the two keys share one model. ${tail}`;
}

/**
 * The advisory for a pair goaly could NOT establish either way: the role's model is known, the
 * approver's is the provider's own default, and goaly has no way to resolve that default's id. It
 * says what is true — the check could not be made — and names the flag that makes it checkable.
 * Deliberately distinct wording from the observed-collapse warnings so the two are never conflated.
 */
function unverifiedWarning(role: string, resolved: ResolvedModels): string {
  const agent = label(resolved.approverIndependentFrom);
  return (
    `INDEPENDENCE UNVERIFIED: ${role} runs on ${agent}, and the Sign-off approver was defaulted to ` +
    "the LLM provider's OWN model, whose id goaly cannot resolve — so it CANNOT confirm the two are " +
    `different models. If that provider default is ${agent}, the two keys share one model. Pass ` +
    '--approver-model <a model you know differs> (or --approver-models) to make the second key verifiable.'
  );
}

/**
 * Follow-on H: in `--generate --autonomous` the model self-authors its bar AND self-judges it. When
 * the coding agent, the judge rung, AND the Sign-off approver all collapse onto ONE model, that is
 * the self-author + self-judge deadlock gpt-oss hit (a compiling 484-LOC server that `completed`
 * with no diff against its own judge rung): the model can author a bar it then cannot satisfy and
 * cannot recognize as satisfied, so it stalls. Escalated ABOVE the plain advisories — it is the most
 * deadlock-prone setup, and the two-key guarantee (invariant #3) is only nominal here.
 *
 * It escalates on an UNVERIFIED pair too, in its own wording: "goaly cannot rule this out" is the
 * honest claim there, and staying silent about the most deadlock-prone wiring because the check was
 * unmakeable is the failure mode this whole third state exists to remove. Returns `undefined` when
 * either pair is established independent.
 */
function selfJudgeEscalation(
  resolved: ResolvedModels,
  judgeApprover: Independence,
  workerApprover: Independence,
): string | undefined {
  if (judgeApprover === 'independent' || workerApprover === 'independent') return undefined;
  if (judgeApprover === 'collapsed' && workerApprover === 'collapsed') {
    return (
      `SELF-JUDGE RISK (--generate --autonomous): the coding agent, the LLM judge rung, AND the ` +
      `Sign-off approver all resolve to the same model (${label(resolved.approver)}) — the model ` +
      'self-authors its bar and self-judges it with no human in the loop, the most deadlock-prone ' +
      'setup (it can stall on a bar it cannot satisfy or recognize as satisfied). Strongly consider ' +
      '--approver-model (and/or --judge-model) on a DIFFERENT model/provider so the second key is a ' +
      'genuinely independent skeptic.'
    );
  }
  return (
    `SELF-JUDGE RISK, UNVERIFIED (--generate --autonomous): the coding agent and the LLM judge rung ` +
    `run on ${label(resolved.approverIndependentFrom)}, and the Sign-off approver was defaulted to ` +
    "the LLM provider's OWN model, whose id goaly cannot resolve — so it CANNOT rule out that all " +
    'three are one model, the self-author + self-judge deadlock, with no human in the loop. Pass ' +
    '--approver-model on a model you know differs (or --approver-models) to make it verifiable.'
  );
}

/**
 * Compute the model-independence warnings for a resolved wiring. Pure and order-stable so it is
 * unit-testable without building the whole driver.
 */
export function independenceWarnings(
  resolved: ResolvedModels,
  harness: HarnessChoice,
  llmProvider: LlmProviderChoice,
  context: IndependenceContext = {},
): string[] {
  const warnings: string[] = [];

  const { judgeApprover: judgeApproverCollapse, workerApprover: workerApproverCollapse } = collapses(
    resolved,
    harness,
    llmProvider,
    context,
  );

  if (context.generate === true && context.autonomous === true) {
    const escalation = selfJudgeEscalation(resolved, judgeApproverCollapse, workerApproverCollapse);
    if (escalation !== undefined) warnings.push(escalation);
  }

  // The judge rung and the approver always run on the same llm-provider, so they share one model
  // whenever their resolved models match — the second key then inherits the first key's blind spots.
  if (judgeApproverCollapse === 'collapsed') {
    warnings.push(
      `the LLM judge rung and the Sign-off approver run on the same model (${label(resolved.approver)}); ` +
        'pass --approver-model to keep the two keys independent',
    );
  } else if (judgeApproverCollapse === 'unverified') {
    warnings.push(unverifiedWarning('the LLM judge rung', resolved));
  }

  // The worker and the approver collapse only when they are the same vendor family AND model — then
  // the agent grading the work is effectively the agent that wrote it.
  if (workerApproverCollapse === 'collapsed') {
    warnings.push(
      `the coding agent and the Sign-off approver share the same model (${label(resolved.approver)}); ` +
        'pass --approver-model (or a different --llm-provider) so the approver stays an independent skeptic',
    );
  } else if (workerApproverCollapse === 'unverified') {
    warnings.push(unverifiedWarning('the coding agent', resolved));
  }

  // A multi-vote approver panel (issue #84) on ONE model is variance reduction, not perspective
  // independence — it samples the SAME model N times, so it does not break either collapse above. Note
  // it only when the panel is actually multi-vote AND it shares a model with the judge or the worker
  // (a panel on a genuinely separate --approver-model already is the independent second key).
  const quorum = context.approverQuorum ?? 1;
  if (quorum > 1 && (judgeApproverCollapse === 'collapsed' || workerApproverCollapse === 'collapsed')) {
    warnings.push(
      `the Sign-off approver runs a ${quorum}-reviewer quorum on a SINGLE model ` +
        `(${label(resolved.approver)}) that it shares with the judge rung and/or the coding agent — ` +
        'that is VARIANCE REDUCTION, not perspective independence (the panel re-samples one model). ' +
        'For a genuinely independent second key, pair --approver-quorum with --approver-model on a ' +
        'DIFFERENT model/provider.',
    );
  }

  return warnings;
}
