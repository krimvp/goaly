import { describe, it, expect } from 'vitest';
import { drive, type DriverDeps } from './driver';
import type { HarnessAdapter } from '../harness/adapter';
import { HarnessRunResult } from '../domain/events';
import { SessionId, asRunId } from '../domain/ids';
import type { AgentEventSink, AgentStreamEvent, StreamPhase } from '../agent-cli/stream';
import {
  FakeCompiler,
  FakeSealGate,
  FakeVerifier,
  FakeApprover,
  FakeWorkspace,
  ManualClock,
  ManualBudgetMeter,
  InMemoryRunLog,
  makeFakeContract,
  makeConfig,
  passVerdict,
  approve,
} from '../testing/fakes';

/** A harness that mutates the workspace (so there is a diff) and emits canned stream events. */
class StreamingHarness implements HarnessAdapter {
  readonly name = 'streaming-fake';
  constructor(
    private readonly ws: FakeWorkspace,
    private readonly events: AgentStreamEvent[],
  ) {}
  async run(_prompt: string, sessionId?: SessionId, onEvent?: AgentEventSink): Promise<HarnessRunResult> {
    this.ws.setHash('bbbbbbb');
    for (const e of this.events) onEvent?.(e); // unguarded, exactly like a sink fed straight through
    return HarnessRunResult.parse({
      output: 'done',
      sessionId: sessionId ?? SessionId.parse('s1'),
      status: 'completed',
    });
  }
}

const canned: AgentStreamEvent[] = [
  { kind: 'session', sessionId: 's1' },
  { kind: 'tool_use', name: 'command', input: 'npm test' },
  { kind: 'message', text: 'done' },
];

/** Assemble DriverDeps around a harness + optional stream sink, with all other seams faked. */
function makeDeps(
  ws: FakeWorkspace,
  harness: HarnessAdapter,
  onStreamEvent?: (phase: StreamPhase, event: AgentStreamEvent) => void,
): { deps: DriverDeps; runlog: InMemoryRunLog } {
  const runlog = new InMemoryRunLog();
  const deps: DriverDeps = {
    compiler: new FakeCompiler(makeFakeContract()),
    seal: new FakeSealGate({ kind: 'approve' }),
    harness,
    makeLadder: () => new FakeVerifier([passVerdict()]),
    approver: new FakeApprover([approve()]),
    workspace: ws,
    clock: new ManualClock(),
    budget: new ManualBudgetMeter(),
    runlog,
    ...(onStreamEvent !== undefined ? { onStreamEvent } : {}),
  };
  return { deps, runlog };
}

describe('drive() streaming', () => {
  it('forwards the agent run turns tagged with phase "agent"', async () => {
    const ws = new FakeWorkspace('aaaaaaa');
    const captured: Array<[StreamPhase, AgentStreamEvent]> = [];
    const { deps } = makeDeps(ws, new StreamingHarness(ws, canned), (phase, event) =>
      captured.push([phase, event]),
    );

    const outcome = await drive(deps, makeConfig({ autonomous: true }), asRunId('run-stream'));

    expect(outcome.status).toBe('DONE');
    expect(captured.map(([p]) => p)).toEqual(['agent', 'agent', 'agent']);
    expect(captured.map(([, e]) => e)).toEqual(canned);
  });

  it('never writes stream events into the replay log (resume stays a fold over OrchestratorEvent)', async () => {
    const ws = new FakeWorkspace('aaaaaaa');
    const { deps, runlog } = makeDeps(ws, new StreamingHarness(ws, canned), () => {});

    await drive(deps, makeConfig({ autonomous: true }), asRunId('run-stream-2'));

    // Every persisted entry is an OrchestratorEvent (`tag`), never an AgentStreamEvent (`kind`).
    expect(runlog.entries.length).toBeGreaterThan(0);
    for (const entry of runlog.entries) {
      expect(entry.event).toHaveProperty('tag');
      expect(entry.event).not.toHaveProperty('kind');
    }
  });

  it('resolves to a terminal outcome even if the stream sink throws (drive never rejects)', async () => {
    const ws = new FakeWorkspace('aaaaaaa');
    const { deps } = makeDeps(ws, new StreamingHarness(ws, canned), () => {
      throw new Error('sink exploded');
    });

    const outcome = await drive(deps, makeConfig({ autonomous: true }), asRunId('run-stream-3'));
    expect(['DONE', 'FAILED', 'ABORTED']).toContain(outcome.status);
  });
});
