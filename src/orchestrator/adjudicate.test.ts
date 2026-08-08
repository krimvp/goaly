import { describe, it, expect } from 'vitest';
import { decide } from './decide';
import { step } from './step';
import { CONTRACT_DEFECTIVE_MARKER } from './stuck';
import type { LoopCtx } from './state';
import type { OrchestratorEvent } from '../domain/events';
import { makeCtx, makeConfig, makeFakeContract, failVerdict, dh } from '../testing/fakes';

/**
 * Issue #116 — in-loop contract-fault adjudication. The reducer's whole share of the feature is
 * PURE: it decides WHETHER to spend one read-only adjudication call, emits the Command, and folds
 * the Driver's verdict into a relabelled ABORT. Every test here runs with zero IO.
 */

const SIGNATURE = 'AssertionError: expected "createDatabase" to be called at least once (verify/db.test.ts:12)';

const contract = makeFakeContract({
  goal: 'add a database bootstrap',
  generatedFiles: [{ path: 'verify/db.test.ts', sha256: 'a'.repeat(64) }],
});

/** A ctx sitting exactly on a repeat-failure streak whose signature names a frozen authored file. */
function repeatCtx(overrides: Partial<LoopCtx> = {}): LoopCtx {
  const config = overrides.config ?? makeConfig();
  const threshold = config.stuckPolicy.repeatFailureThreshold;
  return makeCtx({
    config,
    contract,
    iteration: threshold,
    verifierDetailHistory: Array.from({ length: threshold }, () => SIGNATURE),
    verifierEvaluableHistory: Array.from({ length: threshold }, () => true),
    // Two DISTINCT tree hashes ⇒ the worker demonstrably populated the tree at least once.
    diffHashHistory: dh('aaa1', 'bbb2', 'bbb2'),
    ...overrides,
  });
}

describe('DECIDE — the pure contract-fault gate (issue #116)', () => {
  it('a repeat streak naming a frozen generatedFiles path adjudicates instead of aborting', () => {
    const d = decide(repeatCtx(), failVerdict(SIGNATURE), null);
    expect(d.kind).toBe('ADJUDICATE');
    if (d.kind !== 'ADJUDICATE') return;
    expect(d.signature).toBe(SIGNATURE);
    expect(d.repeatCount).toBe(makeConfig().stuckPolicy.repeatFailureThreshold);
    // The fallback is TODAY's abort text, computed at trip time and carried through the round trip.
    expect(d.fallbackReason).toContain('STUCK_REPEATED_FAILURE');
  });

  it('matches on the BASENAME too — runners frequently print only the file name', () => {
    const ctx = repeatCtx({
      verifierDetailHistory: Array.from({ length: 3 }, () => 'FAIL db.test.ts::wants createDatabase'),
    });
    expect(decide(ctx, failVerdict(), null).kind).toBe('ADJUDICATE');
  });

  it.each([
    [
      'a non-repeat stuck kind (no-diff) — only the repeat signal is trustworthy',
      (): LoopCtx =>
        repeatCtx({ verifierDetailHistory: ['one', 'two'], lastNoDiff: true, iteration: 1 }),
    ],
    [
      'no authored generatedFiles — there is no frozen bar to blame',
      (): LoopCtx => repeatCtx({ contract: makeFakeContract({ generatedFiles: [] }) }),
    ],
    [
      'a signature naming a path that is NOT in the frozen set',
      (): LoopCtx =>
        repeatCtx({ verifierDetailHistory: Array.from({ length: 3 }, () => 'FAIL src/other.ts:1') }),
    ],
    [
      'the run already spent its one adjudication',
      (): LoopCtx => repeatCtx({ adjudicated: true }),
    ],
    [
      'a constant diff-hash history — the worker never populated the tree',
      (): LoopCtx => repeatCtx({ diffHashHistory: dh('aaa1', 'aaa1', 'aaa1') }),
    ],
  ])('falls through to today\'s ABORTED when %s', (_label, build) => {
    const d = decide(build(), failVerdict(SIGNATURE), null);
    expect(d.kind).toBe('ABORTED');
  });

  it('a spent auto-remediation retry still WINS over adjudication (cheaper, and it may green)', () => {
    const config = makeConfig({ stuckPolicy: { autoRemediate: true } });
    const d = decide(repeatCtx({ config }), failVerdict(SIGNATURE), null);
    expect(d.kind).toBe('CONTINUE');
  });
});

