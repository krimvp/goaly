import { describe, it, expect } from 'vitest';
import { RunId, DiffHash, SessionId } from '../domain/ids';
import type { OrchestratorEvent } from '../domain/events';
import type { RunLogHeader, RunLogEntry } from '../runlog/runlog';
import { makeConfig, makeFakeContract, passVerdict, failVerdict, approve } from '../testing/fakes';
import { InMemorySessionStore } from '../goaly-code/session-store';
import type { ChatMessage } from '../llm-client/schema';
import { exportRunTrajectory, buildTrajectoryRecord, lastSessionId } from './trajectory';
import { runDetail } from '../runlog/inspect';

const contract = makeFakeContract({ goal: 'build the parser' });

let seq = 0;
function entry(event: OrchestratorEvent, ts = 1000 + seq): RunLogEntry {
  seq += 1;
  return { runId: RunId.parse('run-1'), seq, ts, contractHash: null, event, stateTagAfter: 'x' };
}
function agentRan(prev: string, post: string, tokens: number, session = 's1'): RunLogEntry {
  return entry({
    tag: 'AGENT_RAN',
    run: { output: '', sessionId: SessionId.parse(session), status: 'completed' },
    prevDiffHash: DiffHash.parse(prev),
    diffHash: DiffHash.parse(post),
    budget: { exceeded: false, tokensSpent: tokens },
  });
}

/** Two-iteration DONE run: iter1 fails the ladder, iter2 passes and is approved. */
function doneRun(): { header: RunLogHeader; entries: RunLogEntry[] } {
  seq = 0;
  return {
    header: { runId: RunId.parse('run-1'), startedAt: 1_700_000_000_000, config: makeConfig({ goal: 'build the parser' }) },
    entries: [
      entry({ tag: 'CONTRACT_COMPILED', contract }),
      entry({ tag: 'SEAL_DECIDED', decision: { kind: 'approve' } }),
      agentRan('0000000', '0000001', 10),
      entry({ tag: 'VERIFIED', verdict: failVerdict('red') }),
      agentRan('0000001', '0000002', 25),
      entry({ tag: 'VERIFIED', verdict: passVerdict('green') }),
      entry({ tag: 'SIGNOFF_DECIDED', approval: approve() }),
    ],
  };
}

const messages: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'build the parser' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
  { role: 'tool', content: 'wrote', tool_call_id: 'c1' },
];

describe('lastSessionId', () => {
  it('returns the session id of the last AGENT_RAN', () => {
    const { entries } = doneRun();
    expect(lastSessionId(entries)).toBe('s1');
  });
  it('returns undefined when no agent ran', () => {
    expect(
      lastSessionId([entry({ tag: 'SEAL_DECIDED', decision: { kind: 'reject', reason: 'no' } })]),
    ).toBeUndefined();
  });
});

describe('buildTrajectoryRecord', () => {
  it('labels a DONE run as passed and joins the per-iteration ladder/approver outcomes', () => {
    const { header, entries } = doneRun();
    const detail = runDetail(header, entries);
    const rec = buildTrajectoryRecord(detail, 's1', messages);
    expect(rec.passed).toBe(true);
    expect(rec.status).toBe('DONE');
    expect(rec.iterations).toBe(2);
    expect(rec.tokens).toBe(25);
    expect(rec.rungs).toEqual([{ kind: 'deterministic', label: 'true' }]);
    expect(rec.ladder).toHaveLength(2);
    expect(rec.ladder[0]).toMatchObject({ iteration: 1, ladderPassed: false });
    expect(rec.ladder[1]).toMatchObject({ iteration: 2, ladderPassed: true, approverVetoed: false });
    expect(rec.messages).toEqual(messages);
  });
});

describe('exportRunTrajectory', () => {
  it('joins the run log with the goaly-code session store into a labeled record', async () => {
    const run = doneRun();
    const store = new InMemorySessionStore();
    await store.save(SessionId.parse('s1'), messages);
    const rec = await exportRunTrajectory({
      stateDir: '/state',
      runId: 'run-1',
      sessionStore: store,
      read: async () => run,
    });
    expect(rec).not.toBeNull();
    expect(rec!.passed).toBe(true);
    expect(rec!.sessionId).toBe('s1');
    expect(rec!.messages).toEqual(messages);
  });

  it('returns null when the run does not exist', async () => {
    const rec = await exportRunTrajectory({
      stateDir: '/state',
      runId: 'nope',
      sessionStore: new InMemorySessionStore(),
      read: async () => null,
    });
    expect(rec).toBeNull();
  });

  it('exports empty messages when the session has none (e.g. a CLI-harness run)', async () => {
    const run = doneRun();
    const rec = await exportRunTrajectory({
      stateDir: '/state',
      runId: 'run-1',
      sessionStore: new InMemorySessionStore(), // nothing saved
      read: async () => run,
    });
    expect(rec!.messages).toEqual([]);
    expect(rec!.passed).toBe(true); // still labeled by the ladder/approver outcome
  });
});
