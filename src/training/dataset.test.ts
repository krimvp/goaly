import { describe, it, expect } from 'vitest';
import { selectPassing, toSftExample, toSftJsonl, datasetStats } from './dataset';
import type { TrajectoryRecord } from './trajectory';
import type { ChatMessage } from '../llm-client/schema';

const msgs: ChatMessage[] = [
  { role: 'system', content: 's' },
  { role: 'user', content: 'u' },
  { role: 'assistant', content: 'done' },
];

function rec(over: Partial<TrajectoryRecord>): TrajectoryRecord {
  return {
    runId: 'r',
    goal: 'g',
    rungs: [{ kind: 'deterministic', label: 'true' }],
    status: 'DONE',
    passed: true,
    iterations: 1,
    tokens: 100,
    ladder: [],
    sessionId: 's',
    messages: msgs,
    ...over,
  };
}

describe('selectPassing (rejection sampling)', () => {
  it('keeps only passed trajectories that have messages', () => {
    const records = [
      rec({ runId: 'pass', passed: true }),
      rec({ runId: 'fail', passed: false, status: 'FAILED' }),
      rec({ runId: 'pass-no-msgs', passed: true, messages: [] }),
    ];
    expect(selectPassing(records).map((r) => r.runId)).toEqual(['pass']);
  });

  it('honors requireMessages: false (keeps a passed run with no trajectory)', () => {
    const records = [rec({ runId: 'pass-no-msgs', passed: true, messages: [] })];
    expect(selectPassing(records, { requireMessages: false }).map((r) => r.runId)).toEqual(['pass-no-msgs']);
  });

  it('caps by iteration count for minimality', () => {
    const records = [rec({ runId: 'quick', iterations: 1 }), rec({ runId: 'slow', iterations: 9 })];
    expect(selectPassing(records, { maxIterations: 3 }).map((r) => r.runId)).toEqual(['quick']);
  });
});

describe('toSftExample / toSftJsonl', () => {
  it('emits the conversation plus the goaly-code tool schema', () => {
    const ex = toSftExample(rec({}));
    expect(ex.messages).toEqual(msgs);
    expect(ex.tools.map((t) => t.function.name)).toContain('edit_file');
    expect(ex.tools).toHaveLength(7);
  });

  it('serializes one selected example per line with a trailing newline', () => {
    const records = [rec({ runId: 'a' }), rec({ runId: 'b', passed: false, status: 'FAILED' })];
    const jsonl = toSftJsonl(records);
    const lines = jsonl.trimEnd().split('\n');
    expect(lines).toHaveLength(1); // only the passing one
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });

  it('returns an empty string when nothing passes', () => {
    expect(toSftJsonl([rec({ passed: false, status: 'ABORTED' })])).toBe('');
  });
});

describe('datasetStats', () => {
  it('reports totals, passing, selected, and a status histogram', () => {
    const records = [
      rec({ passed: true, status: 'DONE' }),
      rec({ passed: true, status: 'DONE', messages: [] }), // passing but no messages → not selected
      rec({ passed: false, status: 'FAILED' }),
      rec({ passed: false, status: 'ABORTED' }),
    ];
    expect(datasetStats(records)).toEqual({
      total: 4,
      passing: 2,
      selected: 1,
      byStatus: { DONE: 2, FAILED: 1, ABORTED: 1 },
    });
  });
});
