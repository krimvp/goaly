// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { h, render } from 'preact';
import { pairToolResults, SessionView, SESSION_RENDER_CAP } from './session';
import type { StreamTranscriptEntry } from '../../runlog/stream-transcript';
import type { AgentStreamEvent, StreamPhase } from '../../agent-cli/stream';

/**
 * The session inspector, rendered for real under happy-dom. `pairToolResults` is the pure pairing
 * core; the view tests prove the transcript renders without throwing and the filter chips actually
 * remove blocks from the DOM.
 */

function entry({
  phase = 'agent',
  ts = 45_296_000,
  ...event
}: AgentStreamEvent & { phase?: StreamPhase; ts?: number }): StreamTranscriptEntry {
  return { phase, ts, ...event } as StreamTranscriptEntry;
}

describe('pairToolResults', () => {
  it('pairs by id when both sides carry one', () => {
    const entries = [
      entry({ kind: 'tool_use', id: 'a', name: 'Read' }),
      entry({ kind: 'tool_use', id: 'b', name: 'Write' }),
      entry({ kind: 'tool_result', id: 'b', output: 'wrote' }),
      entry({ kind: 'tool_result', id: 'a', output: 'read' }),
    ];
    const paired = pairToolResults(entries);
    expect(paired.get(0)?.output).toBe('read');
    expect(paired.get(1)?.output).toBe('wrote');
  });

  it('falls back to nearest preceding unmatched tool_use when ids are absent', () => {
    const entries = [
      entry({ kind: 'tool_use', name: 'Bash' }),
      entry({ kind: 'tool_result', output: 'ok' }),
      entry({ kind: 'tool_use', name: 'Bash' }),
      entry({ kind: 'tool_result', output: 'second' }),
    ];
    const paired = pairToolResults(entries);
    expect(paired.get(0)?.output).toBe('ok');
    expect(paired.get(2)?.output).toBe('second');
  });

  it('leaves an orphan result unpaired rather than stealing a matched tool_use', () => {
    const entries = [
      entry({ kind: 'tool_use', id: 'a', name: 'Read' }),
      entry({ kind: 'tool_result', id: 'a', output: 'read' }),
      entry({ kind: 'tool_result', id: 'ghost', output: 'orphan' }),
    ];
    const paired = pairToolResults(entries);
    expect(paired.size).toBe(1);
    expect(paired.get(0)?.output).toBe('read');
  });
});

describe('SessionView', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });
  afterEach(() => {
    render(null, root);
    root.remove();
  });

  const flush = async (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  function mount(entries: StreamTranscriptEntry[], live = false): void {
    render(h(SessionView, { entries, live, harness: 'claude', sessionId: 'sess-1' }), root);
  }

  it('renders the empty-state hint when there is no transcript', () => {
    mount([]);
    expect(root.textContent).toContain('No session transcript');
    expect(root.textContent).toContain('--stream-transcript');
  });

  it('renders every entry kind without throwing', () => {
    mount([
      entry({ kind: 'session', sessionId: 'sess-1' }),
      entry({ kind: 'message', text: 'hello from the agent' }),
      entry({ kind: 'reasoning', text: 'thinking about it' }),
      entry({ kind: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }),
      entry({ kind: 'tool_result', id: 't1', output: 'file.txt' }),
      entry({ kind: 'usage', totalTokens: 1234 }),
      entry({ kind: 'done', status: 'success' }),
    ], true);
    const text = root.textContent ?? '';
    expect(text).toContain('hello from the agent');
    expect(text).toContain('thinking about it');
    expect(text).toContain('Bash');
    expect(text).toContain('file.txt');
    expect(text).toContain('turn done — success');
    expect(text).toContain('session live — streaming');
    expect(text).toContain('claude session sess-1');
  });

  it('toggling the tools chip removes tool blocks from the DOM', async () => {
    mount([
      entry({ kind: 'message', text: 'kept' }),
      entry({ kind: 'tool_use', id: 't1', name: 'UniqueToolName' }),
      entry({ kind: 'tool_result', id: 't1', output: 'tool output' }),
    ]);
    expect(root.textContent).toContain('UniqueToolName');

    const chips = [...root.querySelectorAll('button.chip')];
    const toolsChip = chips.find((b) => (b.textContent ?? '').includes('tools'));
    if (toolsChip === undefined) throw new Error('tools chip not rendered');
    (toolsChip as HTMLButtonElement).click();
    await flush();

    expect(root.textContent).not.toContain('UniqueToolName');
    expect(root.textContent).toContain('kept');
  });

  it('filtering to a seam hides entries from other phases', async () => {
    mount([
      entry({ kind: 'message', text: 'agent says', phase: 'agent' }),
      entry({ kind: 'message', text: 'judge says', phase: 'judge' }),
    ]);
    const chips = [...root.querySelectorAll('button.chip')];
    const judgeChip = chips.find((b) => (b.textContent ?? '').trim() === 'judge');
    if (judgeChip === undefined) throw new Error('judge phase chip not rendered');
    (judgeChip as HTMLButtonElement).click();
    await flush();

    expect(root.textContent).toContain('judge says');
    expect(root.textContent).not.toContain('agent says');
  });

  it('windows the render past the cap and says the full transcript is on disk', () => {
    const entries = Array.from({ length: SESSION_RENDER_CAP + 10 }, (_, i) =>
      entry({ kind: 'message', text: `m${i}` }),
    );
    mount(entries);
    const text = root.textContent ?? '';
    expect(text).toContain(`last ${SESSION_RENDER_CAP} of ${entries.length} entries`);
    expect(text).not.toContain('m0 '); // the earliest entries fell outside the window
    expect(text).toContain(`m${entries.length - 1}`);
  });
});
