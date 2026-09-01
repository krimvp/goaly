/**
 * Reject a `--flag` that is not in the documented contract. `.goalyrc` already fails closed on an
 * unknown key; the command line was the one seam where a typo (`--budget-token`) was silently
 * dropped — and, because an unknown flag also swallows the next token as its value, could eat the
 * goal. Invariant #6: nothing reaches the run unparsed.
 */
import type { RawFlags } from './tokens';
import { UsageError } from './tokens';
import { documentedFlagNames } from '../help';

export function rejectUnknownFlags(cliFlags: RawFlags): void {
  const known = new Set(documentedFlagNames());
  const unknown = Object.keys(cliFlags).filter((k) => !known.has(k));
  if (unknown.length === 0) return;
  throw new UsageError(
    `unknown flag${unknown.length > 1 ? 's' : ''}: ${unknown.map((k) => `--${k}`).join(', ')} — ` +
      `check the spelling; 'goaly help all' lists every flag`,
  );
}
