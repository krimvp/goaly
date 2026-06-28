import { describe, it, expect } from 'vitest';
import { lastRealSessionId, isSentinelSession, SENTINEL_SESSION_IDS } from './session-id';
import type { RunLogEntry } from './runlog';
import { RunId, DiffHash, SessionId } from '../domain/ids';
import type { OrchestratorEvent } from '../domain/events';

let seq = 0;
function entry(event: OrchestratorEvent): RunLogEntry {
  seq += 1;
  return { runId: RunId.parse('run-x'), seq, ts: 1000 + seq, contractHash: null, event, stateTagAfter: 'x' };
}

function agentRan(session: string, status: 'completed' | 'crashed' = 'completed'): RunLogEntry {
  return entry({
    tag: 'AGENT_RAN',
    run: { output: '', sessionId: SessionId.parse(session), status },
    prevDiffHash: DiffHash.parse('0000000'),
    diffHash: DiffHash.parse('0000001'),
    budget: { exceeded: false },
  });
}

describe('isSentinelSession', () => {
  it('flags every synthesized sentinel and nothing else', () => {
    for (const s of SENTINEL_SESSION_IDS) expect(isSentinelSession(s)).toBe(true);
    expect(isSentinelSession('claude-real-abc123')).toBe(false);
    expect(isSentinelSession('s1')).toBe(false);
  });
});

describe('lastRealSessionId', () => {
  it('returns the last AGENT_RAN session id when it is real', () => {
    const entries = [agentRan('sess-1'), agentRan('sess-2')];
    expect(lastRealSessionId(entries)).toBe('sess-2');
  });

  it('walks backwards past a trailing sentinel to the last real id', () => {
    // A clean turn, then a workspace-error iteration that synthesized a sentinel id.
    const entries = [agentRan('real-session'), agentRan('workspace-error', 'crashed')];
    expect(lastRealSessionId(entries)).toBe('real-session');
  });

  it('returns undefined when every turn is a sentinel', () => {
    const entries = [agentRan('noop-session'), agentRan('claude-unknown', 'crashed')];
    expect(lastRealSessionId(entries)).toBeUndefined();
  });

  it('returns undefined when there are no agent runs at all', () => {
    const entries = [entry({ tag: 'COMPILE_FAILED', reason: 'boom' })];
    expect(lastRealSessionId(entries)).toBeUndefined();
  });
});
