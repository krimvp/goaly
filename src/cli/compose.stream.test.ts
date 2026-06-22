import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeDeps } from './compose';
import { asRunId } from '../domain/ids';
import { makeConfig, recordingLogger } from '../testing/fakes';
import { readStreamTranscript, STREAM_FILE } from '../runlog/stream-transcript';
import type { AgentStreamEvent, StreamPhase } from '../agent-cli/stream';

const base = { harness: 'fake' as const, workspaceRoot: '/tmp/goaly-x', runId: asRunId('run-x') };
const quiet = { noLogFile: true as const, noLogConsole: true as const };
const FIXED_TS = 1_700_000_000_000;

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

describe('composeDeps stream transcript wiring (issue #28)', () => {
  let counter = 0;
  async function freshState(): Promise<string> {
    counter += 1;
    return mkdtemp(join(tmpdir(), `compose-transcript-${process.pid}-${counter}-`));
  }

  it('persists the canonical stream to <stateDir>/<runId>/stream.jsonl when --stream-transcript is on', async () => {
    const stateDir = await freshState();
    try {
      const runId = asRunId('run-t');
      const deps = composeDeps(makeConfig(), {
        ...base,
        ...quiet,
        runId,
        stateDir,
        streamTranscript: true,
        now: () => FIXED_TS,
      });
      expect(deps.onStreamEvent).toBeDefined();
      deps.onStreamEvent?.('agent', { kind: 'message', text: 'hi' });
      deps.onStreamEvent?.('judge', { kind: 'done', status: 'completed' });

      const entries = await readStreamTranscript(stateDir, runId);
      expect(entries).toEqual([
        { kind: 'message', text: 'hi', phase: 'agent', ts: FIXED_TS },
        { kind: 'done', status: 'completed', phase: 'judge', ts: FIXED_TS },
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('honours an explicit --stream-file path', async () => {
    const stateDir = await freshState();
    try {
      const file = join(stateDir, 'custom-stream.jsonl');
      const deps = composeDeps(makeConfig(), {
        ...base,
        ...quiet,
        stateDir,
        streamFile: file,
        now: () => FIXED_TS,
      });
      expect(deps.onStreamEvent).toBeDefined();
      deps.onStreamEvent?.('agent', { kind: 'session', sessionId: 's9' });

      // The default-path reader sees nothing; the custom file holds the event.
      expect(await readStreamTranscript(stateDir, String(base.runId))).toBeNull();
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(file, 'utf8');
      expect(JSON.parse(raw.trim())).toEqual({ kind: 'session', sessionId: 's9', phase: 'agent', ts: FIXED_TS });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('coexists with the embedder hook (both receive every event)', async () => {
    const stateDir = await freshState();
    try {
      const runId = asRunId('run-both');
      const got: Array<[StreamPhase, AgentStreamEvent]> = [];
      const deps = composeDeps(makeConfig(), {
        ...base,
        ...quiet,
        runId,
        stateDir,
        streamTranscript: true,
        onStreamEvent: (phase, event) => got.push([phase, event]),
        now: () => FIXED_TS,
      });
      deps.onStreamEvent?.('agent', { kind: 'tool_use', name: 'grep' });

      expect(got).toEqual([['agent', { kind: 'tool_use', name: 'grep' }]]);
      expect(await readStreamTranscript(stateDir, runId)).toEqual([
        { kind: 'tool_use', name: 'grep', phase: 'agent', ts: FIXED_TS },
      ]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it('writes no transcript when neither flag is set (zero overhead)', async () => {
    const stateDir = await freshState();
    try {
      const runId = asRunId('run-none');
      const deps = composeDeps(makeConfig(), { ...base, ...quiet, runId, stateDir });
      expect(deps.onStreamEvent).toBeUndefined();
      expect(await readStreamTranscript(stateDir, runId)).toBeNull();
      // No transcript file was created anywhere under the run directory.
      const { stat } = await import('node:fs/promises');
      await expect(stat(join(stateDir, runId, STREAM_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
