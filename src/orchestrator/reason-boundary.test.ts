import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { initial, step } from './step';
import { decide } from './decide';
import * as stuck from './stuck';
import * as reasonQuote from './reason-quote';
import { PreparedOutcome, type RunOutcome } from '../domain/events';
import { RunId } from '../domain/ids';
import { goalyAuthoredReason, hintSubject } from '../cli/reason-text';
import { nextStepHint } from '../cli/run-cmd';
import { bestOfFloor } from '../driver/best-of-driver';
import type { DriverDeps } from '../driver/driver';
import { makeCtx, makeConfig, makeFakeContract, makeFakePlan, dh } from '../testing/fakes';
import {
  classifyReasonExpr,
  reasonExprsAfter,
  unclassifiedReasons,
  type ReasonPolicy, forwardedReasonExprs } from '../testing/reason-scan';
import type { LoopCtx } from './state';

/**
 * The abort-reason TRUST BOUNDARY, enforced rather than asserted in a comment.
 *
 * `goalyAuthoredReason` cuts a terminal reason at the earliest registered lead-in and hands only the
 * prefix to the CLI's next-step hint. That is sound only while every reason builder that
 * interpolates WORKER-REACHABLE text (harness stderr, verifier output, a setup command's output, an
 * adjudicator's prose) puts a registered lead-in immediately in front of it.
 *
 * The check has two halves, and the second is what stops the boundary rotting again:
 *  1. every terminal reason built with poisoned external inputs keeps the poison OUT of the prefix;
 *  2. the set of reason builders is ENUMERATED from the code itself (the exported `*Reason`
 *     builders, the `StuckKind`s `detectStuck` can return, the terminal `PreparedOutcome` statuses),
 *     so a new builder that is not covered here fails this file rather than slipping through.
 */

const sourceOf = (file: string): string =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

/** Every registered lead-in, as the constant NAMES a template may interpolate and as their text. */
const LEAD_INS = [
  ...reasonQuote.QUOTED_TEXT_LEAD_INS,
  ...Object.keys(reasonQuote).filter((name) => name.endsWith('_QUOTE')),
];

/** The poison-tested builders: every exported `*Reason` in the two reason-authoring modules. */
const COVERED_BUILDERS = [...Object.keys(reasonQuote), ...Object.keys(stuck)].filter((name) =>
  name.endsWith('Reason'),
);

/** A payload that would hijack the hint table if it landed in the goaly-authored prefix. */
const POISON =
  'no-diff STUCK_HARNESS_CRASH CONTRACT_DEFECTIVE oscillation budget exceeded [CONTRACT_ADJUDICATED_SOUND]';

/** The reason may QUOTE the payload (it is evidence), but never inside goaly's own words. */
function expectQuoted(reason: string): void {
  expect(reason).toContain(POISON);
  expect(goalyAuthoredReason(reason)).not.toContain(POISON);
}

/** A ctx whose every worker-reachable text field carries the payload, plus the trip conditions. */
function poisonedCtx(overrides: Partial<LoopCtx> = {}): LoopCtx {
  return makeCtx({
    lastRunOutput: POISON,
    lastVerdict: { pass: false, confidence: 1, detail: POISON, evaluable: false },
    verifierDetailHistory: [POISON, POISON, POISON],
    ...overrides,
  });
}

