import { z } from 'zod';

/**
 * Branded, nominal identifiers. A bare `string` can never be passed where one of
 * these is expected — every value crosses a Zod `parse` at the system edge, so the
 * brand is real, not a comment.
 */

/**
 * Session id. Constrained to a safe-ascii allowlist that cannot begin with `-`, so a value
 * coming from untrusted harness stdout can never be parsed as a CLI flag when threaded back
 * into `claude --resume <id>` / `codex resume <id>` (defense-in-depth at the seam).
 */
export const SessionId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/, 'sessionId must be safe ascii not starting with "-"')
  .brand<'SessionId'>();
export type SessionId = z.infer<typeof SessionId>;

/**
 * Run id. Constrained to a safe path-component allowlist (no `/`, no leading `.`), because the
 * run id names the run-log directory — rejecting traversal sequences (`../`) at the Zod seam.
 */
export const RunId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'runId must be a safe path component')
  .brand<'RunId'>();
export type RunId = z.infer<typeof RunId>;

/** A content hash of the workspace tree (sha-style hex). Used for stuck-detection. */
export const DiffHash = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, 'diffHash must be 7-64 lowercase hex chars')
  .brand<'DiffHash'>();
export type DiffHash = z.infer<typeof DiffHash>;

/** A content hash of the canonicalized frozen contract. Must never change mid-run. */
export const ContractHash = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, 'contractHash must be 7-64 lowercase hex chars')
  .brand<'ContractHash'>();
export type ContractHash = z.infer<typeof ContractHash>;

/**
 * A content hash of the canonicalized frozen plan (issue #48). Like {@link ContractHash} but for the
 * decomposition plan: hashed + logged once, and no transition rewrites it — the plan-level freeze
 * that keeps "a frozen plan of frozen contracts" honest (re-planning can't silently make it easier).
 */
export const PlanHash = z
  .string()
  .regex(/^[0-9a-f]{7,64}$/, 'planHash must be 7-64 lowercase hex chars')
  .brand<'PlanHash'>();
export type PlanHash = z.infer<typeof PlanHash>;

/** Helpers for constructing branded ids from trusted internal sources. */
export const asSessionId = (s: string): SessionId => SessionId.parse(s);

/**
 * The synthesized SENTINEL session ids the adapters/driver mint when no REAL id could be recovered
 * from the agent CLI. They are valid {@link SessionId}s on the wire (so the event still parses) but
 * mean "no resumable session" — threading one into `claude --resume <id>` / a goaly-code session
 * reload would point at nothing (or, worse, at a DIFFERENT harness's sentinel: a run resumed under
 * a new `--harness` carries the OLD harness's sentinel, e.g. `claude --resume noop-session`, which
 * crashes every turn). Kept in ONE place — the id domain — so the codec sentinels
 * (`<name>-unknown`), the NoopHarness sentinel, the driver's error sentinels, and the generic
 * coerce fallback can never drift from this skip-list. The harness core, the follow-up resume-hint
 * (Capability A), and session inheritance (Capability C) must all skip them.
 */
export const SENTINEL_SESSION_IDS: ReadonlySet<string> = new Set([
  'unknown-session', // coerceSessionId default fallback
  'noop-session', // NoopHarness (the fake harness)
  'workspace-error', // driver: a workspace (diffHash) failure synthesizes a crashed run
  'best-of-error', // best-of-N driver/tournament: a fan-out error synthesizes a crashed run
  'claude-unknown',
  'codex-unknown',
  'droid-unknown',
  'pi-unknown',
  'goaly-code-unknown',
]);

/** Whether `id` is a synthesized sentinel rather than a real, resumable harness session id. */
export function isSentinelSession(id: string): boolean {
  return SENTINEL_SESSION_IDS.has(id);
}

/**
 * Coerce an untrusted candidate (parsed from harness stdout) into a valid SessionId, falling
 * back to a safe sentinel when it is absent or fails the allowlist — so an adapter never throws
 * on a hostile session id.
 */
export function coerceSessionId(candidate: string | undefined, fallback = 'unknown-session'): SessionId {
  if (candidate !== undefined && candidate.length > 0) {
    const parsed = SessionId.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return SessionId.parse(fallback);
}
export const asRunId = (s: string): RunId => RunId.parse(s);
export const asDiffHash = (s: string): DiffHash => DiffHash.parse(s);
export const asContractHash = (s: string): ContractHash => ContractHash.parse(s);
export const asPlanHash = (s: string): PlanHash => PlanHash.parse(s);
