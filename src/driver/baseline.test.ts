import { describe, it, expect } from 'vitest';
import { Baseline, recordCheckpoint, type CheckpointDeps } from './baseline';
import {
  FakeWorkspace,
  ManualClock,
  InMemoryRunLog,
  recordingLogger,
  passVerdict,
} from '../testing/fakes';
import { RunId, DiffHash } from '../domain/ids';
import type { Command, OrchestratorEvent } from '../domain/events';

const runId = RunId.parse('run-baseline');
const runAgentNext: Command = { tag: 'RUN_AGENT', prompt: 'next', sessionId: undefined };
const verified: OrchestratorEvent = { tag: 'VERIFIED', verdict: passVerdict() };

const deps = (workspace: FakeWorkspace, extra?: Partial<CheckpointDeps>): CheckpointDeps => ({
  workspace,
  runlog: new InMemoryRunLog(),
  clock: new ManualClock(),
  ...extra,
});

describe('Baseline', () => {
  describe('approverDiff', () => {
    it('diffs against the workspace active baseline when delta-verify is OFF', async () => {
      const ws = new FakeWorkspace('0000000', 'ACTIVE');
      const b = new Baseline(deps(ws), false, 'run-start');
      expect(await b.approverDiff()).toBe('ACTIVE');
      // It used the workspace default (currentBaseline), NOT the cumulative run-start baseline.
      expect(ws.diffBaselines.at(-1)).toBe(ws.currentBaseline());
    });

    it('pins to the cumulative (run-start) baseline when delta-verify is ON', async () => {
      const ws = new FakeWorkspace('0000000', 'ACTIVE');
      ws.setDiffFor('0000abc', 'CUMULATIVE');
      const b = new Baseline(deps(ws), true, '0000abc');
      expect(await b.approverDiff()).toBe('CUMULATIVE');
      expect(ws.diffBaselines.at(-1)).toBe('0000abc');
    });
  });

  describe('onTransition', () => {
    it('advances the approver baseline at a --phased boundary (no per-iteration checkpoint)', async () => {
      const ws = new FakeWorkspace('0000000', 'ACTIVE');
      ws.setDiffFor('0000aaa', 'PHASE2');
      const b = new Baseline(deps(ws), true, 'run-start');
      const phaseAdvanced: OrchestratorEvent = {
        tag: 'PHASE_ADVANCED',
        tree: DiffHash.parse('0000aaa'),
      };
      const seq = await b.onTransition({
        event: phaseAdvanced,
        nextCommand: undefined,
        seq: 5,
        runId,
        contractHash: null,
        nextTag: 'COMPILING',
      });
      expect(seq).toBe(5);
      // The approver now reviews against the phase-start tree.
      expect(await b.approverDiff()).toBe('PHASE2');
    });

    it('checkpoints after a continuation iteration under --delta-verify (seq advances + CHECKPOINTED logged)', async () => {
      const ws = new FakeWorkspace('0000abc');
      const runlog = new InMemoryRunLog();
      const b = new Baseline({ workspace: ws, runlog, clock: new ManualClock() }, true, 'run-start');
      const seq = await b.onTransition({
        event: verified,
        nextCommand: runAgentNext,
        seq: 7,
        runId,
        contractHash: null,
        nextTag: 'RUNNING_AGENT',
      });
      expect(seq).toBe(8);
      expect(runlog.entries.at(-1)?.event.tag).toBe('CHECKPOINTED');
    });

    it('does NOT checkpoint a non-continuation transition (next command is not RUN_AGENT)', async () => {
      const ws = new FakeWorkspace('0000abc');
      const runlog = new InMemoryRunLog();
      const b = new Baseline({ workspace: ws, runlog, clock: new ManualClock() }, true, 'run-start');
      const seq = await b.onTransition({
        event: verified,
        nextCommand: undefined,
        seq: 7,
        runId,
        contractHash: null,
        nextTag: 'AWAIT_SIGNOFF',
      });
      expect(seq).toBe(7);
      expect(runlog.entries).toHaveLength(0);
    });

    it('does NOT checkpoint when delta-verify is OFF', async () => {
      const ws = new FakeWorkspace('0000abc');
      const runlog = new InMemoryRunLog();
      const b = new Baseline({ workspace: ws, runlog, clock: new ManualClock() }, false, 'run-start');
      const seq = await b.onTransition({
        event: verified,
        nextCommand: runAgentNext,
        seq: 7,
        runId,
        contractHash: null,
        nextTag: 'RUNNING_AGENT',
      });
      expect(seq).toBe(7);
      expect(runlog.entries).toHaveLength(0);
    });

    it('fails closed on a checkpoint error: rolls the active baseline back and keeps seq (invariant #4)', async () => {
      const ws = new FakeWorkspace('0000abc');
      ws.checkpoint = async () => {
        throw new Error('snapshot boom');
      };
      const { logger, records } = recordingLogger('warn');
      const b = new Baseline(
        { workspace: ws, runlog: new InMemoryRunLog(), clock: new ManualClock(), logger },
        true,
        'run-start',
      );
      const prior = ws.currentBaseline();
      const seq = await b.onTransition({
        event: verified,
        nextCommand: runAgentNext,
        seq: 7,
        runId,
        contractHash: null,
        nextTag: 'RUNNING_AGENT',
      });
      expect(seq).toBe(7); // no advance on failure
      expect(ws.baselineCalls.at(-1)).toBe(prior); // active baseline rolled back
      expect(records.some((r) => r.msg.includes('checkpoint failed'))).toBe(true);
    });
  });

  describe('hydrateResume', () => {
    it('re-points the active baseline and the cumulative approver baseline from the fold', async () => {
      const ws = new FakeWorkspace('0000000', 'ACTIVE');
      ws.setDiffFor('phase-start', 'PHASE_CUMULATIVE');
      const b = new Baseline(deps(ws), true, 'run-start');
      b.hydrateResume({ baseline: 'active-cp', phaseBaseline: 'phase-start' });
      expect(ws.baselineCalls).toContain('active-cp'); // active baseline re-pointed
      expect(await b.approverDiff()).toBe('PHASE_CUMULATIVE'); // approver pinned to the phase start
    });

    it('keeps the constructor baselines when the fold has nulls (a classic run)', async () => {
      const ws = new FakeWorkspace('0000000', 'ACTIVE');
      ws.setDiffFor('run-start', 'RUN_START_DIFF');
      const b = new Baseline(deps(ws), true, 'run-start');
      b.hydrateResume({ baseline: null, phaseBaseline: null });
      expect(ws.baselineCalls).toHaveLength(0);
      expect(await b.approverDiff()).toBe('RUN_START_DIFF');
    });
  });

  describe('recordCheckpoint (the primitive)', () => {
    it('snapshots the tree, appends a CHECKPOINTED event, and returns the next seq', async () => {
      const ws = new FakeWorkspace('0000fed');
      const runlog = new InMemoryRunLog();
      const out = await recordCheckpoint(
        { workspace: ws, runlog, clock: new ManualClock() },
        runId,
        3,
        null,
        'RUNNING_AGENT',
      );
      expect(out.seq).toBe(4);
      expect(out.tree).toBe('0000fed');
      expect(runlog.entries.at(-1)).toMatchObject({
        seq: 4,
        event: { tag: 'CHECKPOINTED', tree: '0000fed' },
      });
    });
  });
});
