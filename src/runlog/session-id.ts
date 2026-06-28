import type { SessionId } from '../domain/ids';
import type { RunLogEntry } from './runlog';

/**
 * The synthesized SENTINEL session ids the adapters/driver mint when no REAL id could be recovered
 * from the agent CLI. They are valid `SessionId`s on the wire (so the event still parses) but mean
 * "no resumable session" — threading one into `claude --resume <id>` / a goaly-code session reload
 * would point at nothing. The follow-up resume-hint (Capability A) and session inheritance
 * (Capability C) must skip them and recover the last id that actually came back from the CLI.
 *
 * Kept in ONE place so the codec sentinels (`<name>-unknown`), the NoopHarness sentinel
 * (`noop-session`), the workspace-error sentinel (`workspace-error`), and the generic coerce
 * fallback (`unknown-session`) can never drift from this skip-list.
 */
export const SENTINEL_SESSION_IDS: ReadonlySet<string> = new Set([
  'unknown-session', // coerceSessionId default fallback
  'noop-session', // NoopHarness
  'workspace-error', // driver: a workspace (diffHash) failure synthesizes a crashed run
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
 * Walk the `AGENT_RAN` entries BACKWARDS to the last REAL session id — the most recent agent turn
 * whose returned id is not a synthesized sentinel. Returns undefined when no real id was ever
 * recovered (e.g. a run that crashed before any clean turn, or the fake harness). Pure projection
 * over the already-parsed event stream; no re-running.
 */
export function lastRealSessionId(entries: readonly RunLogEntry[]): SessionId | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.event.tag === 'AGENT_RAN' && !isSentinelSession(e.event.run.sessionId)) {
      return e.event.run.sessionId;
    }
  }
  return undefined;
}
