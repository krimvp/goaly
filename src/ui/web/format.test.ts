import { describe, it, expect } from 'vitest';
import {
  feedLine,
  streamLine,
  iterationAt,
  statusBadgeClass,
  truncate,
  sealFieldsOf,
  buildSealPatch,
  fmtTokens,
  fmtDuration,
  fmtAgo,
  pipelineStageOf,
  PIPELINE_STAGES,
} from './format';
import { RunId, ContractHash, DiffHash, SessionId } from '../../domain/ids';
import type { RunLogEntry } from '../../runlog/runlog';
import { makeFakeContract } from '../../testing/fakes';

function entry(event: RunLogEntry['event'], seq = 1): RunLogEntry {
  return {
    runId: RunId.parse('run-x'),
    seq,
    ts: 45_296_000, // 12:34:56 UTC
    contractHash: ContractHash.parse('c'.repeat(64)),
    event,
    stateTagAfter: 'VERIFYING',
  };
}

const agentRan = (changed: boolean): RunLogEntry['event'] => ({
  tag: 'AGENT_RAN',
  run: { output: 'ok', sessionId: SessionId.parse('s1'), status: 'completed' },
  prevDiffHash: DiffHash.parse('0000000'),
  diffHash: DiffHash.parse(changed ? '0000001' : '0000000'),
  budget: { exceeded: false },
});

describe('feedLine — the browser twin of renderWatchEvent', () => {
  it('renders agent turns with iteration + tree change', () => {
    const line = feedLine(entry(agentRan(true)), 2);
    expect(line).toMatchObject({ at: '12:34:56', tone: 'plain' });
    expect(line?.text).toBe('iter 2: agent completed (tree changed)');
    expect(feedLine(entry(agentRan(false)), 1)?.text).toContain('no changes');
  });

  it('tones verify PASS/FAIL and sign-off approve/veto', () => {
    expect(feedLine(entry({ tag: 'VERIFIED', verdict: { pass: true, confidence: 1, detail: '' } }), 1)?.tone).toBe('pass');
    const fail = feedLine(entry({ tag: 'VERIFIED', verdict: { pass: false, confidence: 1, detail: 'tests red' } }), 1);
    expect(fail?.tone).toBe('fail');
    expect(fail?.text).toContain('tests red');
    expect(feedLine(entry({ tag: 'SIGNOFF_DECIDED', approval: { veto: false } }), 1)?.tone).toBe('pass');
    expect(feedLine(entry({ tag: 'SIGNOFF_DECIDED', approval: { veto: true, reason: 'nope' } }), 1)?.tone).toBe('fail');
  });

  it('drops the internal CHECKPOINTED marker', () => {
    expect(feedLine(entry({ tag: 'CHECKPOINTED', tree: DiffHash.parse('a'.repeat(40)) }), 1)).toBeNull();
  });

  it('names operator extensions', () => {
    const line = feedLine(entry({ tag: 'RUN_EXTENDED', maxIterations: 9, note: 'try harder' }), 1);
    expect(line?.text).toContain('max-iterations→9');
    expect(line?.text).toContain('try harder');
  });
});

describe('streamLine — per-turn transcript rendering', () => {
  it('renders tool uses, errors, and messages with the phase tag', () => {
    expect(streamLine({ kind: 'tool_use', name: 'edit_file', phase: 'agent', ts: 1 })?.text).toContain('[agent] ⚒ edit_file');
    expect(streamLine({ kind: 'tool_result', output: 'boom', isError: true, phase: 'agent', ts: 1 })?.tone).toBe('fail');
    expect(streamLine({ kind: 'message', text: 'hello', phase: 'judge', ts: 1 })?.text).toBe('[judge] hello');
    expect(streamLine({ kind: 'message', text: '   ', phase: 'agent', ts: 1 })).toBeNull();
  });
});

