import type { SessionId } from '../domain/ids';
import type { RunLogEntry } from './runlog';

// The sentinel skip-list lives in the id DOMAIN (src/domain/ids.ts) so the harness core can refuse
// sentinels at the resume seam without importing persistence; re-exported here for its consumers.
export { SENTINEL_SESSION_IDS, isSentinelSession } from '../domain/ids';
import { isSentinelSession } from '../domain/ids';

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