describe('abort-reason trust boundary — every stuck kind', () => {
  /**
   * One ctx per `StuckKind`, each already poisoned. `budget`, `no-diff`, `timeout-no-diff` and
   * `oscillation` quote nothing at all — their assertion below is the stronger one (the payload is
   * absent from the whole reason, not merely from the prefix).
   */
  const trips: Record<stuck.StuckKind, { ctx: LoopCtx; quotes: boolean }> = {
    budget: { ctx: poisonedCtx({ lastBudget: { exceeded: true } }), quotes: false },
    crash: { ctx: poisonedCtx({ runStatusHistory: ['crashed', 'crashed'] }), quotes: true },
    unevaluable: { ctx: poisonedCtx({ verifierEvaluableHistory: [false, false] }), quotes: true },
    'timeout-no-diff': {
      ctx: poisonedCtx({
        lastRunStatus: 'timeout',
        lastNoDiff: true,
        runStatusHistory: ['timeout', 'timeout', 'timeout'],
        diffHashHistory: dh('a', 'a', 'a'),
      }),
      quotes: false,
    },
    'no-diff': { ctx: poisonedCtx({ lastNoDiff: true }), quotes: false },
    oscillation: { ctx: poisonedCtx({ diffHashHistory: dh('a', 'b', 'a', 'b') }), quotes: false },
    repeat: { ctx: poisonedCtx(), quotes: true },
  };

  for (const [kind, { ctx, quotes }] of Object.entries(trips)) {
    it(`keeps external text out of the goaly-authored prefix (${kind})`, () => {
      const reason = stuck.detectStuck(ctx);
      expect(reason?.kind).toBe(kind);
      const message = reason?.message ?? '';
      if (quotes) expectQuoted(message);
      else expect(message).not.toContain(POISON);
    });
  }

  it('covers every StuckKind the reducer can emit', () => {
    // Enumerated from the source so a NEW detector kind must be added to the table above.
    const source = readFileSync(fileURLToPath(new URL('stuck.ts', import.meta.url)), 'utf8');
    const declared = new Set(
      [...source.matchAll(/kind: '([a-z-]+)'/g)].map((m) => m[1] as stuck.StuckKind),
    );
    expect([...declared].sort()).toEqual(Object.keys(trips).sort());
  });
});

describe('abort-reason trust boundary — the exported reason builders', () => {
  /**
   * Each exported builder, called with the payload in every WORKER-REACHABLE argument. Arguments
   * that are not worker-reachable are noted per case: `contractDefectiveReason`'s `paths` come from
   * the FROZEN contract's authored file list (compiled and sealed before the loop began — the worker
   * cannot change them mid-run), so they are deliberately allowed in the goaly-authored prefix.
   */
  const builders: Record<string, () => string> = {
    repeatFailureReason: () => stuck.repeatFailureReason(3, POISON),
    contractSoundReason: () => stuck.contractSoundReason(POISON),
    contractDefectiveReason: () => stuck.contractDefectiveReason(['verify/x.test.ts'], POISON, POISON),
  };

  for (const [name, build] of Object.entries(builders)) {
    it(`quotes its external arguments behind a lead-in (${name})`, () => {
      expectQuoted(build());
    });
  }

  it('covers every exported reason builder', () => {
    const exported = Object.keys(stuck)
      .filter((name) => name.endsWith('Reason'))
      .sort();
    expect(exported).toEqual(Object.keys(builders).sort());
  });
});

describe('abort-reason trust boundary — the prepare-phase terminals', () => {
  const contract = makeFakeContract({ setup: 'npm ci' });

  function preparing(): ReturnType<typeof step>[0] {
    const [s1] = step(initial(makeConfig())[0], { tag: 'CONTRACT_COMPILED', contract });
    return step(s1, { tag: 'SEAL_DECIDED', decision: { kind: 'approve' } })[0];
  }

  /** Every terminal prepare outcome, read off the schema so a new one cannot skip this file. */
  const terminals = PreparedOutcome.options
    .map((option) => option.shape.status.value)
    .filter((status) => status !== 'proceed');

  it('has terminal outcomes to check', () => {
    expect(terminals.length).toBeGreaterThan(0);
  });

  for (const status of terminals) {
    it(`quotes the prepare-phase detail behind a lead-in (${status})`, () => {
      const [s] = step(preparing(), {
        tag: 'WORKSPACE_PREPARED',
        prepared: { status, detail: POISON },
        setupRan: true,
      });
      expect(s.tag).toBe('FAILED');
      expectQuoted(s.tag === 'FAILED' ? (s.reason ?? '') : '');
    });
  }
});