// ---- the ADJUDICATING transition ------------------------------------------

/** Drive a ctx through DECIDE + `step` into the ADJUDICATING state, returning its command. */
function enterAdjudicating(ctx: LoopCtx = repeatCtx()) {
  const [state, commands] = step({ tag: 'VERIFYING', ctx }, { tag: 'VERIFIED', verdict: failVerdict(SIGNATURE) });
  return { state, commands };
}

describe('ADJUDICATING — exactly one read-only command, then a relabelled abort', () => {
  it('emits EXACTLY ONE ADJUDICATE_CONTRACT and banks the once-per-run ledger', () => {
    const { state, commands } = enterAdjudicating();
    expect(state.tag).toBe('ADJUDICATING');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({
      tag: 'ADJUDICATE_CONTRACT',
      signature: SIGNATURE,
      repeatCount: 3,
    });
    if (state.tag === 'ADJUDICATING') expect(state.ctx.adjudicated).toBe(true);
  });

  it('defective:false reproduces TODAY\'s repeat-failure abort BYTE-IDENTICALLY', () => {
    // The control: the same ctx with the feature structurally unavailable (no authored files) takes
    // the pre-#116 path straight to ABORTED. Its reason must equal the adjudicated passthrough.
    const control = decide(
      repeatCtx({ contract: makeFakeContract({ generatedFiles: [] }) }),
      failVerdict(SIGNATURE),
      null,
    );
    expect(control.kind).toBe('ABORTED');

    const { state } = enterAdjudicating();
    const [terminal] = step(state, {
      tag: 'CONTRACT_ADJUDICATED',
      defective: false,
      reason: 'the assertion is satisfiable; the implementation is incomplete',
    });
    expect(terminal.tag).toBe('ABORTED');
    if (terminal.tag !== 'ABORTED' || control.kind !== 'ABORTED') return;
    expect(terminal.reason).toBe(control.reason);
    expect(terminal.reason).not.toContain(CONTRACT_DEFECTIVE_MARKER);
    expect(terminal.iterations).toBe(3);
    expect(terminal.contractHash).toBe(contract.contractHash);
  });

  it('defective:true relabels the abort as CONTRACT_DEFECTIVE, naming the frozen file', () => {
    const { state } = enterAdjudicating();
    const [terminal] = step(state, {
      tag: 'CONTRACT_ADJUDICATED',
      defective: true,
      reason: 'no implementation can satisfy this assertion: createDatabase is never reachable',
      pattern: 'asserts on a call that the goal never requires',
    });
    expect(terminal.tag).toBe('ABORTED');
    if (terminal.tag !== 'ABORTED') return;
    expect(terminal.reason.startsWith(`${CONTRACT_DEFECTIVE_MARKER}:`)).toBe(true);
    expect(terminal.reason).toContain('verify/db.test.ts');
    expect(terminal.reason).toContain('createDatabase is never reachable');
    // The operator must be told the tree is worth keeping — that is the whole point of the relabel.
    expect(terminal.reason).toMatch(/implementation may (well )?be correct/i);
    // The original repeat-failure text is still carried as context.
    expect(terminal.reason).toContain('STUCK_REPEATED_FAILURE');
  });

  it('can NEVER reach DONE — every adjudicated verdict lands on ABORTED', () => {
    for (const defective of [true, false]) {
      const { state } = enterAdjudicating();
      const [terminal] = step(state, { tag: 'CONTRACT_ADJUDICATED', defective, reason: 'r' });
      expect(terminal.tag).toBe('ABORTED');
    }
  });

  it('rejects any other event in ADJUDICATING (fail-closed transition table)', () => {
    const { state } = enterAdjudicating();
    const bogus: OrchestratorEvent = { tag: 'VERIFIED', verdict: failVerdict('x') };
    expect(() => step(state, bogus)).toThrow(/invalid transition/);
  });

  it('is BOUNDED once per run — a second repeat trip aborts with no second command', () => {
    const spent = repeatCtx({ adjudicated: true });
    const [state, commands] = step(
      { tag: 'VERIFYING', ctx: spent },
      { tag: 'VERIFIED', verdict: failVerdict(SIGNATURE) },
    );
    expect(state.tag).toBe('ABORTED');
    expect(commands).toHaveLength(0);
  });
});
