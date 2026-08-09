import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { initial, step } from './step';
import * as stuck from './stuck';
import { PreparedOutcome } from '../domain/events';
import { goalyAuthoredReason } from '../cli/reason-text';
import { makeCtx, makeConfig, makeFakeContract, dh } from '../testing/fakes';
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