describe('abort-reason trust boundary — the DELEGATED authoring failures', () => {
  /**
   * `COMPILE_FAILED` / `PLAN_FAILED` carry a message goaly did not write (the compiler/planner LLM's
   * prose, or a thrown error's text). Under `--phased` that text is NOT pre-loop: phase N+1's
   * contract is compiled AFTER phase N's worker turns (`startPhaseCompile` → `COMPILE_VERIFIER`),
   * over the tree the worker just wrote. So it needs a lead-in like any other quoted evidence.
   */
  const plan = makeFakePlan({ phases: [{ goal: 'phase one' }, { goal: 'phase two' }] });

  it('quotes a COMPILE_FAILED message behind a lead-in (unphased)', () => {
    const [s] = step(initial(makeConfig({ maxCompileRetries: 0 }))[0], {
      tag: 'COMPILE_FAILED',
      reason: POISON,
    });
    expect(s.tag).toBe('FAILED');
    expectQuoted(s.tag === 'FAILED' ? (s.reason ?? '') : '');
  });

  it('quotes a mid-run phase COMPILE_FAILED behind a lead-in, marker ahead of the phase', () => {
    const [s0] = initial(makeConfig({ phased: true, maxCompileRetries: 0 }));
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    const [compiling] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } });
    const [failed] = step(compiling, { tag: 'COMPILE_FAILED', reason: POISON });
    expect(failed.tag).toBe('FAILED');
    const reason = failed.tag === 'FAILED' ? (failed.reason ?? '') : '';
    expectQuoted(reason);
    // The phase context still names the phase, but AFTER the marker and behind its own lead-in:
    // the sub-goal title is plan-authored prose, so it is quoted, not claimed.
    expect(goalyAuthoredReason(reason)).toContain(reasonQuote.COMPILE_FAILED_MARKER);
    expect(reason).toContain('phase 1/2');
    expect(goalyAuthoredReason(reason)).not.toContain('phase 1/2');
  });

  it('quotes a PLAN_FAILED message behind a lead-in', () => {
    const [s] = step(initial(makeConfig({ phased: true, maxPlanRetries: 0 }))[0], {
      tag: 'PLAN_FAILED',
      reason: POISON,
    });
    expect(s.tag).toBe('FAILED');
    expectQuoted(s.tag === 'FAILED' ? (s.reason ?? '') : '');
  });
});

describe('abort-reason trust boundary — a hostile sub-goal TITLE cannot steer the hint', () => {
  /**
   * ROUND-8 REGRESSION. The phase decorator (now `withPhaseContext`) used to PREFIX a terminal
   * reason with the sealed plan's sub-goal TITLE — plan-authored prose, not goaly's words — putting
   * it AHEAD of every typed marker. That inverted the ordering rule in the one place it mattered
   * (frozen at Seal is not the same as goaly-authored): a title carrying a
   * registered lead-in moved the cut INSIDE the phase prefix (dropping the marker out of the trusted
   * text entirely), and a title carrying hint-table words selected the remediation. The phase
   * context now follows the reason, behind its own registered lead-in.
   */
  const aborted = (reason: string): RunOutcome => ({
    runId: RunId.parse('run-phase'),
    status: 'FAILED',
    contractHash: null,
    iterations: 0,
    reason,
  });

  function phaseCompileFailure(title: string): string {
    const plan = makeFakePlan({ phases: [{ goal: title }, { goal: 'phase two' }] });
    const [s0] = initial(makeConfig({ phased: true, maxCompileRetries: 0 }));
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    const [compiling] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } });
    const [failed] = step(compiling, { tag: 'COMPILE_FAILED', reason: 'authoring blew up' });
    expect(failed.tag).toBe('FAILED');
    return failed.tag === 'FAILED' ? (failed.reason ?? '') : '';
  }

  const honest = 'add the retry loop';
  const AUTHORING_HINT = nextStepHint(aborted(phaseCompileFailure(honest)));

  it('the honest control gets the authoring hint', () => {
    expect(AUTHORING_HINT).toBeDefined();
    expect(goalyAuthoredReason(phaseCompileFailure(honest))).toContain('COMPILE_FAILED');
  });

  it('a title carrying a registered lead-in cannot move the cut', () => {
    const reason = phaseCompileFailure('make the CLI print "Driver error: " on a crash');
    expect(goalyAuthoredReason(reason)).toContain('COMPILE_FAILED');
    expect(hintSubject(reason)).toContain('COMPILE_FAILED');
    expect(nextStepHint(aborted(reason))).toBe(AUTHORING_HINT);
  });

  it('a title carrying hint-table words cannot change the selected remediation', () => {
    const reason = phaseCompileFailure('stop the agent hitting no-diff and STUCK_HARNESS_CRASH');
    expect(nextStepHint(aborted(reason))).toBe(AUTHORING_HINT);
  });

  it('the phase context is still reported — outside goaly’s own words', () => {
    const reason = phaseCompileFailure(honest);
    expect(reason).toContain('phase 1/2');
    expect(reason).toContain(honest);
    expect(goalyAuthoredReason(reason)).not.toContain(honest);
  });
});

