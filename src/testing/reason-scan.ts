/**
 * STRUCTURAL ENFORCEMENT of the abort-reason trust boundary (`src/orchestrator/reason-quote.ts`).
 *
 * A terminal reason is split into "goaly's own words" (the prefix, which the CLI's next-step hint
 * reads) and "quoted evidence" (everything from the earliest registered lead-in on). Keeping that
 * split true is a property of the CODE that builds reasons, so it is checked by reading the source
 * of every module that authors a terminal reason and classifying each reason expression.
 *
 * The classification is a WHITELIST: an expression is accepted only when it can be positively shown
 * to be safe (a covered builder call, a literal/template whose every interpolation is goaly-owned or
 * sits immediately behind a registered lead-in, or an expression explicitly delegated with a written
 * justification). Anything it cannot classify — a bare identifier, an unknown helper call, a member
 * expression — is REJECTED. A default-accept check (e.g. "every `${}` hole is ours", which
 * `Array.every` answers `true` for an expression with no holes at all) passes any shape that simply
 * hides its interpolation one line up, which is exactly how this boundary rotted before.
 *
 * Lives in `src/testing/` because it is test-support: nothing in the shipped loop imports it.
 */

/** What a reason expression is allowed to be, per module. */
export type ReasonPolicy = {
  /**
   * Functions whose output is separately poison-tested (every exported `*Reason` builder). A call to
   * one of these is accepted WITHOUT looking at its arguments — quoting them is the builder's job,
   * and the builder's own test proves it.
   */
  readonly builders: readonly string[];
  /**
   * Calls that WRAP another reason (today only `phaseReason`). The wrapped reason — the call's last
   * argument — is classified recursively; the wrapper itself must have its own test pinning that
   * whatever it adds cannot reach the goaly-authored prefix.
   */
  readonly wrappers: readonly string[];
  /** Interpolations goaly itself generates (ids, config numbers) — safe inside the authored prefix. */
  readonly goalyOwnedHoles: readonly string[];
  /**
   * Registered lead-ins, as BOTH the constant names a template may interpolate
   * (`${TOOLS_DETAIL_QUOTE}`) and their literal values, so "external text sits immediately behind a
   * lead-in" can be checked on the template text.
   */
  readonly leadIns: readonly string[];
  /** Expressions accepted verbatim, each mapped to the justification for accepting it. */
  readonly delegated: Readonly<Record<string, string>>;
};

export type Classification = { readonly ok: boolean; readonly why: string };

const accept = (why: string): Classification => ({ ok: true, why });
const reject = (why: string): Classification => ({ ok: false, why });

/**
 * The reason expressions at every site matching `siteRe` (e.g. `status: 'ABORTED',`). The named
 * property is looked for in the SAME object literal as the site (at its top level, so a nested
 * object cannot answer for it). A terminal outcome that carries no such property yields a sentinel
 * expression no policy can classify, so it fails loudly instead of escaping the scan.
 */
export function reasonExprsAfter(source: string, siteRe: RegExp, key = 'reason'): readonly string[] {
  const out: string[] = [];
  for (const m of source.matchAll(siteRe)) {
    const rest = source.slice((m.index ?? 0) + m[0].length);
    const at = propertyIndex(rest.slice(0, objectEnd(rest)), key);
    if (at < 0) {
      out.push(`<<no ${key} in the object at ${m[0].trim()}>>`);
      continue;
    }
    out.push(balancedExpr(rest.slice(at + key.length + 2)));
  }
  return out;
}

/** How far the object literal the site sits in extends (its own closing brace). */
function objectEnd(rest: string): number {
  let depth = 0;
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(rest, i);
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    }
    i += 1;
  }
  return rest.length;
}

