import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { initial, step } from './step';
import * as stuck from './stuck';
import * as reasonQuote from './reason-quote';
import { PreparedOutcome } from '../domain/events';
import { goalyAuthoredReason, hintSubject } from '../cli/reason-text';
import { bestOfFloor } from '../driver/best-of-driver';
import type { DriverDeps } from '../driver/driver';
import { makeCtx, makeConfig, makeFakeContract, makeFakePlan, dh } from '../testing/fakes';
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

  it('quotes a mid-run phase COMPILE_FAILED behind a lead-in, keeping the phase in the prefix', () => {
    const [s0] = initial(makeConfig({ phased: true, maxCompileRetries: 0 }));
    const [s1] = step(s0, { tag: 'PLAN_COMPILED', plan });
    const [compiling] = step(s1, { tag: 'PLAN_SEAL_DECIDED', decision: { kind: 'approve' } });
    const [failed] = step(compiling, { tag: 'COMPILE_FAILED', reason: POISON });
    expect(failed.tag).toBe('FAILED');
    const reason = failed.tag === 'FAILED' ? (failed.reason ?? '') : '';
    expectQuoted(reason);
    // The sealed sub-goal title is frozen pre-loop, so it stays inside goaly's own words.
    expect(goalyAuthoredReason(reason)).toContain('phase 1/2');
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

  /** Identifiers goaly itself generates — safe to interpolate into the authored prefix. */
  const GOALY_OWNED_HOLES = ['runId'];

  /** A reason expression is guarded when it is a covered builder call, or interpolates only ours. */
  function guarded(expr: string): boolean {
    // `floor` is `bestOfFloor`'s return: a closed set of static, goaly-authored sentences that
    // interpolate nothing at all — pinned by the two `bestOfFloor` cases below.
    if (expr === 'floor') return true;
    const call = /^([A-Za-z]+Reason)\(/.exec(expr);
    if (call !== null) return Object.keys(builders).includes(call[1]!);
    return [...expr.matchAll(/\$\{([^}]*)\}/g)].every((m) =>
      GOALY_OWNED_HOLES.includes((m[1] ?? '').trim()),
    );
  }

  /**
   * SCOPE, honestly: this walks `driver.ts`, the only module that authors a terminal `RunOutcome`
   * of its own (`outcome.ts` just forwards the reducer's `state.reason`). The other driver modules
   * DO interpolate exception text — a `wave-runner` unmerged-phase reason, a `tournament` candidate
   * reason, an approver-error veto — but none of those is a terminal run reason: an unmerged phase
   * re-runs sequentially and a veto is a per-iteration record, so neither reaches the hint table.
   * If one ever does, it needs a lead-in and a row here.
   */
  it('every driver-authored ABORTED reason is built behind a lead-in', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../driver/driver.ts', import.meta.url)),
      'utf8',
    );
    const declared = [...source.matchAll(/status: 'ABORTED',\n\s*reason: (.+),\n/g)].map(
      (m) => m[1]!,
    );
    // Every ABORTED outcome literal must have been matched — a differently shaped one fails here
    // rather than escaping the check.
    expect(declared.length).toBe([...source.matchAll(/status: 'ABORTED',/g)].length);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((expr) => !guarded(expr))).toEqual([]);
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