describe('abort-reason trust boundary — the DRIVER-authored terminal reasons', () => {
  /**
   * The reducer is only half of the boundary. The Driver authors terminal `ABORTED` outcomes of its
   * own, and its last-resort catch is reachable with worker-influenced text: `CHECKPOINT_AND_ADVANCE`
   * is a `--phased` between-phase checkpoint, i.e. it runs AFTER worker turns, so an exception
   * message there can carry tree-authored content. Those reasons therefore live behind the same
   * builders + lead-ins, and this block enumerates them from the code so a new one cannot skip it.
   */
  const builders: Record<string, () => string> = {
    bootstrapFailedReason: () => reasonQuote.bootstrapFailedReason(POISON),
    driverErrorReason: () => reasonQuote.driverErrorReason(POISON),
    compileFailedReason: () => reasonQuote.compileFailedReason(POISON),
    planFailedReason: () => reasonQuote.planFailedReason(POISON),
  };

  for (const [name, build] of Object.entries(builders)) {
    it(`quotes its external argument behind a lead-in (${name})`, () => {
      expectQuoted(build());
    });
  }

  it('covers every reason builder the shared reason-quote module exports', () => {
    const exported = Object.keys(reasonQuote)
      .filter((name) => name.endsWith('Reason'))
      .sort();
    expect(exported).toEqual(Object.keys(builders).sort());
  });

  /**
   * What a driver-authored reason expression is allowed to BE. A whitelist: anything this cannot
   * positively classify is rejected, so a shape nobody anticipated fails the check instead of
   * passing it by default.
   */
  const DRIVER_POLICY: ReasonPolicy = {
    builders: Object.keys(builders),
    wrappers: [],
    // The run id goaly minted itself — not worker-reachable.
    goalyOwnedHoles: ['runId', 'run.runId'],
    leadIns: LEAD_INS,
    delegated: {
      floor:
        '`bestOfFloor`’s return: a closed set of static goaly-authored sentences that interpolate ' +
        'nothing at all — pinned structurally and behaviorally by the `bestOfFloor` cases below',
    },
  };

  /**
   * SCOPE, honestly: this walks `driver.ts`, the only module that authors a terminal `RunOutcome`
   * of its own (`outcome.ts` just forwards the reducer's `state.reason`, whose own authors are
   * walked by the REDUCER block below). The other driver modules DO interpolate exception text — a
   * `wave-runner` unmerged-phase reason, a `tournament` candidate reason, an approver-error veto —
   * but none of those is a terminal run reason: an unmerged phase re-runs sequentially and a veto is
   * a per-iteration record, so neither reaches the hint table. If one ever does, it needs a lead-in
   * and a row here.
   */
  it('every driver-authored ABORTED reason is built behind a lead-in', () => {
    const source = sourceOf('../driver/driver.ts');
    const sites = /status: 'ABORTED',/g;
    const declared = reasonExprsAfter(source, sites);
    // Every ABORTED outcome literal must have been matched — a differently shaped one yields a
    // sentinel expression that no policy classifies, so it fails here rather than escaping.
    expect(declared.length).toBe([...source.matchAll(sites)].length);
    expect(declared.length).toBeGreaterThan(0);
    // The literal lives in one helper (`abortedOutcome`) whose `reason` parameter is filled at its
    // call sites — follow the parameter to every argument that fills it, transitively through the
    // forwarding helpers, so each expression that can reach the outcome is classified.
    const filled = declared.flatMap((expr) =>
      expr === 'reason' ? forwardedReasonExprs(source, 'abortedOutcome') : [expr],
    );
    expect(filled.length).toBeGreaterThan(declared.length);
    expect(unclassifiedReasons(filled, DRIVER_POLICY)).toEqual([]);
  });

  it('the best-of-N start floor interpolates nothing at all (why `floor` is delegated)', () => {
    // The one bare identifier the policy accepts, so its justification is checked structurally too,
    // not just by the two behavioral cases below: the builder holds no `${…}` hole to fill.
    const body =
      /export async function bestOfFloor[\s\S]*?\n}\n/.exec(sourceOf('../driver/best-of-driver.ts'))?.[0] ?? '';
    expect(body).toContain('requires a worktree host');
    expect(body).not.toContain('${');
  });

  it('the best-of-N start floor quotes nothing (no host is configured)', async () => {
    const reason = await bestOfFloor({} as unknown as DriverDeps);
    expect(reason).not.toBeNull();
    expect(reason ?? '').not.toContain(POISON);
  });

  it('a marker-carrying reason is never handed to the legacy CONTRACT_ADJUDICATED_SOUND rescue', () => {
    // The rescue exists for legacy repeat-failure logs; these reasons carry a typed marker of their
    // own, so a compiler message echoing goaly's bracketed marker cannot re-point their hint.
    const reason = reasonQuote.compileFailedReason(POISON);
    expect(reason).toContain('[CONTRACT_ADJUDICATED_SOUND]'); // the poison really does try it
    expect(hintSubject(reason)).toBe(goalyAuthoredReason(reason));
    expect(hintSubject(reason)).not.toContain(stuck.CONTRACT_SOUND_MARKER);
  });

  it('the best-of-N start floor quotes nothing when the host throws', async () => {
    const deps = {
      worktrees: {
        headResolves: () => {
          throw new Error(POISON);
        },
      },
    } as unknown as DriverDeps;
    const reason = (await bestOfFloor(deps)) ?? '';
    expect(reason).not.toContain(POISON);
  });
});

