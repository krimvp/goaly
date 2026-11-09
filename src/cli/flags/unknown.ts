/**
 * Reject a `--flag` that is not in the documented contract. `.goalyrc` already fails closed on an
 * unknown key; the command line was the one seam where a typo (`--budget-token`) was silently
 * dropped — and, because an unknown flag also swallows the next token as its value, could eat the
 * goal. Invariant #6: nothing reaches the run unparsed.
 */
import type { RawFlags } from './tokens';
import { UsageError } from './tokens';
import { documentedFlagNames } from '../help';

/** `scope` narrows the check to one subcommand's flags; without it, every run flag is known. */
export function rejectUnknownFlags(
  cliFlags: RawFlags,
  scope?: { readonly command: string; readonly known: readonly string[] },
): void {
  const known = scope?.known ?? documentedFlagNames();
  const unknown = Object.keys(cliFlags).filter((k) => !known.includes(k));
  if (unknown.length === 0) return;
  const hint = closestName(unknown[0]!, known);
  throw new UsageError(
    `unknown flag${unknown.length > 1 ? 's' : ''}: ${unknown.map((k) => `--${k}`).join(', ')}` +
      (hint !== undefined ? ` — did you mean --${hint}?` : '') +
      (scope !== undefined
        ? ` — goaly ${scope.command} accepts ${known.map((k) => `--${k}`).join(', ') || 'no flags'}`
        : ` — check the spelling; 'goaly help all' lists every flag`),
  );
}

/**
 * The name nearest to `word` (camelCase read as kebab-case), or `undefined` when none is close.
 * Short names allow one edit, longer names two, so a real one-word goal is rarely taken for a typo.
 */
export function closestName(word: string, names: readonly string[]): string | undefined {
  const w = word.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  let best: { name: string; d: number } | undefined;
  for (const name of names) {
    const d = editDistance(w, name);
    if (d > (name.length <= 4 ? 1 : 2)) continue;
    if (best === undefined || d < best.d || (d === best.d && name.length === w.length)) {
      best = { name, d };
    }
  }
  return best?.name;
}

/** Edit distance where swapping two neighbour letters (`gaol`) counts as one edit. */
function editDistance(a: string, b: string): number {
  let before: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j]!, before[j - 2]! + 1);
      }
    }
    before = prev;
    prev = row;
  }
  return prev[b.length]!;
}
