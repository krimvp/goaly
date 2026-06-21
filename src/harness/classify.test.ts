import { describe, it, expect } from 'vitest';
import { classifyHarnessRun } from './classify';
import type { AgentOutput } from '../agent-cli/output';

describe('classifyHarnessRun (flat adapters: claude-code, droid)', () => {
  it('maps a clean exit with text to completed (+ tokens + session)', () => {
    const parsed: AgentOutput = { text: 'ok', sessionId: 'sess-a', tokens: 7 };
    const r = classifyHarnessRun({ parsed, code: 0, stderr: '', unknownSession: 'unk' });
    expect(r.status).toBe('completed');
    expect(r.output).toBe('ok');
    expect(r.sessionId).toBe('sess-a');
    expect(r.tokensUsed).toBe(7);
  });

  it('maps a non-zero exit to crashed, preferring stderr and the resume session', () => {
    const r = classifyHarnessRun({
      parsed: null,
      code: 1,
      stderr: 'boom',
      sessionId: 'keep',
      unknownSession: 'unk',
    });
    expect(r.status).toBe('crashed');
    expect(r.output).toBe('boom');
    expect(r.sessionId).toBe('keep');
  });

  it('maps a timeout to timeout, salvaging parsed text and session', () => {
    const parsed: AgentOutput = { text: 'partial', sessionId: 'sess-t' };
    const r = classifyHarnessRun({ parsed, code: 0, stderr: '', timedOut: true, unknownSession: 'unk' });
    expect(r.status).toBe('timeout');
    expect(r.output).toBe('partial');
    expect(r.sessionId).toBe('sess-t');
  });

  it('maps exit-0 with no parseable text to truncated', () => {
    const r = classifyHarnessRun({ parsed: null, code: 0, stderr: '', sessionId: 'sess', unknownSession: 'unk' });
    expect(r.status).toBe('truncated');
    expect(r.sessionId).toBe('sess');
  });

  it('maps an empty-text result to truncated, keeping its session', () => {
    const parsed: AgentOutput = { text: '', sessionId: 'sess-e' };
    const r = classifyHarnessRun({ parsed, code: 0, stderr: '', unknownSession: 'unk' });
    expect(r.status).toBe('truncated');
    expect(r.sessionId).toBe('sess-e');
  });

  it('maps a soft isError flag on a clean exit to truncated', () => {
    const parsed: AgentOutput = { text: 'aborted mid-task', isError: true };
    const r = classifyHarnessRun({ parsed, code: 0, stderr: '', unknownSession: 'unk' });
    expect(r.status).toBe('truncated');
    expect(r.output).toBe('aborted mid-task');
  });

  it('falls back to the unknown sentinel when no session is available', () => {
    const r = classifyHarnessRun({ parsed: null, code: 1, stderr: 'x', unknownSession: 'claude-unknown' });
    expect(r.sessionId).toBe('claude-unknown');
  });
});
