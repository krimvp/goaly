import { DEFAULT_AGENT_TIMEOUT_MS } from '../../agent-cli/codec';
import { z } from 'zod';
import { UsageError, str, type RawFlags } from './tokens';

/**
 * Per-step subprocess kill-timeouts in milliseconds (pure wiring — never enters the contract).
 * Each is optional: when absent the step keeps its built-in default (harness/LLM = 10 min; the
 * verify command is otherwise unbounded). A field is present only when the user set it.
 */
export type StepTimeouts = {
  /** Wall-clock cap on the harness (coding-agent) subprocess. */
  harnessMs?: number;
  /**
   * Idle/heartbeat cap on the harness subprocess (issue #56): kill it only after this long with no
   * stream output, so a slow-but-progressing build turn survives while a genuine stall is reaped.
   * The wall-clock `harnessMs` remains the absolute backstop when both are set.
   */
  harnessIdleMs?: number;
  /** Wall-clock cap on each LLM step (judge / approver / compiler). */
  llmMs?: number;
  /** Wall-clock cap on the verify command (a timeout is a fail-closed non-zero exit). */
  verifyMs?: number;
  /** Wall-clock cap on the one-time setup command (Fix #1; a timeout is a fail-closed SETUP_FAILED). */
  setupMs?: number;
};

/**
 * Collect the per-step timeout flags and validate each at the seam: a positive integer number of
 * milliseconds, fail-closed on anything else. Absent flags are omitted so the step keeps its own
 * default (exactOptionalPropertyTypes: never assign `undefined`).
 */
export function parseTimeouts(flags: RawFlags): StepTimeouts {
  const ms = (flag: string): number | undefined => {
    const v = str(flags, flag);
    if (v === undefined) return undefined;
    const parsed = z.coerce.number().int().positive().safeParse(v);
    if (!parsed.success) {
      throw new UsageError(`--${flag}: expected a positive integer (milliseconds), got '${v}'`);
    }
    return parsed.data;
  };
  const harnessMs = ms('harness-timeout-ms');
  const harnessIdleMs = ms('harness-idle-timeout-ms');
  // The wall clock is the absolute backstop, so an idle cap at or above it can never fire — the
  // flag would be inert. Fail closed rather than let the user believe the heartbeat is armed.
  if (harnessIdleMs !== undefined && harnessIdleMs >= (harnessMs ?? DEFAULT_AGENT_TIMEOUT_MS)) {
    throw new UsageError(
      `--harness-idle-timeout-ms ${harnessIdleMs} is not below the wall-clock ` +
        `--harness-timeout-ms (${harnessMs ?? DEFAULT_AGENT_TIMEOUT_MS}), so it could never fire — ` +
        'lower it, or raise --harness-timeout-ms',
    );
  }
  const llmMs = ms('llm-timeout-ms');
  const verifyMs = ms('verify-timeout-ms');
  const setupMs = ms('setup-timeout-ms');
  return {
    ...(harnessMs !== undefined ? { harnessMs } : {}),
    ...(harnessIdleMs !== undefined ? { harnessIdleMs } : {}),
    ...(llmMs !== undefined ? { llmMs } : {}),
    ...(verifyMs !== undefined ? { verifyMs } : {}),
    ...(setupMs !== undefined ? { setupMs } : {}),
  };
}

/**
 * The hard upper bound on `--candidates` / `--best-of` (issue #85 OQ4). Each candidate is a full
 * CONCURRENT worker run in its own git worktree, so an unbounded K is a resource-exhaustion footgun —
 * a value above this is a fail-closed UsageError. `--budget-tokens` still governs total spend below it.
 */
export const MAX_CANDIDATES = 16;

/**
 * Resolve `--candidates N` (alias `--best-of N`) at the seam (issue #85): a positive integer best-of-N
 * candidate count CAPPED at {@link MAX_CANDIDATES}, fail-closed on anything else (invariant #6). The
 * two spellings are aliases; giving both is a conflict. Absent ⇒ undefined so the schema default (1)
 * applies.
 */
export function candidatesFlag(flags: RawFlags): string | undefined {
  const primary = str(flags, 'candidates');
  const alias = str(flags, 'best-of');
  if (primary !== undefined && alias !== undefined) {
    throw new UsageError('use one of --candidates / --best-of, not both');
  }
  const value = primary ?? alias;
  if (value === undefined) return undefined;
  const parsed = z.coerce.number().int().positive().max(MAX_CANDIDATES).safeParse(value);
  if (!parsed.success) {
    throw new UsageError(
      `--candidates: expected a positive integer ≤ ${MAX_CANDIDATES}, got '${value}'`,
    );
  }
  return value;
}

/**
 * Validate `--resume-best-of-incomplete <rerun|collapse>` at the seam (issue #85 follow-up): the
 * best-of-N resume policy, fail-closed on any other value (invariant #6). Absent ⇒ undefined so the
 * schema default (`'rerun'`, the historical behavior) applies.
 */
export function parseResumeBestOfIncomplete(flags: RawFlags): 'rerun' | 'collapse' | undefined {
  const v = str(flags, 'resume-best-of-incomplete');
  if (v === undefined) return undefined;
  const parsed = z.enum(['rerun', 'collapse']).safeParse(v);
  if (!parsed.success) {
    throw new UsageError(
      `--resume-best-of-incomplete: expected 'rerun' or 'collapse', got '${v}'`,
    );
  }
  return parsed.data;
}

/**
 * Validate `--max-agent-turns N` at the seam (follow-on E): a positive integer turn cap for the
 * goaly-code agent loop, fail-closed on anything else (invariant #6). Absent ⇒ undefined so the
 * harness keeps its built-in default (50).
 */
export function parseMaxAgentTurns(flags: RawFlags): number | undefined {
  const v = str(flags, 'max-agent-turns');
  if (v === undefined) return undefined;
  const parsed = z.coerce.number().int().positive().safeParse(v);
  if (!parsed.success) {
    throw new UsageError(`--max-agent-turns: expected a positive integer, got '${v}'`);
  }
  return parsed.data;
}
