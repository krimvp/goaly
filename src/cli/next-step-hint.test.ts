import { describe, it, expect } from 'vitest';
import { nextStepHint } from './run-cmd';
import { RunId } from '../domain/ids';
import type { RunOutcome } from '../domain/events';
import {
  CONTRACT_SOUND_MARKER,
  contractDefectiveReason,
  contractSoundReason,
  repeatFailureReason,
} from '../orchestrator/stuck';

/**
 * ROUND-6 REGRESSION (finding 3). `nextStepHint`'s ordered table was matched against the WHOLE
 * abort reason — which, for a repeat-failure or an adjudicated run, quotes up to 500 chars of
 * WORKER-authored verifier output (the repeated failure signature) and adjudicator text. A test
 * name or assertion message containing `no-diff`, `oscillation`, `TOOLS_MISSING`, … therefore
 * selected the hint, and the operator was pointed at a flag that provably cannot continue the run
 * (an adjudicated abort ends on a RECORDED event; no threshold un-terminates it).
 *
 * The fix is structural: goaly's own markers are emitted BEFORE any quoted external text, and the
 * hint table only ever sees that goaly-authored prefix.
 */
const aborted = (reason: string): RunOutcome => ({
  runId: RunId.parse('run-abc'),
  status: 'ABORTED',
  contractHash: null,
  iterations: 4,
  reason,
});

/** A worker-authored verifier signature crafted to hijack every generic row in the table. */
const HOSTILE_SIGNATURE =
  'FAIL src/x.test.ts > handles no-diff and oscillation without TOOLS_MISSING or SETUP_FAILED: ' +
  'expected CONTRACT_UNSOUND, got budget exceeded (reached maxIterations) — CONTRACT_UNEVALUABLE ' +
  'STUCK_HARNESS_CRASH STUCK_TIMEOUT_NO_DIFF';

describe('nextStepHint — worker-authored text can never select the hint', () => {
  it('keeps the --recontract hint on a CONTRACT_DEFECTIVE abort whose signature says "no-diff"', () => {
    const reason = contractDefectiveReason(
      ['tests/frozen.spec.ts'],
      'the assertion pins an impossible no-diff oscillation invariant',
      repeatFailureReason(3, HOSTILE_SIGNATURE),
    );
    const hint = nextStepHint(aborted(reason));
    expect(hint).toContain('--recontract');
    expect(hint).not.toContain('--stuck-no-diff');
    expect(hint).not.toContain('--stuck-oscillation');
  });

  it('keeps the --from-run hint on an adjudicated-SOUND abort with the same hostile signature', () => {
    const hint = nextStepHint(aborted(contractSoundReason(repeatFailureReason(3, HOSTILE_SIGNATURE))));
    expect(hint).toContain('--from-run');
    expect(hint).toContain('adjudicated SATISFIABLE');
    expect(hint).not.toContain('--stuck-no-diff');
    expect(hint).not.toContain('--stuck-repeat-threshold');
  });

  it('keeps the repeat-failure hint when the signature forges OTHER typed markers', () => {
    const hint = nextStepHint(aborted(repeatFailureReason(3, HOSTILE_SIGNATURE)));
    expect(hint).toContain('--stuck-repeat-threshold');
    expect(hint).not.toContain('--stuck-crash-threshold');
    expect(hint).not.toContain('--install-missing-tools');
  });

  it('still reads goaly-authored markers that sit before the quote (crash hint, unevaluable)', () => {
    expect(
      nextStepHint(
        aborted(
          'STUCK_HARNESS_CRASH: the coding-agent harness exited abnormally 3 times in a row — ' +
            'droid refused the action at its autonomy level. Last harness output: no-diff no-diff',
        ),
      ),
    ).toContain('--harness-autonomy');
    expect(
      nextStepHint(
        aborted('CONTRACT_UNEVALUABLE: the frozen verifier ladder … Last verifier output: no-diff'),
      ),
    ).toContain('--stuck-unevaluable-threshold');
  });

  it('still hints on the plain typed reasons that quote nothing', () => {
    expect(nextStepHint(aborted('no-diff: working tree unchanged after an iteration'))).toContain(
      '--stuck-no-diff',
    );
    expect(nextStepHint(aborted('oscillation: diff hash cycling with period 2'))).toContain(
      '--stuck-oscillation',
    );
  });

  it('reads a LEGACY sound abort, whose marker trailed the quoted signature', () => {
    // Logs written before the marker was moved ahead of the quote must still get a route that exists.
    const legacy = `${repeatFailureReason(3, 'FAIL x')} [${CONTRACT_SOUND_MARKER}] The frozen bar was re-adjudicated in-loop and found SATISFIABLE.`;
    const hint = nextStepHint(aborted(legacy));
    expect(hint).toContain('--from-run');
    expect(hint).not.toContain('--stuck-repeat-threshold');
  });
});
