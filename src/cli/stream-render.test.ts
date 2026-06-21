import { describe, it, expect } from 'vitest';
import { renderStreamLine, streamLogFields, makeStreamRenderer } from './stream-render';

describe('renderStreamLine', () => {
  it('tags every line with its phase and a per-kind glyph', () => {
    expect(renderStreamLine('agent', { kind: 'session', sessionId: 's1' })).toBe('[agent] · session s1\n');
    expect(renderStreamLine('judge', { kind: 'message', text: 'hi' })).toContain('[judge]');
    expect(renderStreamLine('agent', { kind: 'tool_use', name: 'Bash', input: 'ls -la' })).toBe(
      '[agent] → Bash ls -la\n',
    );
    expect(renderStreamLine('agent', { kind: 'tool_result', output: 'ok', exitCode: 0 })).toBe(
      '[agent] ← exit 0 ok\n',
    );
    expect(renderStreamLine('compile', { kind: 'usage', inputTokens: 3, outputTokens: 4, totalTokens: 7 })).toBe(
      '[compile] 🧮 tokens in=3 out=4 total=7\n',
    );
    expect(renderStreamLine('approve', { kind: 'done', status: 'success' })).toBe('[approve] ✓ done (success)\n');
  });

  it('collapses whitespace and clips long text to one row', () => {
    const line = renderStreamLine('agent', { kind: 'message', text: 'a\n\n  b   c'.padEnd(400, 'x') }, 20);
    expect(line).not.toContain('\n\n');
    expect(line.endsWith('…\n')).toBe(true);
    expect(line.length).toBeLessThan(40);
  });

  it('renders a JSON tool input payload as a preview', () => {
    expect(renderStreamLine('agent', { kind: 'tool_use', name: 'Edit', input: { path: 'a.ts' } })).toBe(
      '[agent] → Edit {"path":"a.ts"}\n',
    );
  });
});

describe('streamLogFields', () => {
  it('flattens a phase-tagged event into structured fields', () => {
    expect(streamLogFields('judge', { kind: 'message', text: 'hi', delta: true })).toEqual({
      phase: 'judge',
      kind: 'message',
      text: 'hi',
      delta: true,
    });
  });
});

describe('makeStreamRenderer', () => {
  it('writes formatted lines to the injected writer', () => {
    const lines: string[] = [];
    const render = makeStreamRenderer({ write: (l) => lines.push(l) });
    render('agent', { kind: 'message', text: 'go' });
    expect(lines).toEqual(['[agent] 💬 go\n']);
  });

  it('swallows a throwing writer (the live view never crashes a run)', () => {
    const render = makeStreamRenderer({
      write: () => {
        throw new Error('tty gone');
      },
    });
    expect(() => render('agent', { kind: 'done', status: 'x' })).not.toThrow();
  });
});