describe('helpers', () => {
  it('iterationAt counts AGENT_RAN entries up to an index', () => {
    const entries = [entry(agentRan(true), 1), entry({ tag: 'VERIFIED', verdict: { pass: false, confidence: 1, detail: '' } }, 2), entry(agentRan(true), 3)];
    expect(iterationAt(entries, 0)).toBe(1);
    expect(iterationAt(entries, 1)).toBe(1);
    expect(iterationAt(entries, 2)).toBe(2);
  });

  it('statusBadgeClass maps statuses to badge classes', () => {
    expect(statusBadgeClass('DONE')).toBe('badge done');
    expect(statusBadgeClass('FAILED')).toBe('badge failed');
    expect(statusBadgeClass('INCOMPLETE')).toBe('badge incomplete');
    expect(statusBadgeClass('CORRUPT')).toBe('badge corrupt');
  });

  it('truncate flattens whitespace and caps length', () => {
    expect(truncate('a  b\n c', 100)).toBe('a b c');
    expect(truncate('x'.repeat(20), 10)).toHaveLength(10);
  });

  it('fmtTokens compacts counts and keeps "unknown" distinct', () => {
    expect(fmtTokens(undefined)).toBe('—');
    expect(fmtTokens(950)).toBe('950');
    expect(fmtTokens(12_345)).toBe('12.3k');
    expect(fmtTokens(4_000)).toBe('4k');
    expect(fmtTokens(4_200_000)).toBe('4.2M');
  });

  it('fmtDuration renders seconds / minutes / hours', () => {
    expect(fmtDuration(0, 42_000)).toBe('42s');
    expect(fmtDuration(0, 192_000)).toBe('3m 12s');
    expect(fmtDuration(0, 2 * 3_600_000 + 5 * 60_000)).toBe('2h 05m');
    expect(fmtDuration(5_000, 1_000)).toBe('0s'); // clock skew never goes negative
  });

  it('fmtAgo renders coarse relative time', () => {
    expect(fmtAgo(1_000, 30_000)).toBe('just now');
    expect(fmtAgo(0, 5 * 60_000)).toBe('5m ago');
    expect(fmtAgo(0, 3 * 3_600_000)).toBe('3h ago');
    expect(fmtAgo(0, 72 * 3_600_000)).toBe('3d ago');
  });
});

describe('pipelineStageOf — state tag → pipeline stage for the mission strip', () => {
  it('maps every non-terminal tag onto a stage', () => {
    expect(pipelineStageOf('PLANNING')).toBe('plan');
    expect(pipelineStageOf('AWAIT_PLAN_SEAL')).toBe('plan');
    expect(pipelineStageOf('COMPILING')).toBe('compile');
    expect(pipelineStageOf('AWAIT_SEAL')).toBe('seal');
    expect(pipelineStageOf('PREPARING')).toBe('prepare');
    expect(pipelineStageOf('RUNNING_AGENT')).toBe('agent');
    expect(pipelineStageOf('RUNNING_WAVE')).toBe('agent');
    expect(pipelineStageOf('ADVANCING_PHASE')).toBe('agent');
    expect(pipelineStageOf('VERIFYING')).toBe('verify');
    expect(pipelineStageOf('AWAIT_SIGNOFF')).toBe('signoff');
    expect(pipelineStageOf('DONE')).toBe('done');
  });

  it('terminal failures have no active stage, and every mapped stage exists in the strip', () => {
    expect(pipelineStageOf('FAILED')).toBeNull();
    expect(pipelineStageOf('ABORTED')).toBeNull();
    const keys = PIPELINE_STAGES.map((s) => s.key);
    for (const tag of ['PLANNING', 'COMPILING', 'AWAIT_SEAL', 'PREPARING', 'RUNNING_AGENT', 'VERIFYING', 'AWAIT_SIGNOFF', 'DONE']) {
      const stage = pipelineStageOf(tag);
      expect(stage).not.toBeNull();
      expect(keys).toContain(stage);
    }
  });
});

describe('buildSealPatch — minimal field patch for the review station (ADR 0016)', () => {
  const contract = makeFakeContract({
    setup: 'npm ci',
    rubric: 'the rubric',
    rungs: [
      { kind: 'deterministic', command: 'npm test' },
      { kind: 'judge', rubric: 'judge it', quorum: 1, confidenceFloor: 0.5 },
      { kind: 'deterministic', command: 'node smoke.mjs' },
    ],
  });

  it('no edits → undefined (a pure files-from-disk refreeze)', () => {
    expect(buildSealPatch(contract, sealFieldsOf(contract))).toBeUndefined();
  });

  it('maps each changed field; clearing setup becomes null', () => {
    const fields = sealFieldsOf(contract);
    expect(buildSealPatch(contract, { ...fields, setup: '' })).toEqual({ setup: null });
    expect(buildSealPatch(contract, { ...fields, setup: ' make deps ' })).toEqual({ setup: 'make deps' });
    expect(buildSealPatch(contract, { ...fields, rubric: 'stricter' })).toEqual({ rubric: 'stricter' });
  });

  it('emits command entries only for CHANGED deterministic rungs, indexed past judge rungs', () => {
    const fields = sealFieldsOf(contract);
    const commands = [...fields.commands];
    commands[2] = 'node smoke.mjs --strict';
    expect(buildSealPatch(contract, { ...fields, commands })).toEqual({
      commands: [{ index: 2, command: 'node smoke.mjs --strict' }],
    });
    // Judge rungs render as '' in the form and are never patched.
    expect(fields.commands[1]).toBe('');
  });

  it('a contract with no setup + untouched empty field stays undefined', () => {
    const bare = makeFakeContract();
    expect(bare.setup).toBeUndefined();
    expect(buildSealPatch(bare, sealFieldsOf(bare))).toBeUndefined();
  });
});