describe('abort-reason trust boundary — the REDUCER-authored terminal reasons', () => {
  /**
   * ROUND-8 REGRESSION (the seam's other implementation). The structural enumeration above walks
   * `driver.ts` only; the reducer's OWN terminal reasons — `decide.ts`'s FAILED/ABORTED decisions and
   * `step.ts`'s terminal outcomes — were covered only by proxy (a builder is poison-tested, so a
   * reason that HAPPENS to call it is safe). Nothing checked the reasons `step.ts`/`decide.ts` build
   * INLINE, so splicing raw harness output into the maxIterations reason passed the whole suite.
   * Both halves of the seam are now walked with the same positive-classification rule.
   */
  const stepPolicy: ReasonPolicy = {
    builders: COVERED_BUILDERS,
    // `withPhaseContext` only APPENDS the phase context, behind its own lead-in — pinned by the
    // hostile sub-goal title cases above — so what matters is the reason it wraps.
    wrappers: ['withPhaseContext'],
    goalyOwnedHoles: ['config.maxPlanRevisions', 'config.maxSealRevisions'],
    leadIns: LEAD_INS,
    delegated: {
      'event.decision.reason':
        'a HUMAN’s Seal / plan-Seal rejection text — the one reason goaly passes through whole',
      'decision.reason': 'DECIDE’s own reason, enumerated from decide.ts by the case below',
    },
  };

  const decidePolicy: ReasonPolicy = {
    builders: ['abortReason'],
    wrappers: [],
    goalyOwnedHoles: ['ctx.config.maxIterations'],
    leadIns: LEAD_INS,
    delegated: {},
  };

  it('every terminal reason step.ts builds is positively classified', () => {
    const source = sourceOf('step.ts');
    const sites = /tag: '(?:FAILED|ABORTED)',/g;
    const exprs = reasonExprsAfter(source, sites);
    expect(exprs.length).toBe([...source.matchAll(sites)].length);
    expect(exprs.length).toBeGreaterThan(0);
    expect(unclassifiedReasons(exprs, stepPolicy)).toEqual([]);
  });

  it('every terminal reason decide.ts builds is positively classified', () => {
    const source = sourceOf('decide.ts');
    const sites = /kind: '(?:FAILED|ABORTED)',/g;
    const exprs = [
      ...reasonExprsAfter(source, sites),
      // The adjudication passthrough: this expression BECOMES a terminal ABORTED reason in
      // `stepAdjudicating` when the contract is judged sound, so it is a terminal reason too.
      ...reasonExprsAfter(source, /kind: 'ADJUDICATE',/g, 'fallbackReason'),
    ];
    const adjudicationSites = [...source.matchAll(/kind: 'ADJUDICATE',/g)].length;
    expect(exprs.length).toBe([...source.matchAll(sites)].length + adjudicationSites);
    expect(adjudicationSites).toBeGreaterThan(0);
    expect(unclassifiedReasons(exprs, decidePolicy)).toEqual([]);
  });

  it('every reason-building helper the reducer keeps to itself is covered', () => {
    // Local `*Reason` helpers are not exported, so the "covers every exported builder" cases above
    // cannot see them. Each must be either a wrapper with its own cases, or a builder in the policy
    // — a NEW private helper fails here rather than being classified by accident.
    const local = (file: string): readonly string[] =>
      [...sourceOf(file).matchAll(/^function ([A-Za-z]+Reason)\(/gm)].map((m) => m[1]!);
    // step.ts authors no terminal reason of its own: every one it emits comes from a covered
    // builder, from DECIDE, or from a human's Seal rejection.
    expect(local('step.ts')).toEqual([]);
    expect([...local('decide.ts')].sort()).toEqual([...decidePolicy.builders].sort());
    // The one WRAPPER the policy trusts is EXPORTED from the module that owns the ordering rule,
    // where its cases live — not a private decorator the scan would have to take on faith.
    expect(Object.keys(reasonQuote)).toEqual(expect.arrayContaining([...stepPolicy.wrappers]));
  });

  it('DECIDE’s abort reason quotes the stuck evidence behind a lead-in (abortReason)', () => {
    // The one private builder decide.ts owns: it composes the stuck message with a goaly-authored
    // remediation-spend suffix. Exercised through the public `decide`, so nothing is exported just
    // for the test.
    const ctx = poisonedCtx({ remediations: { total: 1, noDiff: 1, repeat: 0, crash: 0 } });
    const decision = decide(ctx, { pass: false, confidence: 1, detail: POISON }, null);
    expect(decision.kind).toBe('ABORTED');
    expectQuoted(decision.kind === 'ABORTED' ? decision.reason : '');
  });

  it('DECIDE’s maxIterations reason quotes nothing at all', () => {
    const ctx = makeCtx({ iteration: 99, lastRunOutput: POISON });
    const decision = decide(ctx, { pass: false, confidence: 1, detail: 'red' }, null);
    expect(decision.kind).toBe('FAILED');
    expect(decision.kind === 'FAILED' ? decision.reason : '').not.toContain(POISON);
  });
});

describe('abort-reason trust boundary — the shapes that must NOT pass the source check', () => {
  /**
   * ROUND-8 REGRESSION. The driver-half check classified a reason expression by asking "is every
   * `${}` hole goaly-owned?" — and `Array.every` over NO holes is `true`, so any expression that
   * hid its interpolation one line up, or behind a helper the naming convention missed, was accepted
   * by DEFAULT. The first three shapes below are the ones verified to reach a terminal reason with
   * worker-reachable text in goaly's own words while the check stayed green; every shape here must
   * now be REJECTED, because an unclassifiable expression has to fail loudly, never pass silently.
   */
  const policy: ReasonPolicy = {
    builders: COVERED_BUILDERS,
    wrappers: ['withPhaseContext'],
    goalyOwnedHoles: ['runId'],
    leadIns: LEAD_INS,
    delegated: { floor: 'the best-of-N start floor, as in the driver policy' },
  };

  const probes: Record<string, string> = {
    'a bare identifier built one line above': 'leaked',
    'an unknown helper call whose name is not *Reason':
      'describeBootstrapFailure(errorMessage(e))',
    'a helper call that merely LOOKS like a builder': 'describeFailureReason(errorMessage(e))',
    'an inline template interpolating worker-reachable text':
      '`the driver failed unexpectedly (fail-closed): ${errorMessage(e)}`',
    'raw harness output spliced into the maxIterations reason':
      '`reached maxIterations (${ctx.config.maxIterations}) without satisfying the contract; ' +
      'last harness output was ${ctx.lastRunOutput ?? \'\'}`',
    'a member expression carrying an adapter’s text': 'event.run.output',
    'a phase wrapper around an unclassifiable reason': 'withPhaseContext(ctx.phase, leaked)',
    'the sentinel a terminal outcome carrying no reason property produces':
      "<<no reason in the object at tag: 'ABORTED',>>",
  };

  for (const [shape, expr] of Object.entries(probes)) {
    it(`rejects ${shape}`, () => {
      expect(classifyReasonExpr(expr, policy).ok).toBe(false);
    });
  }

  it('still accepts the shapes the boundary really uses', () => {
    const accepted = [
      'driverErrorReason(errorMessage(e))',
      '`interrupted by user — resume this run with: --resume ${runId}`',
      "'manual plan editing is not supported at the plan Seal — use revise'",
      "'TOOLS_MISSING: a tool is missing. ' + `${TOOLS_DETAIL_QUOTE}${prepared.detail}`",
      'withPhaseContext(ctx.phase, contractSoundReason(fallbackReason))',
    ];
    expect(accepted.filter((expr) => !classifyReasonExpr(expr, policy).ok)).toEqual([]);
  });

  it('the scan reads a MULTI-LINE reason expression whole', () => {
    const source = [
      "      return [{",
      "        tag: 'ABORTED',",
      '        reason: withPhaseContext(',
      '          phase,',
      '          `Seal revision cap (${config.maxSealRevisions}) reached without approval`,',
      '        ),',
      '        iterations: 0,',
      '      }];',
    ].join('\n');
    const [expr] = reasonExprsAfter(source, /tag: 'ABORTED',/g);
    expect(expr).toContain('maxSealRevisions');
    expect(classifyReasonExpr(expr ?? '', policy).ok).toBe(false); // that hole is not in THIS policy
    expect(
      classifyReasonExpr(expr ?? '', { ...policy, goalyOwnedHoles: ['config.maxSealRevisions'] }).ok,
    ).toBe(true);
  });
});

describe('abort-reason trust boundary — the codec hint is a closed kind', () => {
  it('renders goaly-authored prose for a codec-recognised remediation', () => {
    const message =
      stuck.detectStuck(
        poisonedCtx({ runStatusHistory: ['crashed', 'crashed'], lastRunHint: 'autonomy-refused' }),
      )?.message ?? '';
    // The remediation the operator reads is authored HERE, so the CLI's autonomy hint keys off
    // goaly's own words — a codec supplies only the KIND, never the sentence.
    expect(message).toContain('autonomy level');
    expectQuoted(message);
  });

  it('falls back to the generic install/auth advice when no kind was recognised', () => {
    const message =
      stuck.detectStuck(poisonedCtx({ runStatusHistory: ['crashed', 'crashed'] }))?.message ?? '';
    expect(message).toContain('is installed, authenticated');
  });
});
