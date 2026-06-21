import { describe, it, expect } from 'vitest';
import { composeDeps } from './compose';
import { asRunId } from '../domain/ids';
import { makeConfig, recordingLogger } from '../testing/fakes';
import type { AgentStreamEvent, StreamPhase } from '../agent-cli/stream';

const base = { harness: 'fake' as const, workspaceRoot: '/tmp/goaly-x', runId: asRunId('run-x') };
const quiet = { noLogFile: true as const, noLogConsole: true as const };

describe('composeDeps streaming wiring (issue #23)', () => {
  it('exposes no stream sink when no consumer is active (zero overhead by default)', () => {
    const deps = composeDeps(makeConfig(), { ...base, ...quiet });
    expect(deps.onStreamEvent).toBeUndefined();
  });

  it('--stream renders phase-tagged lines to the injected writer', () => {
    const lines: string[] = [];
    const deps = composeDeps(makeConfig(), {
      ...base,
      ...quiet,
      stream: true,
      streamWrite: (l) => lines.push(l),
    });
    expect(deps.onStreamEvent).toBeDefined();
    deps.onStreamEvent?.('agent', { kind: 'message', text: 'hello world' });
    deps.onStreamEvent?.('judge', { kind: 'done', status: 'turn.completed' });
    expect(lines.join('')).toContain('[agent]');
    expect(lines.join('')).toContain('hello world');
    expect(lines.join('')).toContain('[judge]');
  });

  it('routes stream events to the logger at debug (respecting --log-level)', () => {
    const { logger, records } = recordingLogger('debug');
    const deps = composeDeps(makeConfig(), { ...base, logger, logLevel: 'debug' });
    expect(deps.onStreamEvent).toBeDefined();
    deps.onStreamEvent?.('compile', { kind: 'session', sessionId: 's1' });
    const rec = records.find((r) => r.msg === 'stream');
    expect(rec).toBeDefined();
    expect(rec?.fields).toMatchObject({ phase: 'compile', kind: 'session', sessionId: 's1' });
  });

  it('does NOT route to the logger when the level is above debug', () => {
    const { logger, records } = recordingLogger('info');
    // info level + no --stream + no embedder → no consumer active → no sink at all.
    const deps = composeDeps(makeConfig(), { ...base, logger, logLevel: 'info' });
    expect(deps.onStreamEvent).toBeUndefined();
    expect(records.some((r) => r.msg === 'stream')).toBe(false);
  });

  it('forwards every event to an embedder subscription', () => {
    const got: Array<[StreamPhase, AgentStreamEvent]> = [];
    const deps = composeDeps(makeConfig(), {
      ...base,
      ...quiet,
      onStreamEvent: (phase, event) => got.push([phase, event]),
    });
    expect(deps.onStreamEvent).toBeDefined();
    deps.onStreamEvent?.('approve', { kind: 'tool_use', name: 'grep' });
    expect(got).toEqual([['approve', { kind: 'tool_use', name: 'grep' }]]);
  });

  it('a throwing embedder never propagates out of the sink (fail-closed)', () => {
    const deps = composeDeps(makeConfig(), {
      ...base,
      ...quiet,
      onStreamEvent: () => {
        throw new Error('embedder exploded');
      },
    });
    expect(() => deps.onStreamEvent?.('agent', { kind: 'done', status: 'x' })).not.toThrow();
  });
});