/** Where `key: ` appears at the TOP level of `region`, or -1. */
function propertyIndex(region: string, key: string): number {
  let depth = 0;
  let i = 0;
  while (i < region.length) {
    const ch = region[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(region, i);
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (depth === 0 && region.startsWith(`${key}: `, i) && !/[\w$.]/.test(region[i - 1] ?? ','))
      return i;
    i += 1;
  }
  return -1;
}

/** The expressions in `exprs` the policy cannot positively classify, each with the reason why. */
export function unclassifiedReasons(
  exprs: readonly string[],
  policy: ReasonPolicy,
): readonly string[] {
  return exprs
    .map((expr) => ({ expr, verdict: classifyReasonExpr(expr, policy) }))
    .filter(({ verdict }) => !verdict.ok)
    .map(({ expr, verdict }) => `${expr} — ${verdict.why}`);
}

/** Positively classify one reason expression, or reject it. */
export function classifyReasonExpr(expr: string, policy: ReasonPolicy): Classification {
  const e = expr.replace(/\s+/g, ' ').trim();
  const justification = policy.delegated[e];
  if (justification !== undefined) return accept(`delegated (${justification})`);
  const call = wholeCall(e);
  if (call !== null) {
    if (policy.wrappers.includes(call.name)) {
      const inner = classifyReasonExpr(lastArgument(call.args), policy);
      return inner.ok ? accept(`${call.name}(…) wrapping ${inner.why}`) : inner;
    }
    if (policy.builders.includes(call.name)) return accept(`covered builder ${call.name}(…)`);
    return reject(`unrecognised call ${call.name}(…) — cover it as a builder or quote its argument`);
  }
  const branches = ternaryBranches(e);
  if (branches !== null) {
    const verdicts = branches.map((b) => classifyReasonExpr(b, policy));
    const bad = verdicts.find((v) => !v.ok);
    return bad ?? accept('ternary of classified branches');
  }
  return classifyLiteral(e, policy);
}

/** A literal / template / `+`-concatenation of them, with every interpolation accounted for. */
function classifyLiteral(expr: string, policy: ReasonPolicy): Classification {
  const parts = concatenatedLiterals(expr);
  if (parts === null) return reject('not a covered builder call nor a string literal');
  for (const part of parts) {
    if (!part.startsWith('`')) continue;
    const bad = unguardedHole(part, policy);
    if (bad !== null) return reject(`interpolates \${${bad}} with no lead-in in front of it`);
  }
  return accept('literal text with only goaly-owned or lead-in-guarded interpolations');
}

/** The first interpolation in a template literal that is neither ours nor immediately quoted. */
function unguardedHole(template: string, policy: ReasonPolicy): string | null {
  const segments = templateSegments(template);
  for (const [i, hole] of segments.holes.entries()) {
    if (policy.goalyOwnedHoles.includes(hole) || policy.leadIns.includes(hole)) continue;
    const before = segments.texts[i] ?? '';
    const previous = i > 0 ? (segments.holes[i - 1] ?? '') : '';
    const behindLeadInHole = before.trim().length === 0 && policy.leadIns.includes(previous);
    const behindLeadInText = policy.leadIns.some((leadIn) => before.endsWith(leadIn));
    if (!behindLeadInHole && !behindLeadInText) return hole;
  }
  return null;
}

/** Split a template literal into its literal texts and its `${…}` hole expressions. */
function templateSegments(template: string): { texts: string[]; holes: string[] } {
  const texts: string[] = [];
  const holes: string[] = [];
  let text = '';
  let i = 1; // past the opening backtick
  while (i < template.length - 1) {
    if (template[i] === '\\') {
      text += template.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (template[i] === '$' && template[i + 1] === '{') {
      const end = skipHole(template, i + 2);
      holes.push(template.slice(i + 2, end - 1).trim());
      texts.push(text);
      text = '';
      i = end;
      continue;
    }
    text += template[i];
    i += 1;
  }
  return { texts, holes };
}

/** `expr` as a list of string/template literals joined by `+`, or null when it is anything else. */
function concatenatedLiterals(expr: string): readonly string[] | null {
  const parts: string[] = [];
  let i = 0;
  while (i < expr.length) {
    while (expr[i] === ' ') i += 1;
    const quote = expr[i];
    if (quote !== "'" && quote !== '"' && quote !== '`') return null;
    const end = skipString(expr, i);
    parts.push(expr.slice(i, end));
    i = end;
    while (expr[i] === ' ') i += 1;
    if (i >= expr.length) return parts;
    if (expr[i] !== '+') return null;
    i += 1;
  }
  return parts.length > 0 ? parts : null;
}

/** The whole expression as a single call `name(args)`, or null. */
function wholeCall(expr: string): { name: string; args: string } | null {
  const m = /^([A-Za-z_$][\w$]*)\(/.exec(expr);
  if (m === null) return null;
  const open = m[0].length - 1;
  const close = matchingParen(expr, open);
  if (close !== expr.length - 1) return null;
  return { name: m[1]!, args: expr.slice(open + 1, close) };
}

/** The last top-level argument of an argument list (a trailing comma is not an argument). */
function lastArgument(args: string): string {
  const parts = splitTopLevel(args, ',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? '';
}

/** `[whenTrue, whenFalse]` for a top-level ternary, or null. */
function ternaryBranches(expr: string): readonly string[] | null {
  const question = topLevelIndex(expr, '?', (i) => expr[i + 1] !== '?' && expr[i - 1] !== '?');
  if (question < 0) return null;
  const rest = expr.slice(question + 1);
  const colon = topLevelIndex(rest, ':', () => true);
  if (colon < 0) return null;
  return [rest.slice(0, colon).trim(), rest.slice(colon + 1).trim()];
}

function topLevelIndex(expr: string, char: string, ok: (i: number) => boolean): number {
  let depth = 0;
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(expr, i);
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === char && depth === 0 && ok(i)) return i;
    i += 1;
  }
  return -1;
}

function splitTopLevel(text: string, separator: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let at = topLevelIndex(text.slice(start), separator, () => true);
  while (at >= 0) {
    parts.push(text.slice(start, start + at));
    start += at + 1;
    at = topLevelIndex(text.slice(start), separator, () => true);
  }
  parts.push(text.slice(start));
  return parts;
}

/** The expression starting at `text[0]`, up to the top-level `,` or closing bracket that ends it. */
function balancedExpr(text: string): string {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (ch === ',' && depth === 0) break;
    i += 1;
  }
  return text.slice(0, i).trim();
}

/** Index just past the string/template literal that starts at `start`. */
function skipString(text: string, start: number): number {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      i = skipHole(text, i + 2);
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** Index just past the `}` closing a `${` hole that starts at `start`. */
function skipHole(text: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(text, i);
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}
