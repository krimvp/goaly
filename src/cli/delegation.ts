/**
 * Natural-language parallel delegation: let the user tell goaly to parallelize in plain language —
 * in the goal ("fix the flaky test, work with 4 subagents") or in a `--resume` note ("try 4
 * parallel attempts") — and map it onto the EXISTING best-of-N tournament (`--candidates`, issue
 * #85). Nothing new runs: N independent worker attempts per iteration in isolated worktrees, scored
 * against the same frozen ladder, best tree wins; the reducer never learns N existed.
 *
 * Detection is DETERMINISTIC — a small directive grammar, never an LLM parse (an LLM interpreting
 * config would be exactly the "LLM in control flow" this codebase exists to avoid). The grammar is
 * deliberately narrow to keep false positives out of real goals:
 *
 *  - `<verb> N subagents` — "use 4 subagents", "work with 3 sub-agents", "delegate to 2 subagents".
 *    A delegation VERB is required ("document the 3 subagents" is a goal about subagents, not a
 *    directive) and only unambiguous agent nouns participate — never "workers"/"threads"/"jobs",
 *    which routinely describe the application domain ("a queue with 4 parallel workers").
 *  - `<verb> subagents` (uncounted) — "use subagents", "spawn subagents" ⇒ a documented default
 *    of {@link DEFAULT_DELEGATION_CANDIDATES}.
 *  - `N parallel attempts|candidates|tries` — "make 3 parallel attempts". The word "parallel" must
 *    be ADJACENT to the noun ("5 parallel login attempts" does not match).
 *
 * The matched clause is STRIPPED from the text: the goal is frozen into the contract and read by
 * the judge/approver, and a leftover "use 4 subagents" would become an unverifiable success
 * criterion. The caller logs the interpretation loudly (phrase → candidates) so the rewrite is
 * always auditable. Anything the grammar does not match is left untouched — fail-closed to the
 * classic single attempt, never a guess. The explicit `--candidates` flag always wins.
 */

/** Candidate count when the directive names no number ("use subagents"). */
export const DEFAULT_DELEGATION_CANDIDATES = 3;

export type DelegationDirective = {
  /** The parsed candidate count (uncapped here — the CLI seam enforces MAX_CANDIDATES). */
  readonly candidates: number;
  /** The exact matched directive text (for the loud interpretation log). */
  readonly phrase: string;
  /** The input with the directive clause removed and punctuation/whitespace tidied. */
  readonly cleaned: string;
};

/** Delegation verbs that must introduce a subagent directive (counted or bare). */
const VERB = String.raw`(?:us(?:e|ing)|spawn(?:ing)?|launch(?:ing)?|run(?:ning)?|try(?:ing)?|delegate\s+to|work(?:ing)?\s+with|with|across)`;

/** Optional lead-in words a directive clause often carries ("please and then …"). */
const LEAD_IN = String.raw`(?:please\s+)?(?:and\s+)?(?:then\s+)?(?:in\s+parallel\s+)?`;

/** The unambiguous agent noun. Deliberately NOT workers/threads/jobs (application-domain words). */
const SUBAGENTS = String.raw`sub-?agents?`;

/**
 * The three directive shapes, tried in order; the FIRST match wins and only it is stripped.
 * Each pattern consumes its leading separator run (comma/semicolon/dash) so the strip is clean.
 */
const PATTERNS: readonly { re: RegExp; count: (m: RegExpMatchArray) => number }[] = [
  // "<verb> N subagents" — counted, verb required.
  {
    re: new RegExp(
      String.raw`[\s,;:–—-]*\b${LEAD_IN}${VERB}\s+(\d+)\s+(?:parallel\s+|concurrent\s+)?${SUBAGENTS}\b`,
      'i',
    ),
    count: (m) => Number(m[1]),
  },
  // "N parallel attempts|candidates|tries" — "parallel" adjacent to the noun disambiguates.
  {
    re: new RegExp(
      String.raw`[\s,;:–—-]*\b${LEAD_IN}(?:${VERB}\s+|make\s+|making\s+)?(\d+)\s+parallel\s+(?:attempts?|candidates?|tries)\b`,
      'i',
    ),
    count: (m) => Number(m[1]),
  },
  // "<verb> subagents" — uncounted, verb required, documented default count.
  {
    re: new RegExp(
      String.raw`[\s,;:–—-]*\b${LEAD_IN}${VERB}\s+(?:multiple\s+|several\s+|some\s+|a\s+few\s+|parallel\s+|concurrent\s+)?${SUBAGENTS}\b`,
      'i',
    ),
    count: () => DEFAULT_DELEGATION_CANDIDATES,
  },
];

/**
 * Parse (and strip) a natural-language delegation directive. Returns `null` when the text carries
 * none — the classic single-attempt run. Pure and deterministic; the caller owns validation
 * (candidate cap) and the loud interpretation log.
 */
export function parseDelegationDirective(text: string): DelegationDirective | null {
  for (const { re, count } of PATTERNS) {
    const m = text.match(re);
    if (m === null || m.index === undefined) continue;
    const candidates = count(m);
    if (!Number.isInteger(candidates) || candidates < 1) continue;
    const cleaned = tidy(text.slice(0, m.index), text.slice(m.index + m[0].length));
    // The match consumes its leading separator run for a clean strip — drop it from the reported
    // phrase so the log reads "work with 3 subagents", not ", work with 3 subagents".
    return { candidates, phrase: m[0].replace(/^[\s,;:–—-]+/, ''), cleaned };
  }
  return null;
}

/**
 * Re-join the text around a stripped clause and tidy the seam: collapse doubled whitespace, drop a
 * connector or punctuation run left dangling at the join ("use 4 subagents to fix X" → "fix X";
 * "fix X, use 4 subagents." → "fix X."), and never leave a space before closing punctuation.
 */
function tidy(before: string, after: string): string {
  let rest = after.replace(/^\s*(?:(?:to|and|then)\s+|[,;:\s]+)*/i, '');
  // A directive that ended the sentence leaves its terminator on `after` — keep exactly one.
  if (/^[.!?]/.test(after.trimStart()) && rest.length === 0) rest = after.trimStart().charAt(0);
  const joined = before.trimEnd().length > 0 ? `${before.trimEnd()} ${rest}` : rest;
  return joined
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
