import type { Logger } from '../log/logger';
import { mostDegraded, sameDegradedMode, type DegradedMode } from '../domain/degraded';
import type { ContractHash, RunId } from '../domain/ids';
import type { RunLog, RunLogHeader } from '../runlog/runlog';

/**
 * Keep the run's typed DEGRADED-MODE label (issue #125) truthful across `--resume`.
 *
 * The label is compose-time state written ONCE into a fresh run's header — but the models a run
 * actually uses are re-resolved from EVERY invocation's flags. A resume with different (or absent)
 * `--model` / `--approver-model` flags therefore silently changes which keys run, while the header
 * — which `goaly runs show`, the UI header feed and every downstream consumer read — kept saying
 * what the FIRST invocation resolved. Both directions were observed: a run recorded
 * INDEPENDENCE-UNVERIFIED whose resume ran fully self-judged, and a run with NO label whose resume
 * collapsed agent = judge = approver onto the tool default and recorded nothing at all.
 *
 * So the record is upgraded to the more severe of the two labels ({@link mostDegraded}: a repaired
 * wiring never erases iterations that already ran degraded), and ANY difference is WARNed — the
 * resumed invocation's key wiring is not the one the run started with, whichever way it moved.
 *
 * IT MOVES BY APPEND (invariant #7). The escalation is recorded as a Driver-side `DEGRADED_ESCALATED`
 * MARKER event — the RUN_EXTENDED pattern from ADR 0012 — and the effective label is derived on read
 * (`effectiveDegraded`: header ∨ every marker). It is emphatically NOT an in-place rewrite of
 * `header.json`: that is a truncate-then-refill with no tmp+rename, so a crash inside the window
 * would leave a run whose tree and event stream are both fine with an unreadable header —
 * unresumable, and invisible to `runs show`. Trading a whole run for a label is the wrong trade, and
 * an append is what the rest of this log already does. The header stays written exactly once.
 *
 * Purely a label either way: it gates nothing, never enters the frozen contract, and is never fed to
 * `step()` (replay skips the marker, invariant #1).
 */
export async function reconcileDegraded(
  runlog: RunLog,
  header: RunLogHeader | null,
  current: DegradedMode | undefined,
  log: Logger,
  resumed: {
    readonly runId: RunId;
    /** Entries already in the log — the marker is appended at `seq + 1`. */
    readonly seq: number;
    readonly contractHash: ContractHash | null;
    /** The state tag the resume fold reached; the marker never changes it. */
    readonly stateTag: string;
    readonly now: number;
  },
): Promise<number> {
  if (header === null) return 0;
  if (sameDegradedMode(header.degraded, current)) return 0;
  const effective = mostDegraded(header.degraded, current);
  log.warn(
    'resume: this invocation’s key wiring differs from the one the run started with — the run ' +
      'records the more degraded of the two, so a collapse is never left off the record',
    {
      recorded: header.degraded?.kind ?? 'none',
      thisInvocation: current?.kind ?? 'none',
      effective: effective?.kind ?? 'none',
    },
  );
  // The resumed wiring is no worse than what is already recorded — the warning stands, but there is
  // nothing new to record (and a downgrade must never be written).
  if (effective === undefined || sameDegradedMode(header.degraded, effective)) return 0;
  await runlog.append({
    runId: resumed.runId,
    seq: resumed.seq + 1,
    ts: resumed.now,
    contractHash: resumed.contractHash,
    event: { tag: 'DEGRADED_ESCALATED', degraded: effective },
    stateTagAfter: resumed.stateTag,
  });
  return 1;
}
