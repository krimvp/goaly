import { describe, it, expect } from 'vitest';
import { logEvent } from './log-event';
import type { Command, OrchestratorEvent } from '../domain/events';
import { dh, makeFakeContract, recordingLogger } from '../testing/fakes';

const command: Command = { tag: 'RUN_AGENT', prompt: 'p', sessionId: undefined } as Command;

function agentRan(): OrchestratorEvent {
  const [p, q] = dh('a', 'b');
  return {
    tag: 'AGENT_RAN',
    run: { output: '', sessionId: 'sess-1' as never, status: 'completed' },
    prevDiffHash: p!,
    diffHash: q!,
    budget: { exceeded: false },
  };
}

describe('logEvent', () => {
  it('stamps the per-iteration beats with the turn number when given', () => {
    const { logger, records } = recordingLogger('info');
    logEvent(logger, command, agentRan(), 3);
    const line = records.find((r) => r.msg === 'agent ran');
    expect(line?.fields).toMatchObject({ iteration: 3, status: 'completed' });
  });

  it('leaves the field off when no iteration is known (one-time beats)', () => {
    const { logger, records } = recordingLogger('info');
    logEvent(logger, command, agentRan());
    expect(records.find((r) => r.msg === 'agent ran')?.fields).not.toHaveProperty('iteration');
    logEvent(logger, command, { tag: 'CONTRACT_COMPILED', contract: makeFakeContract() }, 3);
    expect(records.find((r) => r.msg === 'contract compiled')?.fields).not.toHaveProperty('iteration');
  });
});
