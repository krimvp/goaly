/**
 * The argv tokenizer and its primitive accessors — the leaf layer every flag-group parser
 * builds on (Phase 3.1 of the improvement plan). `UsageError` lives here (not in `args.ts`)
 * so the group parsers, the config loader, and the input-source resolver can all throw it
 * without importing the coordinator — no import cycles.
 */

/** The flag overlay a run's argv (or a config file) resolves to: kebab-case name → value. */
export type RawFlags = Record<string, string | boolean>;

/** Tokenized argv for a `run`: the `--flag` overlay plus any bare positionals (the goal). */
type ParsedTokens = { flags: RawFlags; positionals: string[] };

/** Single-dash short flags, mapped to their canonical long (boolean) name. */
const SHORT_FLAGS: Record<string, string> = { d: 'defaults' };

/**
 * Long flags that never take a value (pure booleans). A bare `--flag` is `true` and the NEXT token
 * is left for a positional — without this set the value heuristic below would wrongly swallow the
 * goal in `goaly --generate "my goal"`. (Tri-state toggles like `--stuck-no-diff` deliberately stay
 * out: they may take an explicit true/false; put the goal first to keep them unambiguous.)
 */
const VALUELESS_FLAGS = new Set([
  'generate',
  'no-setup',
  'autonomous',
  'phased',
  'adversarial',
  'delta-verify',
  'no-log-file',
  'stream',
  'explain',
  'stream-transcript',
  'defaults',
  'inherit-session',
  'dry-run',
]);

/**
 * `--defaults` / `-d` is hands-off sugar for `--autonomous`: the other easy-mode defaults
 * (generate, the claude harness, the LLM provider following the harness) already apply with no
 * flag, so the only thing it adds is auto-accepting the (still-frozen, still-logged) contract at Seal.
 */
function canonicalFlag(name: string): string {
  return name === 'defaults' ? 'autonomous' : name;
}

/**
 * Tokenize a `run`'s argv into a flag overlay plus positionals. A token that doesn't start with `-`
 * is a positional (the goal); `--flag`/`--flag=value`/`-d` are flags. Fails closed on an unknown
 * single-dash flag (invariant #6) rather than silently treating it as a value or positional.
 */
export function parseFlags(tokens: string[]): ParsedTokens {
  const flags: RawFlags = {};
  const positionals: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (!tok.startsWith('-')) {
      positionals.push(tok);
      continue;
    }
    if (!tok.startsWith('--')) {
      const long = SHORT_FLAGS[tok.slice(1)];
      if (long === undefined) throw new UsageError(`unknown flag: ${tok}`);
      flags[canonicalFlag(long)] = true; // every registered short flag is a valueless boolean
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      flags[canonicalFlag(body.slice(0, eq))] = body.slice(eq + 1);
      continue;
    }
    if (VALUELESS_FLAGS.has(body)) {
      flags[canonicalFlag(body)] = true;
      continue;
    }
    const next = tokens[i + 1];
    // A lone `-` (the stdin sentinel for --goal/--intent/--rubric) is a value, not a flag, so the
    // value-consumption check stays at `--` to keep `--goal -` working.
    if (next === undefined || next.startsWith('--')) {
      flags[canonicalFlag(body)] = true; // boolean flag
    } else {
      flags[canonicalFlag(body)] = next;
      i++;
    }
  }
  return { flags, positionals };
}

export class UsageError extends Error {}

export function str(flags: RawFlags, key: string): string | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  if (typeof v === 'boolean') throw new UsageError(`--${key} expects a value`);
  return v;
}

/**
 * Parse a tri-state boolean flag (issue #54): a bare `--flag` ⇒ true, `--flag true|1|yes` ⇒ true,
 * `--flag false|0|no` ⇒ false. Returns undefined when absent so the schema default applies; fails
 * closed (invariant #6) on any other value. Used for the stuck-policy toggles, which must be
 * DISABLE-able (so a plain coerced boolean — where any non-empty string is truthy — won't do).
 */
export function boolFlag(flags: RawFlags, key: string): boolean | undefined {
  const v = flags[key];
  if (v === undefined) return undefined;
  // A bare CLI flag is `true`; a config-file JSON boolean may be either literal.
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  throw new UsageError(`--${key}: expected true or false, got '${String(v)}'`);
}
