import type { Logger } from '../log/logger';
import { mostDegraded, sameDegradedMode, type DegradedMode } from '../domain/degraded';
import type { RunLog, RunLogHeader } from '../runlog/runlog';

/**
 * Keep the run header's typed DEGRADED-MODE label (issue #125) truthful across `--resume`.
 *
 * The label is compose-time state written ONCE into a fresh run's header — but the models a run
 * actually uses are re-resolved from EVERY invocation's flags. A resume with different (or absent)
 * `--model` / `--approver-model` flags therefore silently changes which keys run, while the header
 * — the only artifact `goaly runs show`, the UI header feed and every downstream consumer read —
 * kept saying what the FIRST invocation resolved. Both directions were observed: a run recorded
 * INDEPENDENCE-UNVERIFIED whose resume ran fully self-judged, and a run with NO label whose resume
 * collapsed agent = judge = approver onto the tool default and recorded nothing at all.
 *
 * So the header is upgraded to the more severe of the two labels ({@link mostDegraded}: a repaired
 * wiring never erases iterations that already ran degraded), and ANY difference is WARNed — the
 * resumed invocation's key wiring is not the one the run started with, whichever way it moved.
 * Rewriting the header preserves every other field, so the run-start config/baseline/provenance are
 * untouched. Purely a label: it gates nothing and never reaches the reducer.
 */
export async function reconcileDegraded(
  runlog: RunLog,
  header: RunLogHeader | null,
  current: DegradedMode | undefined,
  log: Logger,
): Promise<void> {
  if (header === null) return;
  if (sameDegradedMode(header.degraded, current)) return;
  const effective = mostDegraded(header.degraded, current);
  log.warn(
    'resume: this invocation’s key wiring differs from the one the run started with — the run ' +
      'header records the more degraded of the two, so a collapse is never left off the record',
    {
      recorded: header.degraded?.kind ?? 'none',
      thisInvocation: current?.kind ?? 'none',
      effective: effective?.kind ?? 'none',
    },
  );
  if (sameDegradedMode(header.degraded, effective)) return;
  const { degraded: _drop, ...rest } = header;
  await runlog.writeHeader({
    ...rest,
    ...(effective !== undefined ? { degraded: effective } : {}),
  });
}
