import { describe, it, expect } from 'vitest';
import { resumeHint, renderResumeHint } from './resume-cmd';
import { codecFor, type AgentCli } from '../agent-cli/registry';
import { SessionId } from '../domain/ids';

const sid = SessionId.parse('sess-abc123');

describe('per-codec interactiveResume', () => {
  it('claude → claude --resume <id>', () => {
    expect(codecFor('claude').interactiveResume?.(sid)).toEqual({ command: `claude --resume ${sid}` });
  });
  it('codex → codex resume <id> with an exec caveat', () => {
    const hint = codecFor('codex').interactiveResume?.(sid);
    expect(hint?.command).toBe(`codex resume ${sid}`);
    expect(hint?.caveat).toMatch(/exec/);
  });
  it('droid → droid --session-id <id>', () => {
    expect(codecFor('droid').interactiveResume?.(sid)).toEqual({ command: `droid --session-id ${sid}` });
  });
  it('pi → pi --continue (latest-cwd caveat; id not addressable)', () => {
    const hint = codecFor('pi').interactiveResume?.(sid);
    expect(hint?.command).toBe('pi --continue');
    expect(hint?.caveat).toMatch(/LATEST session/);
  });
});

describe('resumeHint', () => {
  it('maps a CLI harness + session id to a command hint', () => {
    expect(resumeHint('claude', sid, 'run-1')).toEqual({ kind: 'command', command: `claude --resume ${sid}` });
  });

  it('routes goaly-code to Capability C (no external CLI)', () => {
    expect(resumeHint('goaly-code', sid, 'run-1')).toEqual({ kind: 'goaly-code', runId: 'run-1' });
  });

  it('is none when no session id was recovered', () => {
    const h = resumeHint('claude', undefined, 'run-1');
    expect(h.kind).toBe('none');
  });

  it('is none (with a --harness hint) when the log does not record the harness', () => {
    const h = resumeHint(undefined, sid, 'run-1');
    expect(h).toMatchObject({ kind: 'none' });
    if (h.kind === 'none') expect(h.reason).toMatch(/--harness/);
  });

  it('is none for the fake harness', () => {
    expect(resumeHint('fake', sid, 'run-1').kind).toBe('none');
  });
});

describe('renderResumeHint', () => {
  it('renders the command and its caveat', () => {
    const lines = renderResumeHint({ kind: 'command', command: 'codex resume x', caveat: 'differs' });
    expect(lines).toEqual(['codex resume x', '  note: differs']);
  });

  it('renders the goaly-code → --from-run route', () => {
    const lines = renderResumeHint({ kind: 'goaly-code', runId: 'run-9' });
    expect(lines.join('\n')).toContain('--from-run run-9 --inherit-session --harness goaly-code');
  });

  it('stays quiet on none unless verbose', () => {
    expect(renderResumeHint({ kind: 'none', reason: 'x' })).toEqual([]);
    expect(renderResumeHint({ kind: 'none', reason: 'x' }, { verbose: true })).toEqual(['(no resume command: x)']);
  });
});

// Defensive: every bundled codec exposes an interactive resume (the registry stays in sync).
describe('codec coverage', () => {
  it('all bundled CLIs implement interactiveResume', () => {
    for (const cli of ['claude', 'codex', 'droid', 'pi'] satisfies AgentCli[]) {
      expect(typeof codecFor(cli).interactiveResume).toBe('function');
    }
  });
});
